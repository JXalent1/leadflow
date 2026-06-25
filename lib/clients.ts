/**
 * lib/clients.ts — the tenant record + per-client send config. (v2 Module V1)
 *
 * Multi-tenant foundation: every data row carries a client_id and every query is scoped by it.
 * This module loads a client and derives the send config (number, copy, window, rate, forward
 * contact, opt-out confirmation) that used to live in env. Account-level secrets (Twilio
 * account SID/token, Tracerfy key, DATABASE_URL, ADMIN_PASSWORD) stay in env — only the
 * PER-CLIENT values moved here.
 *
 * No query in the rest of the app may read/write across clients; callers pass a clientId (or a
 * loaded Client) into every DB helper. Operator surfaces default to DEFAULT_CLIENT_ID (Talan is
 * the only client today); the inbound webhook resolves the client by the Twilio number it hit.
 */

import { sql } from "@/lib/db";
import { clampSendRate } from "@/lib/pipeline";

// Re-exported from a db-free module so pure modules (lib/access.ts) can import the default without
// pulling in the Neon driver. Operator routes/pages default here when no client is selected.
export { DEFAULT_CLIENT_ID } from "@/lib/constants";

export interface Client {
  id: number;
  name: string;
  status: string; // 'active' | 'paused'
  plan_amount_cents: number;
  lead_guarantee: number;
  /** Per-period lead target driving the V6 auto-pause; null = fall back to lead_guarantee. */
  lead_target: number | null;
  /** 'week' | 'month' — the period the lead target is measured over. */
  target_period: string;
  billing_day: number | null;
  from_number: string | null;
  messaging_service_sid: string | null;
  biz_name: string | null;
  message_template: string | null;
  forward_phone: string | null;
  send_window_start_hour: number;
  send_window_end_hour: number;
  send_timezone: string;
  send_rate_per_hour: number;
  optout_confirmation: string | null;
  branding: unknown;
  created_at: string;
}

/** neon returns numerics as strings sometimes; coerce the int columns we read. */
function toClient(r: Record<string, unknown>): Client {
  return {
    id: Number(r.id),
    name: String(r.name),
    status: String(r.status),
    plan_amount_cents: Number(r.plan_amount_cents),
    lead_guarantee: Number(r.lead_guarantee),
    lead_target: r.lead_target === null || r.lead_target === undefined ? null : Number(r.lead_target),
    target_period: r.target_period ? String(r.target_period) : "month",
    billing_day: r.billing_day === null || r.billing_day === undefined ? null : Number(r.billing_day),
    from_number: (r.from_number as string | null) ?? null,
    messaging_service_sid: (r.messaging_service_sid as string | null) ?? null,
    biz_name: (r.biz_name as string | null) ?? null,
    message_template: (r.message_template as string | null) ?? null,
    forward_phone: (r.forward_phone as string | null) ?? null,
    send_window_start_hour: Number(r.send_window_start_hour),
    send_window_end_hour: Number(r.send_window_end_hour),
    send_timezone: String(r.send_timezone),
    send_rate_per_hour: Number(r.send_rate_per_hour),
    optout_confirmation: (r.optout_confirmation as string | null) ?? null,
    branding: r.branding ?? {},
    created_at: String(r.created_at),
  };
}

/**
 * Update a client's live send rate (sends/hour). (v2 Module V3 — live send-rate control.)
 * Clamped to [1, MAX_SEND_RATE_PER_HOUR] (20000) via the shared pure clampSendRate; the value is
 * persisted so the send loop, which reads client.send_rate_per_hour fresh on every batch, picks the
 * change up on the next batch with NO redeploy. Returns the clamped value actually stored. Scoped to
 * the one client_id. The clamp only sets the ceiling — no-double-send, the send window, and
 * opt-out/suppression are independent of the rate and unchanged.
 */
export async function setClientSendRate(clientId: number, rate: number): Promise<number> {
  const clamped = clampSendRate(rate);
  await sql`UPDATE clients SET send_rate_per_hour = ${clamped} WHERE id = ${clientId}`;
  return clamped;
}

