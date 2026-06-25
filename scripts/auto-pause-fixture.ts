// scripts/auto-pause-fixture.ts — proves the V6 deliver-then-stop auto-pause + track-only billing
// (v2 Module V6 acceptance).
//
// Seeds a temporary client #2 with lead_target = 2 and eligible contacts, then asserts THROUGH THE
// REAL SERVER-SIDE GATE (lib/auto-pause.getTargetStatus — the exact function the /api/campaign send
// route consults before sending) that:
//   1. The client auto-stops EXACTLY at the target: 0/1 lead → not met (would send); 2 leads → met
//      (the route refuses) — while eligible contacts STILL REMAIN, so the stop is the gate, not an
//      empty pool. This is the load-bearing "stops after 2 leads in the period" proof, and it is
//      server-side (the gate is a server lib the route calls, not a UI check).
//   2. Raising the target (2→3) resumes; the period rolling over resumes (the prior period's leads
//      no longer count). The window is half-open [start,end) — a lead exactly at the cycle end
//      counts in the NEXT period, never the current one (off-by-one safe).
//   3. Both periods work: 'month' (billing cycle) and 'week' (ISO Mon–Mon UTC).
//   4. Auto-pause is PURELY ADDITIVE — it never weakens suppression: getEligibleContacts excludes an
//      opted-out contact whether or not the target is met, and the gate never mutates eligibility.
//   5. Track-only billing: an invoice materializes for the current cycle, marks invoiced/paid, is
//      client-scoped (another client can't mark it), and surfaces on the cockpit with the correct
//      next-bill-date.
// Everything created is cleaned up; client 1 (Talan) is proven unchanged. Exits non-zero on any fail.
//
// Run: npm run test:auto-pause

import { config } from "dotenv";
config({ path: ".env.local" });
config();

