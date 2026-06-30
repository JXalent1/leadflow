/**
 * lib/inbound.ts — inbound-SMS decision core for the Twilio webhook (Session 4, Module 4).
 *
 * This is the pure orchestration of STOP / triage / forward, with every side effect
 * injected via `InboundDeps` so it is unit-testable without a DB or Twilio. The route
 * (app/api/webhook/twilio/route.ts) owns transport concerns — signature validation,
 * body parsing, and TwiML — and wires the real DB/forward implementations into here.
 *
 * Compliance is encoded in the ORDER of operations:
 *   1. The inbound log is the idempotency gate — same MessageSid is processed once.
 *   2. STOP is checked FIRST and unconditionally — it always beats classification,
 *      even when the same text also contains interest words. STOP is never forwarded.
 *
 * Classification + opt-out detection are imported from lib/classify.ts — never re-implemented.
 */

import { isOptOut, classifyInterest, isConfiguredOptOut } from "./classify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The contact fields the lead path + forward ping need. A superset (lib/db Contact) is fine. */
export interface InboundContactLite {
  id: number;
  first_name: string | null;
  last_name: string | null;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
}

export interface InboundMessage {
  /** Sender phone, already normalized to its last 10 digits (normalizePhone). */
  fromPhone: string;
  body: string;
  /** Twilio MessageSid — the idempotency key. */
  messageSid: string;
}

export type InboundOutcome =
  | { kind: "duplicate" }
  | { kind: "opt_out"; matched: boolean; confirmation: string | null }
  | { kind: "lead"; leadId: number; forwarded: boolean }
  | { kind: "not_interested"; matched: boolean }
  | { kind: "neutral"; matched: boolean }
  /** Interested-sounding reply from a sender we have no contact for — logged only, no lead. */
  | { kind: "orphan_logged" }
  /** AI responder qualified the contact → created a hot lead + forwarded it (with a rich summary). */
  | { kind: "ai_lead"; leadId: number; forwarded: boolean }
  /** AI responder sent one conversational reply to the stored contact phone (no lead yet). */
  | { kind: "ai_reply" }
  /** AI responder declined to act (handed off, dismissed, or turn cap) — no reply, no fallback. */
  | { kind: "ai_skipped"; reason: string };

/**
 * Every persistent effect the core may cause. The route supplies real lib/db +
 * lib/forward implementations; tests supply fakes.
 */
export interface InboundDeps {
  findContactByPhone(phone: string): Promise<InboundContactLite | null>;
  /**
   * Atomically log the inbound message, using twilio_sid as a dedupe key.
   * Returns the new message id, or null if this MessageSid was already logged
   * (Twilio retry). On null, the caller skips the ONE-TIME effects (confirmation /
   * lead / forward) but still re-applies opt-out suppression idempotently, so a
   * crash between the original log and suppression can't strand a STOP.
   */
  logInboundOnce(args: {
    contactId: number | null;
    body: string;
    twilioSid: string;
  }): Promise<number | null>;
  recordOptOut(contactId: number | null, phone: string): Promise<void>;
  markSuppressed(contactId: number, reason: string): Promise<void>;
  recordOutbound(args: {
    contactId: number | null;
    body: string;
    status: string;
  }): Promise<void>;
  createLead(args: { contactId: number; replyText: string }): Promise<number>;
  /** Send the lead ping to Talan + mark the lead forwarded. Returns true on success. */
  forwardLead(args: {
    contact: InboundContactLite;
    leadId: number;
    replyText: string;
  }): Promise<boolean>;
  /**
   * OPTIONAL conversational-AI responder. The route wires this ONLY when the global kill switch
   * (AI_RESPONDER_ENABLED) is on AND the owning client has ai_enabled=true. When present, it runs
   * AFTER the opt-out/suppression gate and the dedupe gate (so it never sees an opted-out contact
   * and fires at most once per inbound), and INSTEAD of the keyword classifier. It owns its own
   * suppression-checked send + lead capture. Returns an outcome when it handled the message, or
   * null to defer to the keyword path (e.g. outside the send window). Any throw is caught here and
   * also falls back to the keyword path — an AI error never crashes the webhook or skips a lead.
   */
  runAiResponder?: (
    contact: InboundContactLite,
    body: string,
  ) => Promise<InboundOutcome | null>;
}

export interface InboundOptions {
  bizName: string;
  /**
   * Whether to emit our own CTIA opt-out confirmation. Set false when a Twilio
   * Messaging Service with Advanced Opt-Out is enabled (Twilio sends it itself —
   * sending ours too would double-confirm).
   */
  emitConfirmation: boolean;
  /**
   * The opt-out confirmation copy to send. In v2 the webhook passes the owning client's
   * `optout_confirmation`. When omitted, falls back to the default optOutConfirmation() —
   * keeps existing tests (which don't supply it) producing the same text as before.
   */
  optOutConfirmation?: string;
  /**
   * The owning client's ADDITIONAL opt-out keyword (e.g. '2'), if configured. When set, an inbound
   * whose WHOLE body exactly matches it (isConfiguredOptOut) opts out with the SAME unconditional
   * precedence as STOP. Null/undefined (Talan) = STOP-only. STOP (isOptOut) is ALWAYS honored
   * regardless of this value — the configured keyword is purely additive, never a replacement.
   */
  optOutKeyword?: string | null;
}

// ---------------------------------------------------------------------------
// Confirmation copy
// ---------------------------------------------------------------------------

/** The single CTIA-required opt-out confirmation. Kept to one SMS segment.
 * No business name (per Jordan — the campaign copy carries no brand, so neither does this).
 * Override the exact wording here if you want it different. */