/**
 * Update a client's lead target + period for the V6 auto-pause. (v2 Module V6.) `target` null →
 * fall back to lead_guarantee (no per-period cap beyond the contractual guarantee); a positive int
 * caps deliver-then-stop at that many leads per `period`. The send route reads these fresh each
 * batch, so a change resumes/halts sending on the NEXT batch with no redeploy. Scoped to one client.
 */
export async function setClientLeadTarget(
  clientId: number,
  target: number | null,
  period: "week" | "month"
): Promise<void> {
  const clamped = target == null ? null : Math.max(0, Math.floor(target));
  await sql`
    UPDATE clients
    SET lead_target = ${clamped}, target_period = ${period}
    WHERE id = ${clientId}
  `;
}

/**
 * All clients, oldest id first. (v2 Module V4 — the operator cockpit.) This is an OPERATOR-only
 * read: the operator owns every client, so the cockpit may aggregate summary metrics across all of
 * them. It returns the client records only — no contact-level data crosses a client boundary here,
 * and nothing client-FACING uses it.
 */
export async function listClients(): Promise<Client[]> {
  const rows = await sql`SELECT * FROM clients ORDER BY id`;
  return (rows as Record<string, unknown>[]).map(toClient);
}

/** Load one client by id, or null if no such client. */
export async function getClientById(id: number): Promise<Client | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await sql`SELECT * FROM clients WHERE id = ${id}`;
  return rows.length ? toClient(rows[0] as Record<string, unknown>) : null;
}

/**
 * Resolve the client that owns an inbound Twilio number (the `To` of an inbound SMS).
 * Matches the message's destination against each client's from_number by last-10 digits, so
 * formatting differences (E.164 vs bare) never miss. Status is NOT filtered — a paused client
 * must still honor STOP on its number. Returns null if no client owns the number (the webhook
 * then refuses to process, so a message to an unknown number never touches anyone's data — it is
 * dropped, never misrouted to another client).
 *
 * LIMITATION (review M2): this matches ONLY `from_number`. A client configured with a Messaging
 * Service and NO `from_number` would not resolve here (its inbound would be safely dropped, not
 * misrouted — but its STOP would go unprocessed). Talan (client 1) uses a bare from_number, so this
 * is correct today; when a messaging-service client is onboarded, require its from_number to be set
 * (or extend this to map the pool number). Tracked for the campaigns/onboarding modules.
 */
export async function getClientByInboundNumber(toNumber: string): Promise<Client | null> {
  if (!toNumber || !toNumber.trim()) return null;
  const rows = await sql`
    SELECT * FROM clients
    WHERE from_number IS NOT NULL
      AND right(regexp_replace(from_number, '[^0-9]', '', 'g'), 10)
        = right(regexp_replace(${toNumber}, '[^0-9]', '', 'g'), 10)
    ORDER BY id
    LIMIT 1
  `;
  return rows.length ? toClient(rows[0] as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Derived send config (from the client record, not env)
// ---------------------------------------------------------------------------

/** The Twilio sender field for this client — messaging service preferred over bare number. */
export function clientSender(
  client: Client
): { messagingServiceSid: string } | { from: string } {
  const mss = client.messaging_service_sid?.trim();
  if (mss) return { messagingServiceSid: mss };
  const from = client.from_number?.trim();
  if (from) return { from };
  throw new Error(`client ${client.id} has no from_number or messaging_service_sid configured`);
}

export interface SendWindowConfig {
  startHour: number;
  endHour: number;
  timezone: string;
}

/** The [start,end) local-hour send window + timezone for this client. */
export function clientWindow(client: Client): SendWindowConfig {
  return {
    startHour: client.send_window_start_hour,
    endHour: client.send_window_end_hour,
    timezone: client.send_timezone,
  };
}

/** The business name for copy ([BIZ]); brand-less clients (Talan) fall back to a neutral label. */
export function clientBizName(client: Client): string {
  return client.biz_name?.trim() || client.name;
}
