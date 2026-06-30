/**
 * inbound.test.ts — unit tests for lib/inbound (Session 4 webhook decision core).
 *
 * Runner: Node built-in test module via `tsx --test lib/*.test.ts`.
 * No DB / Twilio — every side effect is a fake recorded in `calls`. These tests cover the
 * three compliance-critical behaviors: STOP precedence, idempotency (duplicate MessageSid),
 * and classification routing (interested → lead/forward; neutral/not-interested → log only).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processInbound,
  optOutConfirmation,
  type InboundContactLite,
  type InboundDeps,
  type InboundOptions,
  type InboundOutcome,
} from "./inbound";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const CONTACT: InboundContactLite = {
  id: 7,
  first_name: "Jane",
  last_name: "Doe",
  address: "123 Oak St",
  city: "Tallahassee",
  state: "FL",
  zip: "32301",
  phone: "8505551234",
};

interface Calls {
  recordOptOut: Array<{ contactId: number | null; phone: string }>;
  markSuppressed: Array<{ contactId: number; reason: string }>;
  recordOutbound: Array<{ contactId: number | null; body: string; status: string }>;
  createLead: Array<{ contactId: number; replyText: string }>;
  forwardLead: Array<{ leadId: number; replyText: string }>;
  logged: Array<{ contactId: number | null; twilioSid: string }>;
  aiResponder: Array<{ body: string }>;
}

function makeDeps(opts: {
  contact?: InboundContactLite | null;
  duplicate?: boolean;
  forwardOk?: boolean;
  /** When set, wires InboundDeps.runAiResponder so we can assert when the AI path fires. */
  ai?: {
    /** What the responder returns; if it throws, set `throws`. */
    outcome?: InboundOutcome | null;
    throws?: boolean;
  };
}): { deps: InboundDeps; calls: Calls } {
  const calls: Calls = {
    recordOptOut: [],
    markSuppressed: [],
    recordOutbound: [],
    createLead: [],
    forwardLead: [],
    logged: [],
    aiResponder: [],
  };
  const deps: InboundDeps = {
    findContactByPhone: async () => opts.contact ?? null,
    logInboundOnce: async (a) => {
      if (opts.duplicate) return null; // simulate the SID already being logged
      calls.logged.push({ contactId: a.contactId, twilioSid: a.twilioSid });
      return calls.logged.length;
    },
    recordOptOut: async (contactId, phone) => {
      calls.recordOptOut.push({ contactId, phone });
    },
    markSuppressed: async (contactId, reason) => {
      calls.markSuppressed.push({ contactId, reason });
    },
    recordOutbound: async (a) => {
      calls.recordOutbound.push(a);
    },
    createLead: async (a) => {
      calls.createLead.push(a);
      return 99;
    },
    forwardLead: async (a) => {
      calls.forwardLead.push({ leadId: a.leadId, replyText: a.replyText });
      return opts.forwardOk ?? true;
    },
  };
  if (opts.ai) {
    deps.runAiResponder = async (_contact, body) => {
      calls.aiResponder.push({ body });
      if (opts.ai!.throws) throw new Error("ai boom");
      return opts.ai!.outcome ?? null;
    };
  }
  return { deps, calls };
}

const OPTS: InboundOptions = { bizName: "Talan Window Cleaning", emitConfirmation: true };

function msg(body: string, sid = "SM1", fromPhone = "8505551234") {
  return { fromPhone, body, messageSid: sid };
}

// ===========================================================================
// STOP precedence
// ===========================================================================

test("STOP from a known contact: opt-out, suppress, confirm — never a lead", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("STOP"), deps, OPTS);

  assert.equal(out.kind, "opt_out");
  assert.equal(calls.recordOptOut.length, 1);
  assert.deepEqual(calls.recordOptOut[0], { contactId: 7, phone: "8505551234" });
  assert.deepEqual(calls.markSuppressed[0], { contactId: 7, reason: "opt_out" });
  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.forwardLead.length, 0);
  if (out.kind === "opt_out") {
    assert.equal(out.confirmation, optOutConfirmation("Talan Window Cleaning"));
  }
});

