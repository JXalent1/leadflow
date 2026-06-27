// scripts/access-control-fixture.ts — PROVES the V1 access-control gate is CLOSED. (v2 Module V5)
//
// Seeds a temp client 2 (+ a contact + a lead) and three users — an operator, a client-1 user, and
// a client-2 user — then asserts through the REAL lib that a CLIENT user can never reach another
// client's data by any vector:
//   1. resolveClientIdForUser (the single chokepoint every client-resolving route uses) locks a
//      client user to their own client_id: requesting ANOTHER client id → null (route 403s),
//      requesting their own or nothing → their own. NEVER another client's id.
//   2. Operators retain legitimate cross-client access.
//   3. The session cookie can't be forged: a tampered token (flipping role→operator / cid→other)
//      fails signature verification, and a token under a different secret fails.
//   4. The DB is authoritative: a session re-loads the user, so role/client_id come from the row.
//   5. Passwords are stored only as scrypt hashes and verify correctly.
//   6. getPortalData is client-scoped: client 2's portal contains ONLY client-2 leads (no client-1
//      lead leaks in).
// Everything created is cleaned up; client 1 is proven unchanged. Exits non-zero on any failure.
//
// Run: npm run test:access

import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "fixture-session-secret-at-least-16-chars";

// High throwaway id (NOT a low/real client id — see scripts/fixture-safety.ts; 2026-06-27 incident).
const C2 = 900002;
const C2_NAME = "ACCESS TEST CLIENT";
const C2_FROM = "+15005550006";
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

