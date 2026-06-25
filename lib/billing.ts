/**
 * lib/billing.ts — track-only billing (NO Stripe). (v2 Module V6.)
 *
 * Records each client's billing cycles + invoiced/paid status. Collection happens OUTSIDE the app —
 * this is bookkeeping the operator drives from the cockpit (mark invoiced / mark paid). There is NO
 * payment processing here by design. One invoice row per client per billing cycle, keyed on
 * (client_id, period_start) so materializing is idempotent. The billing cycle is the client's
 * monthly billing cycle (reuses lib/billing-cycle.ts), independent of the lead-target period.
 *
 * Every query is scoped to one client_id — billing is per-tenant like every other table.
 */

import "server-only";
import { sql } from "@/lib/db";
import type { Client } from "@/lib/clients";
import { currentCycle } from "@/lib/billing-cycle";

export type InvoiceStatus = "due" | "invoiced" | "paid";

export interface Invoice {
  id: number;
  client_id: number;
  period_start: string; // ISO
  period_end: string; // ISO
  amount_cents: number;
  status: InvoiceStatus;
  invoiced_at: string | null;
  paid_at: string | null;
  created_at: string;
}

/** neon returns timestamptz as a JS Date; normalize to a stable ISO-8601 string (UTC). */
function toIso(v: unknown): string {
  return new Date(v as string | number | Date).toISOString();
}

function toInvoice(r: Record<string, unknown>): Invoice {
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    period_start: toIso(r.period_start),
    period_end: toIso(r.period_end),
    amount_cents: Number(r.amount_cents),
    status: String(r.status) as InvoiceStatus,
    invoiced_at: r.invoiced_at == null ? null : toIso(r.invoiced_at),
    paid_at: r.paid_at == null ? null : toIso(r.paid_at),
    created_at: toIso(r.created_at),
  };
}

/**
 * The invoice for the client's CURRENT billing cycle, or null if not materialized yet. Read-only —
 * the cockpit uses this to show the cycle's status without side effects (an unmaterialized cycle
 * reads as the implicit 'due'). Scoped by client_id AND the cycle's period_start.
 */
export async function getCurrentInvoice(client: Client, now: Date = new Date()): Promise<Invoice | null> {
  const cycle = currentCycle(now, client.billing_day);
  const rows = await sql`
    SELECT * FROM client_invoices
    WHERE client_id = ${client.id} AND period_start = ${cycle.start.toISOString()}
  `;
  return rows.length ? toInvoice(rows[0] as Record<string, unknown>) : null;
}

/**
 * Materialize (idempotently) the invoice row for the client's current billing cycle and return it.
 * amount_cents snapshots the client's plan amount. Used by the operator mark action so there is a
 * concrete row to set invoiced/paid on. Idempotent via the unique (client_id, period_start) index.
 */
export async function ensureInvoiceForCurrentCycle(
  client: Client,
  now: Date = new Date()
): Promise<Invoice> {
  const cycle = currentCycle(now, client.billing_day);
  await sql`
    INSERT INTO client_invoices (client_id, period_start, period_end, amount_cents, status)
    VALUES (${client.id}, ${cycle.start.toISOString()}, ${cycle.end.toISOString()},
            ${client.plan_amount_cents}, 'due')
    ON CONFLICT (client_id, period_start) DO NOTHING
  `;
  const existing = await getCurrentInvoice(client, now);
  if (!existing) throw new Error(`failed to materialize invoice for client ${client.id}`);
  return existing;
}

/**
 * Mark an invoice invoiced or paid, scoped to one client. 'invoiced' stamps invoiced_at; 'paid'
 * stamps paid_at (and invoiced_at too if it was skipped, so a paid invoice is also recorded as
 * invoiced). Returns the updated row, or null if no such invoice for this client.
 */
export async function markInvoice(
  clientId: number,
  invoiceId: number,
  action: "invoiced" | "paid"
): Promise<Invoice | null> {
  const rows =
    action === "paid"
      ? await sql`
          UPDATE client_invoices
          SET status = 'paid', paid_at = now(), invoiced_at = COALESCE(invoiced_at, now())
          WHERE id = ${invoiceId} AND client_id = ${clientId}
          RETURNING *
        `
      : await sql`
          UPDATE client_invoices
          SET status = 'invoiced', invoiced_at = now()
          WHERE id = ${invoiceId} AND client_id = ${clientId}
          RETURNING *
        `;
  return rows.length ? toInvoice(rows[0] as Record<string, unknown>) : null;
}

/** All invoices for a client, newest cycle first. (Operator billing history.) */
export async function listInvoices(clientId: number, limit = 24): Promise<Invoice[]> {
  const rows = await sql`
    SELECT * FROM client_invoices
    WHERE client_id = ${clientId}
    ORDER BY period_start DESC
    LIMIT ${limit}
  `;
  return (rows as Record<string, unknown>[]).map(toInvoice);
}