export function optOutConfirmation(_bizName: string): string {
  return `You're unsubscribed and will receive no more messages. Reply HELP for help.`;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Apply an opt-out: record it + (if we know the contact) suppress them. Both calls are
 * idempotent in the real deps (recordOptOut = ON CONFLICT DO NOTHING; markSuppressed = an
 * idempotent UPDATE), so this is safe to run on a Twilio retry's recovery path too.
 */
async function applyOptOut(
  deps: InboundDeps,
  contactId: number | null,
  phone: string,
): Promise<void> {
  await deps.recordOptOut(contactId, phone);
  if (contactId !== null) await deps.markSuppressed(contactId, "opt_out");
}

/**
 * Decide and execute the handling of one inbound SMS. Returns an outcome the route
 * turns into TwiML. See the file header for the compliance-critical ordering.
 *
 * MULTI-TENANT INVARIANT (load-bearing): `deps` MUST already be bound to the client that owns the
 * inbound `To` number — the route resolves it via getClientByInboundNumber(to) and builds
 * client-scoped deps (buildDeps(client)) per request. Every effect here (contact lookup, opt-out,
 * suppression, lead, forward) routes through `deps`, so binding the client at the call site is what
 * keeps one client's STOP/lead from ever touching another client's data. Do NOT share/singleton the
 * deps across requests.
 */
export async function processInbound(
  msg: InboundMessage,
  deps: InboundDeps,
  opts: InboundOptions,
): Promise<InboundOutcome> {
  // Match the sender (read-only; safe before the dedupe gate).
  const contact = await deps.findContactByPhone(msg.fromPhone);
  const contactId = contact?.id ?? null;
  // STOP (isOptOut) is ALWAYS authoritative. The client's configured keyword (exact whole-body
  // match only) is an ADDITIVE trigger with identical precedence. Computed before the gate so the
  // duplicate-retry recovery path can re-suppress too. Pure; never throws.
  const optOut =
    isOptOut(msg.body) || isConfiguredOptOut(msg.body, opts.optOutKeyword);

  // Idempotency gate: the inbound log doubles as the dedupe key. If this MessageSid
  // was already logged (Twilio retries webhooks), the insert no-ops and we stop
  // BEFORE the one-time effects (confirmation / lead / forward) — same MessageSid
  // processed once. Every inbound is logged here, matched or not (orphan never crashes).
  const logged = await deps.logInboundOnce({
    contactId,
    body: msg.body,
    twilioSid: msg.messageSid,
  });
  if (logged === null) {
    // Twilio retry. The one-time effects were already gated out above. COMPLIANCE SAFETY
    // NET (review CRITICAL fix): neon runs each statement as a separate autocommit request,
    // so if the FIRST attempt committed the inbound log but then crashed before suppressing,
    // a deduped retry would otherwise leave a STOP un-suppressed and still textable. So we
    // re-apply the opt-out idempotently here (recordOptOut is ON CONFLICT DO NOTHING;
    // markSuppressed is a naturally idempotent UPDATE). We deliberately do NOT re-send the
    // confirmation — exactly-once means zero-or-one, never two.
    if (optOut) await applyOptOut(deps, contactId, msg.fromPhone);
    return { kind: "duplicate" };
  }

  // STOP FIRST, unconditionally. Absolute precedence over classification — a text
  // that says "STOP, but actually how much?" is an opt-out, never a lead.
  if (optOut) {
    await applyOptOut(deps, contactId, msg.fromPhone);

    let confirmation: string | null = null;
    if (opts.emitConfirmation) {
      confirmation = opts.optOutConfirmation ?? optOutConfirmation(opts.bizName);
      // Log the confirmation we hand to Twilio (sent via TwiML <Message> by the route).
      await deps.recordOutbound({
        contactId,
        body: confirmation,
        status: "opt_out_confirmation",
      });
    }
    return { kind: "opt_out", matched: contactId !== null, confirmation };
  }

  // Conversational-AI responder (ai_enabled clients only). Runs AFTER the opt-out/suppression gate
  // above and only on this FIRST delivery (the duplicate gate already returned) — so it NEVER runs
  // on an opted-out contact and fires at most once per inbound. It requires a real contact (we only
  // ever text the stored contact phone; an orphan has none). On null it defers to the keyword path
  // below (e.g. quiet hours); on ANY throw we ALSO fall back — an AI/API/DB error must never crash
  // the webhook or skip lead capture. The keyword path stays the authoritative behavior for
  // ai_disabled clients (route leaves runAiResponder unset → this block is skipped entirely).
  if (contact !== null && deps.runAiResponder) {
    try {
      const aiOutcome = await deps.runAiResponder(contact, msg.body);
      if (aiOutcome) return aiOutcome;
    } catch (err) {
      console.error(
        "[inbound] AI responder error; falling back to keyword path:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Not an opt-out → classify interest.
  const interest = classifyInterest(msg.body);

  if (interest === "interested") {
    // A lead needs a real contact (name + address) to be actionable + forwardable.
    // An interested-sounding reply from an unknown number is logged only.
    if (contact === null) return { kind: "orphan_logged" };
    const leadId = await deps.createLead({ contactId: contact.id, replyText: msg.body });
    const forwarded = await deps.forwardLead({ contact, leadId, replyText: msg.body });
    return { kind: "lead", leadId, forwarded };
  }

  // not_interested / neutral → logged only. No lead, no forward, no suppression.
  if (interest === "not_interested") return { kind: "not_interested", matched: contactId !== null };
  return { kind: "neutral", matched: contactId !== null };
}
