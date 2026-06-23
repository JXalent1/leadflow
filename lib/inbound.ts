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

import { isOptOut, classifyInterest } from "./classify";

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
  | { kind: "orphan_logged" };

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
}

export interface InboundOptions {
  bizName: string;
  /**
   * Whether to emit our own CTIA opt-out confirmation. Set false when a Twilio
   * Messaging Service with Advanced Opt-Out is enabled (Twilio sends it itself —
   * sending ours too would double-confirm).
   */
  emitConfirmation: boolean;
}

// ---------------------------------------------------------------------------
// Confirmation copy
// ---------------------------------------------------------------------------

/** The single CTIA-required opt-out confirmation. Kept to one SMS segment. */
export function optOutConfirmation(bizName: string): string {
  return `You're unsubscribed from ${bizName} and will receive no more messages. Reply HELP for help.`;
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
 */
export async function processInbound(
  msg: InboundMessage,
  deps: InboundDeps,
  opts: InboundOptions,
): Promise<InboundOutcome> {
  // Match the sender (read-only; safe before the dedupe gate).
  const contact = await deps.findContactByPhone(msg.fromPhone);
  const contactId = contact?.id ?? null;
  const optOut = isOptOut(msg.body); // pure; compute before the gate so recovery can use it

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
      confirmation = optOutConfirmation(opts.bizName);
      // Log the confirmation we hand to Twilio (sent via TwiML <Message> by the route).
      await deps.recordOutbound({
        contactId,
        body: confirmation,
        status: "opt_out_confirmation",
      });
    }
    return { kind: "opt_out", matched: contactId !== null, confirmation };
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