const C2 = 2;
const C2_FROM = "+15005550006";
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql } = await import("@/lib/db");
  const { getEligibleContacts } = await import("@/lib/db");
  const { getClientById, setClientLeadTarget } = await import("@/lib/clients");
  const { getTargetStatus } = await import("@/lib/auto-pause");
  const { getCockpitData } = await import("@/lib/cockpit");
  const { ensureInvoiceForCurrentCycle, getCurrentInvoice, markInvoice } = await import("@/lib/billing");

  // Fixed clocks. billing_day NULL → calendar-month cycle = Jun 1 .. Jul 1, 2026.
  const NOW = new Date(Date.UTC(2026, 5, 20, 12)); // 2026-06-20 — inside June cycle
  const NOW_NEXT = new Date(Date.UTC(2026, 6, 5, 12)); // 2026-07-05 — next month's cycle
  const NOW_W = new Date(Date.UTC(2026, 5, 10, 12)); // 2026-06-10 — ISO week Jun 8..15
  const NOW_W2 = new Date(Date.UTC(2026, 5, 17, 12)); // 2026-06-17 — ISO week Jun 15..22
  const L1 = new Date(Date.UTC(2026, 5, 10, 9)).toISOString(); // Jun 10 (June cycle + week Jun8-15)
  const L2 = new Date(Date.UTC(2026, 5, 12, 9)).toISOString(); // Jun 12 (June cycle + week Jun8-15)
  const LB = new Date(Date.UTC(2026, 6, 1, 0, 0, 0)).toISOString(); // Jul 1 00:00 — the cycle boundary

  // Snapshot client 1 so we can prove the fixture didn't touch it.
  const c1LeadsBefore = (await sql`SELECT count(*)::int n FROM leads WHERE client_id=1`)[0] as { n: number };

  try {
    // --- client 2: $2,500/mo plan, lead_target=2, month period, eligible contacts + 1 opted-out ---
    await sql`
      INSERT INTO clients (id, name, status, plan_amount_cents, lead_guarantee, lead_target,
                           target_period, billing_day, from_number, send_rate_per_hour)
      VALUES (${C2}, 'AUTO-PAUSE TEST CLIENT', 'active', 250000, 50, 2, 'month', NULL, ${C2_FROM}, 60)
      ON CONFLICT (id) DO NOTHING
    `;
    const camp = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${C2}, 'auto-pause camp') RETURNING id`)[0] as { id: number }
    ).id;
    // 4 eligible contacts (matched/clean/not_sent + phone, not opted out).
    for (let i = 0; i < 4; i++) {
      await sql`
        INSERT INTO contacts (client_id, campaign_id, address, phone, skiptrace_status, scrub_status, send_status)
        VALUES (${C2}, ${camp}, ${"10" + i + " Test St"}, ${"800555100" + i}, 'matched', 'clean', 'not_sent')
      `;
    }
    // 1 opted-out contact (clean + not_sent, but its phone is in opt_outs) — must NEVER be eligible.
    const optOutPhone = "8005559999";
    await sql`
      INSERT INTO contacts (client_id, campaign_id, address, phone, skiptrace_status, scrub_status, send_status)
      VALUES (${C2}, ${camp}, '999 Opted Out Ln', ${optOutPhone}, 'matched', 'clean', 'not_sent')
    `;
    await sql`INSERT INTO opt_outs (client_id, phone) VALUES (${C2}, ${optOutPhone})`;

    const client = (await getClientById(C2))!;

    // === 1. Stops EXACTLY at the target (server-side gate), contacts still remaining ===
    const s0 = await getTargetStatus(client, NOW);
    check("target=2, 0 leads → NOT met (sending allowed)", s0.met === false && s0.target === 2 && s0.leadsThisPeriod === 0);

    await sql`INSERT INTO leads (client_id, reply_text, created_at) VALUES (${C2}, 'interested', ${L1})`;
    const s1 = await getTargetStatus(client, NOW);
    check("1/2 leads → still NOT met (off-by-one: 1 < 2)", s1.met === false && s1.leadsThisPeriod === 1);
    const eligibleAtNotMet = await getEligibleContacts(C2, { campaignId: camp });
    check("eligible contacts remain while under target (4 clean)", eligibleAtNotMet.length === 4);

    await sql`INSERT INTO leads (client_id, reply_text, created_at) VALUES (${C2}, 'interested', ${L2})`;
    const s2 = await getTargetStatus(client, NOW);
    check("2/2 leads → MET → the send route refuses (deliver-then-stop)", s2.met === true && s2.leadsThisPeriod === 2);
    const eligibleAtMet = await getEligibleContacts(C2, { campaignId: camp });
    check(
      "stop is the GATE, not an empty pool — 4 eligible contacts STILL remain when paused",
      eligibleAtMet.length === 4
    );

    // === 4. Suppression is never weakened — opted-out contact excluded met or not met ===
    const eligiblePhones = new Set(eligibleAtMet.map((c) => c.phone));
    check("opted-out contact is NOT eligible (suppression holds, met or not)", !eligiblePhones.has(optOutPhone));
    check("eligibility is identical whether target met or not (gate is purely additive)", eligibleAtNotMet.length === eligibleAtMet.length);

    // === 2a. Raising the target resumes ===
    await setClientLeadTarget(C2, 3, "month");
    const sRaised = await getTargetStatus((await getClientById(C2))!, NOW);
    check("raise target 2→3 → NOT met again (resumes)", sRaised.met === false && sRaised.target === 3 && sRaised.leadsThisPeriod === 2);
    await setClientLeadTarget(C2, 2, "month"); // restore

    // === 2b. Period rollover resumes; half-open window is off-by-one safe ===
    const sNext = await getTargetStatus((await getClientById(C2))!, NOW_NEXT);
    check("next month's period → prior leads excluded → NOT met (resumes)", sNext.met === false && sNext.leadsThisPeriod === 0);

    // A lead exactly at the cycle boundary (Jul 1 00:00) counts in the NEXT period, not this one.
    await sql`INSERT INTO leads (client_id, reply_text, created_at) VALUES (${C2}, 'boundary', ${LB})`;
    const sJuneAfterBoundary = await getTargetStatus((await getClientById(C2))!, NOW);
    check("boundary lead at period END does NOT count in the current period (end exclusive)", sJuneAfterBoundary.leadsThisPeriod === 2);
    const sJulyWithBoundary = await getTargetStatus((await getClientById(C2))!, NOW_NEXT);
    check("boundary lead at period START counts in the NEXT period (start inclusive)", sJulyWithBoundary.leadsThisPeriod === 1);

    // === 3. Week period: 2 leads in ISO week Jun 8..15 → met; the next week → not met ===
    await setClientLeadTarget(C2, 2, "week");
    const cWeek = (await getClientById(C2))!;
    const sWeek = await getTargetStatus(cWeek, NOW_W);
    check("week period: 2 leads in the ISO week → MET", sWeek.met === true && sWeek.period === "week" && sWeek.leadsThisPeriod === 2);
    const sWeekNext = await getTargetStatus(cWeek, NOW_W2);
    check("week period rolls over: the next ISO week has 0 of those leads → NOT met", sWeekNext.met === false && sWeekNext.leadsThisPeriod === 0);
    await setClientLeadTarget(C2, 2, "month"); // restore to month/2 for the cockpit assertions

    // === 5. Track-only billing ===
    const billClient = (await getClientById(C2))!;
    const inv = await ensureInvoiceForCurrentCycle(billClient, NOW);
    check("invoice materializes for the current cycle (Jun 1 → Jul 1, $2,500, due)",
      inv.status === "due" && inv.amount_cents === 250000 &&
      inv.period_start.startsWith("2026-06-01") && inv.period_end.startsWith("2026-07-01"));
    check("ensureInvoice is idempotent (same row id on re-call)", (await ensureInvoiceForCurrentCycle(billClient, NOW)).id === inv.id);

    // Cross-client safety: client 1 can't mark client 2's invoice.
    check("another client cannot mark this invoice (client-scoped)", (await markInvoice(1, inv.id, "paid")) === null);

    const invInvoiced = await markInvoice(C2, inv.id, "invoiced");
    check("mark invoiced → status invoiced, invoiced_at set", invInvoiced?.status === "invoiced" && invInvoiced?.invoiced_at !== null);
    const invPaid = await markInvoice(C2, inv.id, "paid");
    check("mark paid → status paid, paid_at set, invoiced_at retained", invPaid?.status === "paid" && invPaid?.paid_at !== null && invPaid?.invoiced_at !== null);
    check("getCurrentInvoice reflects the paid status", (await getCurrentInvoice(billClient, NOW))?.status === "paid");

    // === Cockpit surfacing: auto-pause badge + billing status + next bill date ===
    const cockpit = await getCockpitData(NOW);
    const row = cockpit.rows.find((r) => r.clientId === C2);
    check("cockpit shows client 2", !!row);
    if (row) {
      check("cockpit: autoPaused true (2/2 this month)", row.autoPaused === true && row.target === 2 && row.leadsThisPeriod === 2);
      check("cockpit: next bill date = Jul 1 (current cycle end)", row.nextBillDate.startsWith("2026-07-01"));
      check("cockpit: invoice status = paid, invoiceId set", row.invoiceStatus === "paid" && row.invoiceId === inv.id);
      check("cockpit: plan amount surfaced", row.planAmountCents === 250000);
    }

    // === Talan (client 1) target behavior: lead_target null → falls back to the guarantee ===
    const c1 = (await getClientById(1))!;
    const c1Status = await getTargetStatus(c1, NOW);
    check("client 1 lead_target is null (unchanged) → effective target = guarantee (50), month period",
      c1.lead_target === null && c1Status.target === c1.lead_guarantee && c1Status.period === "month");
  } finally {
    // Cleanup — client_invoices FIRST (FK to clients), then the rest.
    await sql`DELETE FROM client_invoices WHERE client_id = ${C2}`;
    await sql`DELETE FROM leads WHERE client_id = ${C2}`;
    await sql`DELETE FROM opt_outs WHERE client_id = ${C2}`;
    await sql`DELETE FROM contacts WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id = ${C2}`;
    await sql`DELETE FROM clients WHERE id = ${C2}`;
  }

  const c1LeadsAfter = (await sql`SELECT count(*)::int n FROM leads WHERE client_id=1`)[0] as { n: number };
  check("client 1 lead count unchanged by the fixture", c1LeadsAfter.n === c1LeadsBefore.n);

  console.log(failures === 0 ? "\nAUTO-PAUSE OK — deliver-then-stop is server-enforced + billing tracks." : `\nAUTO-PAUSE FAILED — ${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[auto-pause] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