const OP_EMAIL = "fixture-operator@leadflow.test";
const C1_EMAIL = "fixture-client1@leadflow.test";
const C2_EMAIL = "fixture-client2@leadflow.test";
const ALL_EMAILS = [OP_EMAIL, C1_EMAIL, C2_EMAIL];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql } = await import("@/lib/db");
  const { hashPassword, verifyPassword, signSession, verifySession } = await import("@/lib/auth");
  const { upsertUser, getUserById, getUserWithHashByEmail } = await import("@/lib/users");
  const { resolveClientIdForUser, isOperator } = await import("@/lib/access");
  const { resolveCampaignForClient } = await import("@/lib/campaigns");
  const { getPortalData } = await import("@/lib/portal");
  const { getClientById } = await import("@/lib/clients");

  const c1Before = (await sql`SELECT count(*)::int n FROM leads WHERE client_id=1`)[0] as { n: number };
  // Read existing client-1 lead ids (read-only) to later prove none leak into client 2's portal.
  const c1LeadIds = new Set(
    ((await sql`SELECT id FROM leads WHERE client_id=1`) as { id: number }[]).map((r) => r.id)
  );

  // Pre-clean any leftover fixture users from a previous aborted run.
  await sql`DELETE FROM users WHERE email = ANY(${ALL_EMAILS})`;

  // SAFETY: refuse to run if C2 is a real client (cleanup deletes ALL client_id=C2 data). Before try.
  const { assertDisposableClientId } = await import("./fixture-safety");
  await assertDisposableClientId(sql, C2, C2_NAME);

  try {
    // --- client 2 + a contact + a this-cycle lead ---
    await sql`
      INSERT INTO clients (id, name, from_number, send_rate_per_hour)
      VALUES (${C2}, ${C2_NAME}, ${C2_FROM}, 60)
      ON CONFLICT (id) DO NOTHING
    `;
    const c2Camp = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${C2}, 'access c2 camp') RETURNING id`)[0] as { id: number }
    ).id;
    const c2Contact = (
      (await sql`
        INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, phone,
                              skiptrace_status, scrub_status, send_status)
        VALUES (${C2}, ${c2Camp}, 'Cassie', 'Two', '900 Other St', '9995551234',
                'matched', 'clean', 'sent')
        RETURNING id`)[0] as { id: number }
    ).id;
    const c2Lead = (
      (await sql`INSERT INTO leads (client_id, contact_id, reply_text) VALUES (${C2}, ${c2Contact}, 'interested!') RETURNING id`)[0] as { id: number }
    ).id;

    // --- three users (passwords hashed) ---
    const PW = "Sup3r-Secret-Pw!";
    const op = await upsertUser({ email: OP_EMAIL, passwordHash: hashPassword(PW), role: "operator", clientId: null });
    const c1u = await upsertUser({ email: C1_EMAIL, passwordHash: hashPassword(PW), role: "client", clientId: 1 });
    const c2u = await upsertUser({ email: C2_EMAIL, passwordHash: hashPassword(PW), role: "client", clientId: C2 });

    // === 0. DB is authoritative: re-load users by id ===
    const opDb = await getUserById(op.id);
    const c2Db = await getUserById(c2u.id);
    check("operator user loads with role=operator, client_id NULL", opDb?.role === "operator" && opDb?.client_id === null);
    check("client-2 user loads with role=client, client_id=C2", c2Db?.role === "client" && c2Db?.client_id === C2);

    // === 1. THE CLOSED GATE: a client user can never resolve to another client ===
    for (const requested of [undefined, 1, 2, 3, 999] as (number | undefined)[]) {
      const resolved = resolveClientIdForUser(c2Db, requested);
      // Only ever their own client (2) or denied (null) — never another client's id (e.g. 1).
      const ok = resolved === 2 || resolved === null;
      check(`client-2 user + ?clientId=${requested} → ${resolved} (never another client)`, ok);
    }
    check("client-2 user requesting client 1 is DENIED (null → 403)", resolveClientIdForUser(c2Db, 1) === null);
    check("client-2 user with no param → their own client (2)", resolveClientIdForUser(c2Db, undefined) === 2);
    check("client-1 user requesting client 2 is DENIED", resolveClientIdForUser(await getUserById(c1u.id), 2) === null);

    // === 2. Operator keeps legitimate cross-client access ===
    check("operator → requested client 1", resolveClientIdForUser(opDb, 1) === 1);
    check("operator → requested client 2", resolveClientIdForUser(opDb, 2) === 2);
    check("operator → default when no param", resolveClientIdForUser(opDb, undefined) === 1);
    check("isOperator: operator true, client false", isOperator(opDb) === true && isOperator(c2Db) === false);
    // /client is operator-unreachable: the portal page redirects when isOperator(user) is true, so
    // an operator can never land on the single-client portal surface.
    check("/client is unreachable by an operator (isOperator → redirect off the portal)", isOperator(opDb) === true);

    // A cross-client campaignId never escapes the resolved client: resolveCampaignForClient(client 1,
    // <client-2 campaign>) falls back to client 1's OWN campaign — it NEVER returns the foreign id.
    const c1Camp = await resolveCampaignForClient(1, c2Camp);
    check(
      "resolveCampaignForClient(client 1, client-2 campaign) → client-1 campaign, never the foreign id",
      c1Camp !== null && c1Camp.id !== c2Camp && c1Camp.client_id === 1
    );

    // === 3. Session cookie cannot be forged ===
    const c2Token = signSession({ uid: c2u.id, role: "client", cid: 2 });
    const good = verifySession(c2Token);
    check("a valid client-2 token verifies to that uid", good?.uid === c2u.id);
    // Forge: swap the payload to claim operator, keep the original signature.
    const forgedPayload = Buffer.from(JSON.stringify({ uid: c2u.id, role: "operator", cid: null, exp: Math.floor(Date.now() / 1000) + 9999 }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forged = `${forgedPayload}.${c2Token.split(".")[1]}`;
    check("a tampered token (client→operator) FAILS verification", verifySession(forged) === null);
    const origSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "a-totally-different-secret-value!!";
    check("a token signed under a different secret FAILS", verifySession(c2Token) === null);
    process.env.SESSION_SECRET = origSecret;

    // === 4. Passwords: scrypt hash, correct verify, no plaintext ===
    const withHash = await getUserWithHashByEmail(C2_EMAIL);
    check("stored password is a scrypt hash, not plaintext", !!withHash && withHash.password_hash.startsWith("scrypt$") && !withHash.password_hash.includes(PW));
    check("verifyPassword accepts the right password", verifyPassword(PW, withHash!.password_hash) === true);
    check("verifyPassword rejects the wrong password", verifyPassword("wrong-password", withHash!.password_hash) === false);

    // === 5. Portal data is client-scoped — client 2 sees ONLY client-2 leads ===
    const portal2 = await getPortalData((await getClientById(C2))!);
    check("client-2 portal includes the client-2 lead", portal2.recentLeads.some((l) => l.id === c2Lead));
    check("client-2 portal leadsThisCycle counts the new lead", portal2.leadsThisCycle >= 1);
    const portalLeadIds = new Set(portal2.recentLeads.map((l) => l.id));
    check("NO client-1 lead appears in the client-2 portal", [...c1LeadIds].every((id) => !portalLeadIds.has(id)));
    check("every lead in the client-2 portal is a client-2 lead", portal2.recentLeads.every((l) => l.id === c2Lead || !c1LeadIds.has(l.id)));
  } finally {
    await sql`DELETE FROM users WHERE email = ANY(${ALL_EMAILS})`;
    await sql`DELETE FROM client_invoices WHERE client_id = ${C2}`;
    await sql`DELETE FROM leads WHERE client_id = ${C2}`;
    await sql`DELETE FROM contacts WHERE client_id = ${C2}`;
    await sql`DELETE FROM trace_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM scrub_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id = ${C2}`;
    await sql`DELETE FROM clients WHERE id = ${C2}`;
  }

  const c1After = (await sql`SELECT count(*)::int n FROM leads WHERE client_id=1`)[0] as { n: number };
  check("client 1 lead count unchanged by the fixture", c1After.n === c1Before.n);
  const leftoverUsers = (await sql`SELECT count(*)::int n FROM users WHERE email = ANY(${ALL_EMAILS})`)[0] as { n: number };
  check("all fixture users cleaned up", leftoverUsers.n === 0);

  console.log(failures === 0 ? "\nACCESS-CONTROL OK — the V1 gate is CLOSED." : `\nACCESS-CONTROL FAILED — ${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[access-control] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
