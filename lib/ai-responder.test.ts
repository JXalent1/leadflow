/**
 * ai-responder.test.ts — unit tests for the pure conversational-AI core (lib/ai-responder).
 *
 * Runner: node:test via `tsx --test lib/*.test.ts`. NO Anthropic spend, NO real sends — the Claude
 * call (classify), the guarded send, lead create/forward, and state writes are all fakes recorded
 * in `calls`. Covers the compliance- and correctness-critical behaviors: the turn cap stops the
 * loop, quiet hours defer (no auto-send), a qualified path makes EXACTLY one hot lead + one forward
 * carrying the summary, a suppressed contact gets NO reply, and the 3-strike rule dismisses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAiResponder,
  buildSystemPrompt,
  type AiConfig,
  type AiResponderDeps,
  type AiResponderInput,
  type AiResponderOptions,
  type AiSignal,
} from "./ai-responder";

const CONFIG: AiConfig = {
  bizName: "Talan Window Cleaning",
  services: "window cleaning",
  offer: null,
  persona: "Lance, friendly and brief",
  location: "Tallahassee, FL",
};

interface Calls {
  classify: number;
  sent: string[];
  createHotLead: number;
  forward: Array<{ leadId: number; summary: string }>;
  handedOff: number;
  dismissed: number;
  strikes: number;
}

function makeDeps(opts: {
  signal?: Partial<AiSignal>;
  classifyThrows?: boolean;
  /** Simulate a suppressed/opted-out recipient — the guarded send refuses (records nothing). */
  sendRefused?: boolean;
}): { deps: AiResponderDeps; calls: Calls } {
  const calls: Calls = {
    classify: 0,
    sent: [],
    createHotLead: 0,
    forward: [],
    handedOff: 0,
    dismissed: 0,
    strikes: 0,
  };
  const signal: AiSignal = {
    reply: "Happy to help. What kind of windows are we talking about.",
    service: "",
    wants_call: false,
    qualified: false,
    serious: true,
    summary: "",
    ...opts.signal,
  };
  const deps: AiResponderDeps = {
    classify: async () => {
      calls.classify += 1;
      if (opts.classifyThrows) throw new Error("api boom");
      return signal;
    },
    sendReply: async (text) => {
      if (opts.sendRefused) return false; // gate refused — no text goes out
      calls.sent.push(text);
      return true;
    },
    createHotLead: async () => {
      calls.createHotLead += 1;
      return 42;
    },
    forwardHotLead: async (leadId, summary) => {
      calls.forward.push({ leadId, summary });
      return true;
    },
    markHandedOff: async () => {
      calls.handedOff += 1;
    },
    markDismissed: async () => {
      calls.dismissed += 1;
    },
    bumpStrike: async () => {
      calls.strikes += 1;
    },
  };
  return { deps, calls };
}

function makeInput(over: Partial<AiResponderInput> = {}): AiResponderInput {
  return {
    config: CONFIG,
    turns: [{ role: "user", text: "hey what do you guys do" }],
    aiStatus: null,
    aiStrikes: 0,
    aiReplyCount: 0,
    ...over,
  };
}

const OPTS: AiResponderOptions = { withinWindow: true, maxTurns: 5, maxStrikes: 3 };

// ===========================================================================
// Terminal states — never re-engage
// ===========================================================================

test("handed_off contact: skipped, no classify, no send (a human owns the thread)", async () => {
  const { deps, calls } = makeDeps({});
  const out = await runAiResponder(makeInput({ aiStatus: "handed_off" }), deps, OPTS);
  assert.deepEqual(out, { kind: "ai_skipped", reason: "handed_off" });
  assert.equal(calls.classify, 0);
  assert.equal(calls.sent.length, 0);
});

test("dismissed contact: skipped, no classify, no send", async () => {
  const { deps, calls } = makeDeps({});
  const out = await runAiResponder(makeInput({ aiStatus: "dismissed" }), deps, OPTS);
  assert.deepEqual(out, { kind: "ai_skipped", reason: "dismissed" });
  assert.equal(calls.classify, 0);
});

// ===========================================================================
// Turn cap + quiet hours
// ===========================================================================

test("turn cap stops the loop: at maxTurns, skipped before any model call or send", async () => {
  const { deps, calls } = makeDeps({});
  const out = await runAiResponder(makeInput({ aiReplyCount: 5 }), deps, OPTS);
  assert.deepEqual(out, { kind: "ai_skipped", reason: "turn_cap" });
  assert.equal(calls.classify, 0);
  assert.equal(calls.sent.length, 0);
});

test("outside the send window: returns null (defer to keyword path) — no auto-send, no model call", async () => {
  const { deps, calls } = makeDeps({});
  const out = await runAiResponder(makeInput(), deps, { ...OPTS, withinWindow: false });
  assert.equal(out, null);
  assert.equal(calls.classify, 0);
  assert.equal(calls.sent.length, 0);
});

