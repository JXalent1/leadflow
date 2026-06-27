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

import { sendOne, type SendResult } from "@/lib/twilio";
import { markLeadForwarded } from "@/lib/db";
import { DEFAULT_CLIENT_ID } from "@/lib/constants";
import { parseForwardPhones } from "@/lib/forward-phones";
import type { InboundContactLite } from "@/lib/inbound";

export interface ForwardLeadArgs {
  contact: InboundContactLite;
  leadId: number;
  replyText: string;
}

/** Per-client forward config (from the client record): where to ping + which sender to use. */
export interface ForwardConfig {
  clientId: number;
  forwardPhone: string | null;
  sender: { messagingServiceSid: string } | { from: string };
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

/** Last-4 digits of a recipient for log lines — never log the full number. */
function last4(to: string): string {
  const d = to.replace(/[^0-9]/g, "");
  return d ? `…${d.slice(-4)}` : "?";
}

/**
 * Side effects forwardLead needs. Injectable so a fixture can supply a MOCKED sendOne (no real
 * Twilio call) + observe markForwarded; defaults to the real implementations for production.
 */
export interface ForwardDeps {
  send: (
    to: string,
    body: string,
    sender?: { messagingServiceSid: string } | { from: string }
  ) => Promise<SendResult>;
  markForwarded: (clientId: number, leadId: number) => Promise<void>;
}

const realDeps: ForwardDeps = { send: sendOne, markForwarded: markLeadForwarded };

/**
 * Forward a lead to the client's recipient(s) via SMS. The lead row already exists (dashboard
 * source of truth). forward_phone may hold ONE number (today's behavior, unchanged) or SEVERAL
 * (comma/semicolon/whitespace-separated) — each recipient gets the SAME ping. Marks the lead
 * forwarded if AT LEAST ONE ping succeeds; logs each per-recipient failure with its code. On total
 * failure returns false and the lead stays on the dashboard with forwarded=false. Never throws.
 */
export async function forwardLead(
  { contact, leadId, replyText }: ForwardLeadArgs,
  cfg: ForwardConfig,
  deps: ForwardDeps = realDeps
): Promise<boolean> {
  // Recipients come from the client's forward_phone (parsed to a deduped list). For the DEFAULT
  // client (Talan), fall back to the legacy TALAN_FORWARD_PHONE env when the record is unset, so v1
  // behavior is preserved exactly (the real number is a secret and can't live in committed SQL).
  // That env may itself be a list. The fallback is scoped to client 1 ONLY so Talan's number can
  // never leak to another client.
  let recipients = parseForwardPhones(cfg.forwardPhone);
  if (recipients.length === 0 && cfg.clientId === DEFAULT_CLIENT_ID) {
    recipients = parseForwardPhones(process.env.TALAN_FORWARD_PHONE);
  }
  if (recipients.length === 0) {
    console.error(`[forward] client ${cfg.clientId} has no forward_phone — lead ${leadId} not pinged (still on dashboard).`);
    return false;
  }

  const ping = buildLeadPing(contact, replyText);
  let anySuccess = false;
  for (const to of recipients) {
    try {
      const res = await deps.send(to, ping, cfg.sender);
      if (res.ok) {
        anySuccess = true;
      } else {
        // sendOne returns a typed failure rather than throwing; never logs the token.
        console.error(`[forward] ping failed lead=${leadId} to=${last4(to)} code=${res.code ?? "?"} (lead still on dashboard).`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[forward] ping threw lead=${leadId} to=${last4(to)}: ${msg} (lead still on dashboard).`);
    }
  }

  // Mark forwarded once if any recipient got it (no double-mark, no double-create — the lead row
  // already exists and markForwarded is idempotent).
  if (anySuccess) {
    await deps.markForwarded(cfg.clientId, leadId);
    return true;
  }
  return false;
}
