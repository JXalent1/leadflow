/**
 * lib/forward.ts — lead delivery to Talan. (Session 4, Module 4.)
 *
 * Lead delivery is two surfaces: the dashboard (the `leads` row, created by the caller
 * BEFORE this runs) and an instant one-line SMS ping to TALAN_FORWARD_PHONE. This module
 * only owns the SMS ping. SMS only — no email, no Resend (dropped 2026-06-22).
 *
 * Failure policy: a failed ping NEVER loses the lead. The lead row already exists and shows
 * on the dashboard with forwarded=false, surfacing exactly which pings didn't go through.
 * So this returns a boolean and never throws — it does not gate the webhook's response.
 *
 * Sending is delegated to lib/twilio.sendOne (typed result, never logs the auth token).
 */

import { sendOne } from "@/lib/twilio";
import { markLeadForwarded } from "@/lib/db";
import type { InboundContactLite } from "@/lib/inbound";

export interface ForwardLeadArgs {
  contact: InboundContactLite;
  leadId: number;
  replyText: string;
}

/** Full name from the contact, or a sensible fallback for the ping. */
function contactName(c: InboundContactLite): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return name || "Unknown homeowner";
}

/** One-line address (situs) from whatever parts we have. */
function contactAddress(c: InboundContactLite): string {
  const tail = [c.city, c.state].filter(Boolean).join(", ");
  const zip = c.zip ? ` ${c.zip}` : "";
  const rest = tail ? `, ${tail}${zip}` : zip;
  return `${c.address}${rest}`.trim();
}

/**
 * Build the terse ping Talan receives: who, where, what they said. Reply text is
 * trimmed to keep the ping short; the full reply is on the dashboard / in `messages`.
 */
export function buildLeadPing(c: InboundContactLite, replyText: string): string {
  const reply = replyText.replace(/\s+/g, " ").trim().slice(0, 160);
  const phone = c.phone ? ` (${c.phone})` : "";
  return `New LeadFlow lead: ${contactName(c)}${phone} — ${contactAddress(c)}. Reply: "${reply}"`;
}

/**
 * Forward a lead to Talan via SMS. The lead row already exists (dashboard source of truth).
 * On a successful send, marks the lead forwarded. On any failure, logs and returns false —
 * the lead stays on the dashboard with forwarded=false. Never throws.
 */
export async function forwardLead({ contact, leadId, replyText }: ForwardLeadArgs): Promise<boolean> {
  const to = process.env.TALAN_FORWARD_PHONE?.trim();
  if (!to) {
    console.error(`[forward] TALAN_FORWARD_PHONE not set — lead ${leadId} not pinged (still on dashboard).`);
    return false;
  }

  try {
    const res = await sendOne(to, buildLeadPing(contact, replyText));
    if (res.ok) {
      await markLeadForwarded(leadId);
      return true;
    }
    // sendOne returns a typed failure rather than throwing; never logs the token.
    console.error(`[forward] ping failed lead=${leadId} code=${res.code ?? "?"} (lead still on dashboard).`);
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[forward] ping threw lead=${leadId}: ${msg} (lead still on dashboard).`);
    return false;
  }
}
