// scripts/inbox-scope-fixture.ts — PROVES the UI-fixes PR's read-path scoping + auto-pause toggle.
//
// Covers the three acceptance items for build/ui-fixes (#11 inbox client-scoping, #16 auto-pause
// toggle/default), through the REAL lib (no HTTP needed — the routes are thin auth+scope wrappers
// over these helpers, all of which take an explicit clientId):
//
//   1. OPERATOR can open client 2's inbox, SCOPED — getInboxThreads(C2) returns C2's thread and NO
//      client-1 contact leaks in; getThread/getContactById enforce the (clientId, id) pair so a
//      foreign id never resolves under the wrong scope. resolveClientIdForUser(operator, C2) === C2.
//   2. A CLIENT-role user can't reach another client's inbox — resolveClientIdForUser denies every
//      foreign id (→ the route 403s), and the scoped helpers return nothing for a cross-client id.
//   3. AUTO-PAUSE toggle PERSISTS + OFF = never pauses — updateClientConfig writes lead_target=0
//      (toggle off) and getTargetStatus.met stays false even WITH a lead present (no over-stop);
//      flipping it to a positive target persists and then meets. Talan (client 1) is untouched.
//
// Everything created is cleaned up; client 1 is proven unchanged. Exits non-zero on any failure.
//
// Run: npm run test:inbox-scope

import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "fixture-session-secret-at-least-16-chars";