test("STOP wins even when the body also contains interest words", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(
    msg("STOP — actually yes I'm interested, how much for a quote?"),
    deps,
    OPTS,
  );

  assert.equal(out.kind, "opt_out");
  assert.equal(calls.markSuppressed.length, 1);
  assert.equal(calls.createLead.length, 0, "an opt-out must never be forwarded as a lead");
  assert.equal(calls.forwardLead.length, 0);
});

test("STOP confirmation is logged exactly once (outbound)", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  await processInbound(msg("unsubscribe"), deps, OPTS);
  assert.equal(calls.recordOutbound.length, 1);
  assert.equal(calls.recordOutbound[0].status, "opt_out_confirmation");
});

test("emitConfirmation=false: opt-out still happens, but no confirmation is emitted/logged", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("STOP"), deps, {
    bizName: "Talan Window Cleaning",
    emitConfirmation: false,
  });
  assert.equal(out.kind, "opt_out");
  assert.equal(calls.markSuppressed.length, 1, "suppression still applies");
  assert.equal(calls.recordOutbound.length, 0, "Twilio Advanced Opt-Out would send it instead");
  if (out.kind === "opt_out") assert.equal(out.confirmation, null);
});

test("orphan STOP (unknown sender): opt-out recorded by phone, no suppress (no contact), no crash", async () => {
  const { deps, calls } = makeDeps({ contact: null });
  const out = await processInbound(msg("STOP"), deps, OPTS);
  assert.equal(out.kind, "opt_out");
  assert.deepEqual(calls.recordOptOut[0], { contactId: null, phone: "8505551234" });
  assert.equal(calls.markSuppressed.length, 0);
});

// ===========================================================================
// Configured per-client opt-out keyword (additive; exact whole-body match)
// ===========================================================================

const OPTS_KW2: InboundOptions = {
  bizName: "Jeremy Powerwashing",
  emitConfirmation: true,
  optOutKeyword: "2",
};

test("configured keyword '2': bare '2' opts out + suppresses (same precedence as STOP)", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("2"), deps, OPTS_KW2);
  assert.equal(out.kind, "opt_out");
  assert.equal(calls.recordOptOut.length, 1);
  assert.deepEqual(calls.markSuppressed[0], { contactId: 7, reason: "opt_out" });
  assert.equal(calls.createLead.length, 0);
});

test("configured keyword '2': STOP still opts out unconditionally (keyword is additive)", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("STOP"), deps, OPTS_KW2);
  assert.equal(out.kind, "opt_out");
  assert.equal(calls.markSuppressed.length, 1);
});

test("configured keyword '2': '2 services please' does NOT opt out (exact-match only)", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("2 services please"), deps, OPTS_KW2);
  assert.notEqual(out.kind, "opt_out");
  assert.equal(calls.recordOptOut.length, 0);
  assert.equal(calls.markSuppressed.length, 0);
});

test("configured keyword '2': 'call me at 2pm' does NOT opt out", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("call me at 2pm"), deps, OPTS_KW2);
  assert.notEqual(out.kind, "opt_out");
  assert.equal(calls.markSuppressed.length, 0);
});

test("no configured keyword (Talan): a bare '2' does NOT opt out", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("2"), deps, OPTS); // OPTS has no optOutKeyword
  assert.notEqual(out.kind, "opt_out");
  assert.equal(calls.recordOptOut.length, 0);
  assert.equal(calls.markSuppressed.length, 0);
});

test("configured keyword '2': a duplicate '2' (Twilio retry) re-suppresses idempotently, no 2nd confirmation", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, duplicate: true });
  const out = await processInbound(msg("2"), deps, OPTS_KW2);
  assert.equal(out.kind, "duplicate");
  assert.equal(calls.recordOptOut.length, 1, "opt-out re-applied on retry");
  assert.equal(calls.markSuppressed.length, 1, "suppression re-applied — keyword opt-out never stranded");
  assert.equal(calls.recordOutbound.length, 0, "no second confirmation on a retry");
});

// ===========================================================================
// Idempotency (duplicate MessageSid)
// ===========================================================================

