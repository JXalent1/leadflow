/**
 * lib/reply.ts — the pure compliance gate for the manual 1:1 reply path. (Session 7)
 *
 * The single, load-bearing decision for "may we text this contact back?" lives here as a
 * pure function so it can be unit-tested without a DB or the Twilio SDK. The /api/reply
 * route reads the contact + opt-out state and asks this; it never decides on its own.
 *
 * Fail closed: a missing contact, a contact with no phone, a `suppressed` flag, or a known
 * opt-out record ALL refuse. There is no path here that returns "send" when in doubt.
 */

export interface ReplyGuardContact {
  phone: string | null;
  suppressed: boolean;
}

export type ReplyRefusal = "recipient_suppressed";

/**
 * Returns a refusal reason if this contact must NOT be texted, or null if it's clear to send.
 * @param contact   the loaded contact, or null if not found
 * @param optedOut  whether a permanent opt-out record exists for the contact's phone
 */
export function replyRefusalReason(
  contact: ReplyGuardContact | null,
  optedOut: boolean
): ReplyRefusal | null {
  if (!contact || !contact.phone || !contact.phone.trim()) return "recipient_suppressed";
  if (contact.suppressed) return "recipient_suppressed";
  if (optedOut) return "recipient_suppressed";
  return null;
}
