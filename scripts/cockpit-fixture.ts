// scripts/cockpit-fixture.ts — proves the operator cockpit's per-cycle lead counting + pace flag
// (v2 Module V4 acceptance).
//
// Seeds a temporary client #2 with a known billing cycle, then inserts leads BOTH in the current
// cycle and in the PRIOR cycle, plus this-cycle messages + opt-outs for the health read. Against a
// FIXED `now`, it asserts through the real lib (getCockpitData) that:
//   1. The client-2 row counts ONLY this cycle's leads (prior-cycle leads excluded), per client.
//   2. The pace flag is right for the seeded numbers (behind, given few leads mid-cycle).
//   3. The campaign-health rates (sent / reply / opt-out this cycle) are computed correctly.
//   4. The cockpit is an OPERATOR aggregate — it includes every client (client 1 present too).
// Everything it creates is cleaned up, and client 1's this-cycle lead count is proven unchanged.
// Exits non-zero on any failed assertion.
//
// Run: npm run test:cockpit

import { config } from "dotenv";
config({ path: ".env.local" });
config();

// High throwaway id (NOT a low/real client id — see scripts/fixture-safety.ts; 2026-06-27 incident).
const C2 = 900002;
const C2_NAME = "COCKPIT TEST CLIENT";
const C2_FROM = "+15005550006"; // client 2's campaign number (not client 1's)
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql } = await import("@/lib/db");
  const { getCockpitData } = await import("@/lib/cockpit");

  // Fixed clock + a calendar-month billing cycle (billing_day = 1) → cycle = Jun 1 .. Jul 1, 2026.
  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0)); // 2026-06-20
  const IN_CYCLE = new Date(Date.UTC(2026, 5, 10, 9, 0, 0)).toISOString(); // Jun 10 — counts
  const PRIOR_CYCLE = new Date(Date.UTC(2026, 4, 10, 9, 0, 0)).toISOString(); // May 10 — excluded

  // Snapshot client 1's this-cycle cockpit numbers so we can prove the fixture didn't touch it.
  const beforeC1 = (await getCockpitData(NOW)).rows.find((r) => r.clientId === 1);

  // SAFETY: refuse to run if C2 is a real client (cleanup deletes ALL client_id=C2 data). Before try.
  const { assertDisposableClientId } = await import("./fixture-safety");
  await assertDisposableClientId(sql, C2, C2_NAME);

  try {
    // --- create client 2 with a known guarantee + calendar-month cycle ---
    await sql`
      INSERT INTO clients (id, name, status, lead_guarantee, billing_day, from_number,
                           send_rate_per_hour)
      VALUES (${C2}, ${C2_NAME}, 'active', 50, NULL, ${C2_FROM}, 60)
      ON CONFLICT (id) DO NOTHING
    `;

    // 5 leads THIS cycle (count) + 3 leads in the PRIOR cycle (must be excluded).
    for (let i = 0; i < 5; i++) {
      await sql`INSERT INTO leads (client_id, reply_text, created_at) VALUES (${C2}, 'interested', ${IN_CYCLE})`;
    }
    for (let i = 0; i < 3; i++) {
      await sql`INSERT INTO leads (client_id, reply_text, created_at) VALUES (${C2}, 'old lead', ${PRIOR_CYCLE})`;
    }

    // Health: 10 outbound + 2 inbound this cycle (reply rate 20%), 1 outbound last cycle (excluded);
    // 1 opt-out this cycle (opt-out rate 10%).
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO messages (client_id, direction, body, created_at) VALUES (${C2}, 'outbound', 'hi', ${IN_CYCLE})`;
    }
    await sql`INSERT INTO messages (client_id, direction, body, created_at) VALUES (${C2}, 'outbound', 'old', ${PRIOR_CYCLE})`;
    for (let i = 0; i < 2; i++) {
      await sql`INSERT INTO messages (client_id, direction, body, created_at) VALUES (${C2}, 'inbound', 'yes', ${IN_CYCLE})`;
    }
    await sql`INSERT INTO opt_outs (client_id, phone, created_at) VALUES (${C2}, '9990001111', ${IN_CYCLE})`;
    await sql`INSERT INTO opt_outs (client_id, phone, created_at) VALUES (${C2}, '9990002222', ${PRIOR_CYCLE})`;

    // --- assert against the real cockpit aggregate at the fixed clock ---
    const data = await getCockpitData(NOW);
    const c2 = data.rows.find((r) => r.clientId === C2);

    check("cockpit includes the client-2 row", !!c2);
    if (c2) {
      check("counts ONLY this cycle's leads (5), excluding the 3 prior-cycle leads", c2.leads === 5);
      check("cycle window is Jun 1 .. Jul 1 2026 (calendar month)",
        c2.cycleStart.startsWith("2026-06-01") && c2.cycleEnd.startsWith("2026-07-01"));
      check("pace flag is 'behind' (5 leads vs ~33 expected by day 19.5 of 30)", c2.pace === "behind");
      check("sent this cycle = 10 (last-cycle outbound excluded)", c2.sent === 10);
      check("reply rate = 20% (2 inbound / 10 sent)", c2.replyRatePct === 20);
      check("opt-out rate = 10% (1 this-cycle opt-out / 10 sent)", c2.optOutRatePct === 10);
      check("days left in cycle is positive and <= 30", c2.daysLeft > 0 && c2.daysLeft <= 30);
    }

    // Operator aggregate: every client present, and behind clients sorted ahead of met/on-track.
    check("cockpit is an operator aggregate — client 1 is present too", data.rows.some((r) => r.clientId === 1));
    check("totalClients matches the row count", data.totalClients === data.rows.length);
    check("behindCount counts the behind rows", data.behindCount === data.rows.filter((r) => r.pace === "behind").length);
    const behindIdx = data.rows.findIndex((r) => r.clientId === C2);
    const firstNonBehind = data.rows.findIndex((r) => r.pace !== "behind");
    check("the behind client-2 row sorts before any non-behind row",
      firstNonBehind === -1 || behindIdx < firstNonBehind);
  } finally {
    // --- cleanup: remove ALL client-2 fixture data ---
    await sql`DELETE FROM client_invoices WHERE client_id = ${C2}`;
    await sql`DELETE FROM leads WHERE client_id = ${C2}`;
    await sql`DELETE FROM messages WHERE client_id = ${C2}`;
    await sql`DELETE FROM opt_outs WHERE client_id = ${C2}`;
    await sql`DELETE FROM trace_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM scrub_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id = ${C2}`;
    await sql`DELETE FROM clients WHERE id = ${C2}`;
  }

  // --- prove the fixture didn't change client 1's cockpit numbers ---
  const afterC1 = (await getCockpitData(NOW)).rows.find((r) => r.clientId === 1);
  check("client 1's this-cycle lead count unchanged", (afterC1?.leads ?? -1) === (beforeC1?.leads ?? -2));
  check("client 1's this-cycle sent count unchanged", (afterC1?.sent ?? -1) === (beforeC1?.sent ?? -2));

  console.log(failures === 0 ? "\nCOCKPIT OK — all assertions passed." : `\nCOCKPIT FAILED — ${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[cockpit] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