// ===========================================================================
// Engaged + qualified
// ===========================================================================

test("engaged but not qualified: sends exactly one reply, no lead", async () => {
  const { deps, calls } = makeDeps({ signal: { reply: "What kind of windows.", qualified: false } });
  const out = await runAiResponder(makeInput(), deps, OPTS);
  assert.deepEqual(out, { kind: "ai_reply" });
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.createHotLead, 0);
  assert.equal(calls.forward.length, 0);
});

test("qualified path: exactly one hot lead + one forward carrying the summary, one reply, handed off", async () => {
  const { deps, calls } = makeDeps({
    signal: {
      reply: "Perfect. Someone from the team will reach out shortly to set it up.",
      service: "window cleaning",
      wants_call: true,
      qualified: true,
      serious: true,
      summary: "Wants window cleaning, timing late August, asked about price.",
    },
  });
  const out = await runAiResponder(makeInput(), deps, OPTS);
  assert.equal(out?.kind, "ai_lead");
  if (out && out.kind === "ai_lead") {
    assert.equal(out.leadId, 42);
    assert.equal(out.forwarded, true);
  }
  assert.equal(calls.createHotLead, 1, "exactly one hot lead");
  assert.equal(calls.forward.length, 1, "exactly one forward");
  assert.equal(calls.forward[0].summary, "Wants window cleaning, timing late August, asked about price.");
  assert.equal(calls.handedOff, 1);
  assert.equal(calls.sent.length, 1, "one expectation-setting reply");
});

test("qualified but service missing: NOT a lead — treated as still-engaged reply", async () => {
  const { deps, calls } = makeDeps({
    signal: { reply: "What service did you need.", service: "", wants_call: true, qualified: true },
  });
  const out = await runAiResponder(makeInput(), deps, OPTS);
  assert.equal(out?.kind, "ai_reply");
  assert.equal(calls.createHotLead, 0);
});

// ===========================================================================
// Suppression gate (no reply when the guarded send refuses)
// ===========================================================================

test("suppressed/opted-out recipient: the guarded send refuses, no text goes out", async () => {
  const { deps, calls } = makeDeps({ signal: { reply: "What windows." }, sendRefused: true });
  const out = await runAiResponder(makeInput(), deps, OPTS);
  assert.deepEqual(out, { kind: "ai_reply" });
  assert.equal(calls.sent.length, 0, "no SMS was sent to a suppressed contact");
});

// ===========================================================================
// 3-strike rule (non-serious)
// ===========================================================================

test("non-serious reply: strike, no reply, not yet dismissed", async () => {
  const { deps, calls } = makeDeps({ signal: { serious: false, reply: "lol" } });
  const out = await runAiResponder(makeInput({ aiStrikes: 0 }), deps, OPTS);
  assert.deepEqual(out, { kind: "ai_skipped", reason: "not_serious" });
  assert.equal(calls.strikes, 1);
  assert.equal(calls.dismissed, 0);
  assert.equal(calls.sent.length, 0);
});

test("non-serious 3rd strike: dismissed, stop responding", async () => {
  const { deps, calls } = makeDeps({ signal: { serious: false } });
  const out = await runAiResponder(makeInput({ aiStrikes: 2 }), deps, OPTS);
  assert.deepEqual(out, { kind: "ai_skipped", reason: "dismissed" });
  assert.equal(calls.strikes, 1);
  assert.equal(calls.dismissed, 1);
  assert.equal(calls.sent.length, 0);
});

// ===========================================================================
// classify error bubbles up (caller falls back)
// ===========================================================================

test("classify throwing propagates (lib/inbound catches it to fall back) — no partial send", async () => {
  const { deps, calls } = makeDeps({ classifyThrows: true });
  await assert.rejects(() => runAiResponder(makeInput(), deps, OPTS), /api boom/);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.createHotLead, 0);
});

// ===========================================================================
// System prompt
// ===========================================================================

test("system prompt embeds the persona/config and the human-feel rules", () => {
  const p = buildSystemPrompt(CONFIG);
  assert.match(p, /Lance, friendly and brief/);
  assert.match(p, /Talan Window Cleaning/);
  assert.match(p, /window cleaning/);
  assert.match(p, /Tallahassee, FL/);
  assert.match(p, /NEVER say or imply you are an AI/);
  assert.match(p, /NEVER quote, estimate, or discuss a price/);
  assert.match(p, /different number/);
});

test("system prompt tolerates an all-null config (no persona/services/offer/location)", () => {
  const p = buildSystemPrompt({ bizName: "Acme", services: null, offer: null, persona: null, location: null });
  assert.match(p, /a team member/);
  assert.match(p, /Acme/);
});
