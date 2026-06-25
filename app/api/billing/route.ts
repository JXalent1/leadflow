// /api/billing — track-only billing actions for the operator cockpit. (v2 Module V6.)
//
// AUTH: operator session only (requireOperator) — billing is an operator concern. The client is
// resolved through the session via resolveClientIdForUser (never a bare ?clientId= param), so the
// V5 access gate still governs which client an action touches.
//
// GET   list a client's invoices (billing history).
// POST  { action: 'invoiced' | 'paid' } — materialize the current cycle's invoice if needed and
//       mark it. NO Stripe / payment processing — this only records status; collection is manual.

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId } from "@/lib/request-client";
import { getClientById } from "@/lib/clients";
import { ensureInvoiceForCurrentCycle, listInvoices, markInvoice } from "@/lib/billing";

export async function GET(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const invoices = await listInvoices(clientId);
    return NextResponse.json({ invoices });
  } catch (err) {
    console.error("[billing] list failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "billing_list_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const client = await getClientById(clientId);
    if (!client) return NextResponse.json({ error: "client_not_found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    if (action !== "invoiced" && action !== "paid") {
      return NextResponse.json(
        { error: "invalid_action", message: "action must be 'invoiced' or 'paid'." },
        { status: 400 }
      );
    }

    // Materialize the current cycle's invoice (idempotent) so there is a concrete row to mark.
    const invoice = await ensureInvoiceForCurrentCycle(client);
    const updated = await markInvoice(client.id, invoice.id, action);
    if (!updated) return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
    return NextResponse.json({ invoice: updated });
  } catch (err) {
    console.error("[billing] mark failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "billing_mark_failed" }, { status: 500 });
  }
}
