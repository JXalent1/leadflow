/**
 * lib/ai-db.ts — DB helpers for the conversational AI responder. (Build: ai-responder)
 *
 * All reads/writes are scoped by client_id (multi-tenant invariant) and touch only the contact's
 * AI state + the message log. Kept out of lib/db.ts (which is near its 500-line cap) and out of the
 * pure orchestrator (lib/ai-responder.ts) so that module stays DB-free and unit-testable.
 */

import "server-only";
import { sql } from "@/lib/db";
import type { AiTurn } from "@/lib/ai-responder";

/** Per-contact AI conversation state. status: null/'active' | 'handed_off' | 'dismissed'. */
export interface AiContactState {
  status: string | null;
  strikes: number;
}

/** Load a contact's AI state within a client. Missing row → active/0 (fail open to "may engage"). */
export async function getAiState(clientId: number, contactId: number): Promise<AiContactState> {
  const rows = await sql`
    SELECT ai_status, ai_strikes FROM contacts WHERE id = ${contactId} AND client_id = ${clientId}
  `;
  if (!rows.length) return { status: null, strikes: 0 };
  const r = rows[0] as { ai_status: string | null; ai_strikes: number | string | null };
  return { status: r.ai_status ?? null, strikes: Number(r.ai_strikes ?? 0) };
}

/** Set a contact's AI status (e.g. 'handed_off' | 'dismissed'). Client-scoped. */
export async function setAiStatus(clientId: number, contactId: number, status: string): Promise<void> {
  await sql`UPDATE contacts SET ai_status = ${status} WHERE id = ${contactId} AND client_id = ${clientId}`;
}

/** Increment a contact's non-serious strike count. Client-scoped. */
export async function bumpAiStrike(clientId: number, contactId: number): Promise<void> {
  await sql`UPDATE contacts SET ai_strikes = ai_strikes + 1 WHERE id = ${contactId} AND client_id = ${clientId}`;
}

/**
 * Load the full message history for a contact as AiTurns (oldest→newest). inbound → "user",
 * outbound → "assistant". The current inbound has already been logged by logInboundOnce before the
 * AI runs, so it appears here as the last "user" turn — the orchestrator does NOT re-append it.
 */
export async function getAiHistory(clientId: number, contactId: number): Promise<AiTurn[]> {
  const rows = await sql`
    SELECT direction, body FROM messages
    WHERE client_id = ${clientId} AND contact_id = ${contactId}
    ORDER BY created_at ASC, id ASC
  `;
  return (rows as Array<{ direction: string; body: string }>).map((r) => ({
    role: r.direction === "inbound" ? "user" : "assistant",
    text: r.body,
  }));
}

/**
 * Count the AI replies already sent to a contact (the per-conversation turn-cap counter). AI replies
 * are logged with status='ai_reply' by the wired sendReply, so this is an exact, schema-light count.
 */
export async function countAiReplies(clientId: number, contactId: number): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM messages
    WHERE client_id = ${clientId} AND contact_id = ${contactId} AND status = 'ai_reply'
  `;
  return Number((rows[0] as { n: number }).n);
}