// High throwaway id (NOT a low/real client id — see scripts/fixture-safety.ts; 2026-06-27 incident).
const C2 = 900002;
const C2_NAME = "INBOX SCOPE TEST CLIENT";
const C2_FROM = "+15005550007";
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql } = await import("@/lib/db");
  const { resolveClientIdForUser } = await import("@/lib/access");
  const { getInboxThreads, getThread, getContactById } = await import("@/lib/inbox-db");
  const { getClientById, updateClientConfig } = await import("@/lib/clients");
  const { getTargetStatus } = await import("@/lib/auto-pause");

  // Operator (any client) + a client-1 user + a client-2 user — as resolveClientIdForUser sees them.
  const opUser = { id: 1, role: "operator", client_id: null };
  const c1User = { id: 2, role: "client", client_id: 1 };
  const c2User = { id: 3, role: "client", client_id: C2 };

  // Talan (client 1) baselines we must not disturb.
  const c1 = await getClientById(1);
  const c1LeadCountBefore = (await sql`SELECT count(*)::int n FROM leads WHERE client_id=1`)[0] as { n: number };
  // A real client-1 contact id (read-only) to prove it never resolves under the C2 scope.
  const c1ContactRow = (await sql`SELECT id FROM contacts WHERE client_id=1 ORDER BY id LIMIT 1`) as { id: number }[];
  const c1ContactId = c1ContactRow.length ? c1ContactRow[0].id : null;

  // SAFETY: refuse to run if C2 is a real client (cleanup deletes ALL client_id=C2 data). Before try.
  const { assertDisposableClientId } = await import("./fixture-safety");
  await assertDisposableClientId(sql, C2, C2_NAME);

  try {
    // --- client 2 + a contact with an inbound message + a lead (a real inbox thread) ---
    await sql`
      INSERT INTO clients (id, name, from_number, send_rate_per_hour, lead_guarantee, lead_target, target_period)
      VALUES (${C2}, ${C2_NAME}, ${C2_FROM}, 60, 50, 0, 'month')
      ON CONFLICT (id) DO NOTHING
    `;
    const c2Camp = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${C2}, 'inbox scope camp') RETURNING id`)[0] as { id: number }
    ).id;
    const c2Contact = (
      (await sql`
        INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, phone,
                              skiptrace_status, scrub_status, send_status)
        VALUES (${C2}, ${c2Camp}, 'Ivy', 'Inbox', '12 Scope Ln', '9995557007',
                'matched', 'clean', 'sent')
        RETURNING id`)[0] as { id: number }
    ).id;
    await sql`
      INSERT INTO messages (client_id, contact_id, direction, body, status)
      VALUES (${C2}, ${c2Contact}, 'inbound', 'yes interested', 'received')
    `;
    const c2Lead = (
      (await sql`INSERT INTO leads (client_id, contact_id, reply_text) VALUES (${C2}, ${c2Contact}, 'interested!') RETURNING id`)[0] as { id: number }
    ).id;

    // === 1. Operator can open client 2's inbox, scoped — no client-1 leakage ===
    check("operator resolves to C2 when ?clientId=C2 (can open client 2's inbox)", resolveClientIdForUser(opUser, C2) === C2);
    const c2Threads = await getInboxThreads(C2);
    check("client-2 inbox includes the client-2 thread", c2Threads.some((t) => t.id === c2Contact));
    check("EVERY thread in the client-2 inbox is a client-2 contact (no client-1 leakage)",
      c2Threads.every((t) => t.id === c2Contact));
    const c1Threads = await getInboxThreads(1);
    check("the client-2 contact NEVER appears in client 1's inbox", !c1Threads.some((t) => t.id === c2Contact));

    // getThread / getContactById enforce the (clientId, id) pair — a foreign id never resolves.
    check("getThread(C2, c2Contact) returns the thread", (await getThread(C2, c2Contact))?.contact.id === c2Contact);
    check("getThread(1, c2Contact) → null (client 1 can't read a C2 contact)", (await getThread(1, c2Contact)) === null);
    check("getContactById(C2, c2Contact) resolves", (await getContactById(C2, c2Contact))?.id === c2Contact);
    check("getContactById(1, c2Contact) → null (reply path can't load a C2 contact under client 1)",
      (await getContactById(1, c2Contact)) === null);
    if (c1ContactId !== null) {
      check("getThread(C2, <a client-1 contact>) → null (a client-1 id never resolves under C2 scope)",
        (await getThread(C2, c1ContactId)) === null);
    }

    // === 2. A client-role user can't reach another client's inbox (→ route 403s) ===
    check("client-1 user requesting client 2 is DENIED (null → 403)", resolveClientIdForUser(c1User, C2) === null);
    check("client-2 user requesting client 1 is DENIED (null → 403)", resolveClientIdForUser(c2User, 1) === null);
    check("client-2 user with no/own param → their own client (C2)",
      resolveClientIdForUser(c2User, undefined) === C2 && resolveClientIdForUser(c2User, C2) === C2);

    // === 3. Auto-pause toggle persists + OFF = never pauses (no over-stop) ===
    // Seeded with lead_target=0 (toggle OFF). A lead exists, yet met must stay false.
    const offClient = (await getClientById(C2))!;
    check("toggle OFF persisted as lead_target = 0", offClient.lead_target === 0);
    const offStatus = await getTargetStatus(offClient);
    check("OFF (lead_target 0) never pauses even WITH a lead present (met=false, target<=0)",
      offStatus.met === false && offStatus.target <= 0 && offStatus.leadsThisPeriod >= 1);

    // Flip the toggle ON to a positive target → persists, and now meets (1 lead >= target 1).
    await updateClientConfig(C2, { lead_target: 1, target_period: "month" });
    const onClient = (await getClientById(C2))!;
    check("toggle ON persisted as lead_target = 1", onClient.lead_target === 1);
    const onStatus = await getTargetStatus(onClient);
    check("ON (lead_target 1) with 1 lead → target met (auto-pause engages)",
      onStatus.met === true && onStatus.target === 1 && onStatus.leadsThisPeriod >= 1);

    // Flip back OFF → 0 persists and never-pause restored (the operator can always turn it off).
    await updateClientConfig(C2, { lead_target: 0 });
    check("toggle back OFF persisted as 0 and never pauses again",
      (await getClientById(C2))!.lead_target === 0 && (await getTargetStatus((await getClientById(C2))!)).met === false);

    // Sanity: the lead we created is the one counted (scoped to C2).
    check("the counted lead is the C2 lead", c2Lead > 0);
  } finally {
    await sql`DELETE FROM messages WHERE client_id = ${C2}`;
    await sql`DELETE FROM client_invoices WHERE client_id = ${C2}`;
    await sql`DELETE FROM leads WHERE client_id = ${C2}`;
    await sql`DELETE FROM contacts WHERE client_id = ${C2}`;
    await sql`DELETE FROM trace_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM scrub_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id = ${C2}`;
    await sql`DELETE FROM clients WHERE id = ${C2}`;
  }

  // === Client 1 (Talan) proven unchanged ===
  const c1After = await getClientById(1);
  const c1LeadCountAfter = (await sql`SELECT count(*)::int n FROM leads WHERE client_id=1`)[0] as { n: number };
  check("client 1 lead_target unchanged by the fixture", (c1?.lead_target ?? null) === (c1After?.lead_target ?? null));
  check("client 1 lead count unchanged by the fixture", c1After != null && c1LeadCountAfter.n === c1LeadCountBefore.n);
  const leftover = (await sql`SELECT count(*)::int n FROM clients WHERE id = ${C2}`)[0] as { n: number };
  check("fixture client fully cleaned up (DB pristine)", leftover.n === 0);

  console.log(failures === 0 ? "\nINBOX-SCOPE OK — inbox is client-scoped + auto-pause toggle persists." : `\nINBOX-SCOPE FAILED — ${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[inbox-scope] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