test("duplicate STOP (Twilio retry): suppression re-applied idempotently, NO 2nd confirmation, no lead", async () => {
  // Review CRITICAL fix: if the first attempt logged the inbound then crashed before
  // suppressing, a deduped retry must still suppress (compliance) — but must NOT re-send
  // the confirmation or create a lead (exactly-once → zero-or-one, never two).
  const { deps, calls } = makeDeps({ contact: CONTACT, duplicate: true });
  const out = await processInbound(msg("STOP"), deps, OPTS);

  assert.equal(out.kind, "duplicate");
  assert.equal(calls.recordOptOut.length, 1, "opt-out re-applied (idempotent in db)");
  assert.equal(calls.markSuppressed.length, 1, "suppression re-applied — STOP never stranded");
  assert.equal(calls.recordOutbound.length, 0, "no second confirmation on a retry");
  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.forwardLead.length, 0);
});

test("duplicate STOP from an orphan (no contact): opt-out re-recorded by phone, no markSuppressed", async () => {
  const { deps, calls } = makeDeps({ contact: null, duplicate: true });
  const out = await processInbound(msg("STOP"), deps, OPTS);
  assert.equal(out.kind, "duplicate");
  assert.equal(calls.recordOptOut.length, 1);
  assert.deepEqual(calls.recordOptOut[0], { contactId: null, phone: "8505551234" });
  assert.equal(calls.markSuppressed.length, 0);
});

test("duplicate STOP with emitConfirmation=false: suppression still re-applied, still no confirmation", async () => {
  // Recovery (applyOptOut) is independent of emitConfirmation: a retry must re-suppress
  // whether or not we'd have sent a confirmation, and never sends one on the retry.
  const { deps, calls } = makeDeps({ contact: CONTACT, duplicate: true });
  const out = await processInbound(msg("STOP"), deps, {
    bizName: "Talan Window Cleaning",
    emitConfirmation: false,
  });
  assert.equal(out.kind, "duplicate");
  assert.equal(calls.recordOptOut.length, 1);
  assert.equal(calls.markSuppressed.length, 1);
  assert.equal(calls.recordOutbound.length, 0);
});

test("duplicate MessageSid on an interested reply: no opt-out, no lead, no forward", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, duplicate: true });
  const out = await processInbound(msg("yes please send a quote"), deps, OPTS);
  assert.equal(out.kind, "duplicate");
  assert.equal(calls.recordOptOut.length, 0, "a non-STOP retry never suppresses");
  assert.equal(calls.markSuppressed.length, 0);
  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.forwardLead.length, 0);
});

test("first delivery logs inbound with the SID (the dedupe key)", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  await processInbound(msg("hello", "SMabc"), deps, OPTS);
  assert.equal(calls.logged.length, 1);
  assert.equal(calls.logged[0].twilioSid, "SMabc");
});

// ===========================================================================
// Classification routing
// ===========================================================================

test("interested reply from a known contact: lead created + forwarded", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("Yes, how much for a quote?"), deps, OPTS);

  assert.equal(out.kind, "lead");
  assert.equal(calls.createLead.length, 1);
  assert.deepEqual(calls.createLead[0], { contactId: 7, replyText: "Yes, how much for a quote?" });
  assert.equal(calls.forwardLead.length, 1);
  if (out.kind === "lead") {
    assert.equal(out.leadId, 99);
    assert.equal(out.forwarded, true);
  }
  // An interested reply is not an opt-out.
  assert.equal(calls.recordOptOut.length, 0);
  assert.equal(calls.markSuppressed.length, 0);
});

test("interested reply but failed ping: lead still created, forwarded=false", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, forwardOk: false });
  const out = await processInbound(msg("interested!"), deps, OPTS);
  assert.equal(out.kind, "lead");
  assert.equal(calls.createLead.length, 1, "the lead survives a failed ping (still on dashboard)");
  if (out.kind === "lead") assert.equal(out.forwarded, false);
});

test("not-interested reply: logged only — no lead, forward, or suppression", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("No thanks, not interested"), deps, OPTS);
  assert.equal(out.kind, "not_interested");
  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.forwardLead.length, 0);
  assert.equal(calls.markSuppressed.length, 0);
});

test("neutral reply: logged only — no lead, forward, or suppression", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT });
  const out = await processInbound(msg("who is this?"), deps, OPTS);
  assert.equal(out.kind, "neutral");
  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.forwardLead.length, 0);
  assert.equal(calls.markSuppressed.length, 0);
});

test("orphan interested reply (unknown sender): logged only, no lead", async () => {
  const { deps, calls } = makeDeps({ contact: null });
  const out = await processInbound(msg("yes interested"), deps, OPTS);
  assert.equal(out.kind, "orphan_logged");
  assert.equal(calls.createLead.length, 0);
  assert.equal(calls.forwardLead.length, 0);
});

// ===========================================================================
// AI responder wiring (the deterministic gate ALWAYS precedes the AI)
// ===========================================================================

test("AI is NEVER invoked on a STOP — opt-out wins, suppression applies, AI never sees it", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, ai: { outcome: { kind: "ai_reply" } } });
  const out = await processInbound(msg("STOP"), deps, OPTS);
  assert.equal(out.kind, "opt_out");
  assert.equal(calls.aiResponder.length, 0, "the AI must never run on an opted-out contact");
  assert.equal(calls.markSuppressed.length, 1, "STOP still suppresses");
});

test("AI is NEVER invoked on the configured keyword '2' — opt-out wins, AI never sees it", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, ai: { outcome: { kind: "ai_reply" } } });
  const out = await processInbound(msg("2"), deps, OPTS_KW2);
  assert.equal(out.kind, "opt_out");
  assert.equal(calls.aiResponder.length, 0);
  assert.equal(calls.markSuppressed.length, 1);
});

test("AI is NOT invoked on a duplicate (Twilio retry) — it fires at most once per inbound", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, duplicate: true, ai: { outcome: { kind: "ai_reply" } } });
  const out = await processInbound(msg("yes please"), deps, OPTS);
  assert.equal(out.kind, "duplicate");
  assert.equal(calls.aiResponder.length, 0, "no AI on a deduped retry — no double-send");
});

test("AI is NOT invoked for an orphan (no stored contact) — we only ever text a stored phone", async () => {
  const { deps, calls } = makeDeps({ contact: null, ai: { outcome: { kind: "ai_reply" } } });
  const out = await processInbound(msg("yes interested"), deps, OPTS);
  assert.equal(out.kind, "orphan_logged");
  assert.equal(calls.aiResponder.length, 0);
});

test("AI handles the reply → its outcome is returned and the keyword path is skipped", async () => {
  const { deps, calls } = makeDeps({
    contact: CONTACT,
    ai: { outcome: { kind: "ai_lead", leadId: 5, forwarded: true } },
  });
  const out = await processInbound(msg("yes, how much for a quote?"), deps, OPTS);
  assert.equal(out.kind, "ai_lead");
  assert.equal(calls.aiResponder.length, 1);
  assert.equal(calls.createLead.length, 0, "the keyword lead path is skipped when the AI handled it");
});

test("AI returns null (e.g. quiet hours) → falls back to the keyword path", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, ai: { outcome: null } });
  const out = await processInbound(msg("yes, how much for a quote?"), deps, OPTS);
  assert.equal(out.kind, "lead", "keyword classifier captures the lead when the AI defers");
  assert.equal(calls.aiResponder.length, 1);
  assert.equal(calls.createLead.length, 1);
});

test("AI error → falls back to keyword path, inbound logged once, no crash, no double-send", async () => {
  const { deps, calls } = makeDeps({ contact: CONTACT, ai: { throws: true } });
  const out = await processInbound(msg("yes, how much for a quote?"), deps, OPTS);
  assert.equal(out.kind, "lead", "an AI error falls back to the keyword classifier");
  assert.equal(calls.aiResponder.length, 1, "AI was attempted exactly once");
  assert.equal(calls.logged.length, 1, "inbound logged exactly once");
  assert.equal(calls.createLead.length, 1, "the lead is still captured");
});

test("AI 'ai_skipped' (handed off / dismissed / cap) → no keyword fallback, no lead", async () => {
  const { deps, calls } = makeDeps({
    contact: CONTACT,
    ai: { outcome: { kind: "ai_skipped", reason: "handed_off" } },
  });
  const out = await processInbound(msg("ok thanks"), deps, OPTS);
  assert.equal(out.kind, "ai_skipped");
  assert.equal(calls.createLead.length, 0, "a handed-off thread is not re-captured by the keyword path");
});
