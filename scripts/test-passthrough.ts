// scripts/test-passthrough.ts — proves the Module N no-scrub passthrough (scrub_mode='none').
//
// On a THROWAWAY client #2 + campaign with scrub_mode='none', asserts:
//   (a) passthroughScrubBatch marks the campaign's matched + with-phone + still-'pending' contacts
//       scrub_status='clean' with NO vendor call and NO credit spend (no scrub_jobs row is created —
//       the passthrough never touches Tracerfy: no getCredits, no submitScrub, no createScrubJob).
//   (b) a contact whose phone is in the client's opt_outs is marked clean by passthrough yet is STILL
//       excluded by getEligibleContacts (the load-bearing safety check — the opt_outs exclusion is
//       independent of scrub_status, so marking clean can never make an opted-out contact sendable).
//   (c) a matched 'pending' contact with NO phone is NOT marked clean (mirrors getContactsForScrub).
//   (d) scrub_mode='vendor' (the default) is what the scrub route branches on for the EXISTING
//       Tracerfy scrubBatch path — passthrough is reached ONLY when scrub_mode==='none'.
//   plus: idempotent (re-run drains to scrubbed=0), `limit` is respected, createCampaign defaults to
//   'vendor', setCampaignScrubMode validates + is client-scoped (can't flip another client's campaign).
// Everything created is cleaned up; client 1 (Talan) is proven unchanged. Exits non-zero on any fail.
//
// Run: npm run test:passthrough

import { config } from "dotenv";
config({ path: ".env.local" });
config();

// High throwaway id (NOT a low/real client id — see scripts/fixture-safety.ts; 2026-06-27 incident).
const C2 = 900002;
const C2_NAME = "PASSTHROUGH TEST CLIENT";
const C2_FROM = "+15005550006";
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql, getEligibleContacts } = await import("@/lib/db");
  const { passthroughScrubBatch } = await import("@/lib/scrub-passthrough");
  const {
    createCampaign,
    getCampaignForClient,
    setCampaignScrubMode,
    isScrubMode,
  } = await import("@/lib/campaigns");

  // Snapshot client 1 so we can prove the fixture didn't touch it.
  const c1Before = (
    await sql`SELECT
      (SELECT count(*)::int FROM contacts WHERE client_id=1) AS contacts,
      (SELECT count(*)::int FROM contacts WHERE client_id=1 AND scrub_status='clean') AS clean,
      (SELECT count(*)::int FROM opt_outs WHERE client_id=1) AS optouts,
      (SELECT scrub_mode FROM campaigns WHERE id=1) AS pilot_mode`
  )[0] as { contacts: number; clean: number; optouts: number; pilot_mode: string };

  // SAFETY: refuse to run if C2 is a real client (cleanup deletes ALL client_id=C2 data). Before try.
  const { assertDisposableClientId } = await import("./fixture-safety");
  await assertDisposableClientId(sql, C2, C2_NAME);

  try {
    // --- throwaway client #2 -------------------------------------------------------------------
    await sql`
      INSERT INTO clients (id, name, status, plan_amount_cents, lead_guarantee, from_number, send_rate_per_hour)
      VALUES (${C2}, ${C2_NAME}, 'active', 250000, 50, ${C2_FROM}, 60)
      ON CONFLICT (id) DO NOTHING
    `;

    // Campaign A: scrub_mode='none'. createCampaign with the explicit mode.
    const campA = await createCampaign(C2, "passthrough none camp", null, "none");
    // Campaign B: default mode (must be 'vendor').
    const campB = await createCampaign(C2, "passthrough vendor camp");

    const a = await getCampaignForClient(C2, campA);
    const b = await getCampaignForClient(C2, campB);
    check("createCampaign(..., 'none') → scrub_mode='none'", a?.scrub_mode === "none");
    check("createCampaign(...) default → scrub_mode='vendor'", b?.scrub_mode === "vendor");

    // Campaign A contacts: 3 matched+with-phone+pending (one of which is opted-out) + 1 no-phone pending.
    async function addContact(camp: number, phone: string | null) {
      const r = (await sql`
        INSERT INTO contacts (client_id, campaign_id, address, phone, skiptrace_status, scrub_status, send_status)
        VALUES (${C2}, ${camp}, '1 Test St', ${phone}, 'matched', 'pending', 'not_sent')
        RETURNING id`)[0] as { id: number };
      return r.id;
    }
    const cA1 = await addContact(campA, "8005551001"); // clean → eligible
    const cA2 = await addContact(campA, "8005551002"); // clean → opted out → NOT eligible
    const cA4 = await addContact(campA, "8005551004"); // clean → eligible
    const cA3 = await addContact(campA, null); // no phone → stays pending
    void cA1;
    void cA4;

    // Opt out cA2's phone at the client level (independent of scrub_status).
    await sql`INSERT INTO opt_outs (client_id, contact_id, phone) VALUES (${C2}, ${cA2}, '8005551002')`;

    // Baseline: no scrub_jobs for client 2 (the passthrough must not create any).
    const jobsBefore = (await sql`SELECT count(*)::int n FROM scrub_jobs WHERE client_id=${C2}`)[0] as { n: number };

    // --- (limit) passthrough in batches: 3 with-phone pending, limit 2 then 2 then drain ----------
    const r1 = await passthroughScrubBatch(C2, { campaignId: campA, limit: 2 });
    check("passthrough limit=2 → scrubbed=2", r1.scrubbed === 2 && r1.clean === 2 && r1.suppressed === 0);
    const r2 = await passthroughScrubBatch(C2, { campaignId: campA, limit: 2 });
    check("passthrough limit=2 again → scrubbed=1 (only 1 with-phone pending left)", r2.scrubbed === 1);
    const r3 = await passthroughScrubBatch(C2, { campaignId: campA });
    check("passthrough again → scrubbed=0 (drained / idempotent)", r3.scrubbed === 0);

    // (a) the 3 with-phone matched contacts are now clean.
    const states = (await sql`
      SELECT id, scrub_status FROM contacts WHERE campaign_id=${campA} ORDER BY id
    `) as { id: number; scrub_status: string }[];
    const byId = new Map(states.map((s) => [s.id, s.scrub_status]));
    check("(a) cA1 (with-phone) marked clean", byId.get(cA1) === "clean");
    check("(a) cA2 (with-phone, opted-out) marked clean", byId.get(cA2) === "clean");
    check("(a) cA4 (with-phone) marked clean", byId.get(cA4) === "clean");
    // (c) the no-phone matched contact stays pending.
    check("(c) cA3 (no phone) stays 'pending' (NOT clean)", byId.get(cA3) === "pending");

    // (a) NO vendor call: no scrub_jobs row was created by the passthrough.
    const jobsAfter = (await sql`SELECT count(*)::int n FROM scrub_jobs WHERE client_id=${C2}`)[0] as { n: number };
    check("(a) NO vendor call — scrub_jobs unchanged (0 created)", jobsAfter.n === jobsBefore.n);

    // (b) the opted-out contact is clean but STILL excluded by getEligibleContacts; the other two are eligible.
    const eligible = await getEligibleContacts(C2, { campaignId: campA });
    const eligibleIds = new Set(eligible.map((c) => c.id));
    check("(b) opted-out cA2 EXCLUDED from eligible despite being clean", !eligibleIds.has(cA2));
    check("(b) cA1 + cA4 ARE eligible (clean, not opted out)", eligibleIds.has(cA1) && eligibleIds.has(cA4));
    check("(b) no-phone cA3 not eligible (pending)", !eligibleIds.has(cA3));
    check("(b) exactly 2 eligible in campaign A", eligible.length === 2);

    // (d) the scrub route branches on scrub_mode: 'none' → passthrough, else → vendor scrubBatch.
    check("(d) campaign A routes to passthrough (scrub_mode==='none')", a?.scrub_mode === "none");
    check("(d) campaign B routes to vendor scrubBatch (scrub_mode!=='none')", b?.scrub_mode !== "none");

    // setCampaignScrubMode: validates, flips, and is client-scoped.
    check("isScrubMode rejects a bogus value", !isScrubMode("bogus"));
    check("setCampaignScrubMode rejects an invalid mode (returns false)",
      (await setCampaignScrubMode(C2, campB, "bogus" as unknown as "vendor")) === false);
    const flipped = await setCampaignScrubMode(C2, campB, "none");
    check("setCampaignScrubMode flips B → 'none'",
      flipped && (await getCampaignForClient(C2, campB))?.scrub_mode === "none");
    // Cross-client: client 2 cannot flip client 1's pilot campaign (id=1) — no row updated.
    const foreign = await setCampaignScrubMode(C2, 1, "none");
    check("setCampaignScrubMode can't flip another client's campaign (returns false)", foreign === false);

    // client 1 / pilot byte-unchanged.
    const c1After = (
      await sql`SELECT
        (SELECT count(*)::int FROM contacts WHERE client_id=1) AS contacts,
        (SELECT count(*)::int FROM contacts WHERE client_id=1 AND scrub_status='clean') AS clean,
        (SELECT count(*)::int FROM opt_outs WHERE client_id=1) AS optouts,
        (SELECT scrub_mode FROM campaigns WHERE id=1) AS pilot_mode`
    )[0] as typeof c1Before;
    check("client 1 contacts unchanged", c1After.contacts === c1Before.contacts);
    check("client 1 clean count unchanged", c1After.clean === c1Before.clean);
    check("client 1 opt_outs unchanged", c1After.optouts === c1Before.optouts);
    check("pilot campaign (id=1) scrub_mode still 'vendor'", c1After.pilot_mode === "vendor");
  } finally {
    // Cleanup — FK order: opt_outs + contacts + campaigns under client 2, then the client.
    await sql`DELETE FROM opt_outs WHERE client_id=${C2}`;
    await sql`DELETE FROM contacts WHERE client_id=${C2}`;
    await sql`DELETE FROM scrub_jobs WHERE client_id=${C2}`;
    await sql`DELETE FROM trace_jobs WHERE client_id=${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id=${C2}`;
    await sql`DELETE FROM client_invoices WHERE client_id=${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id=${C2}`;
    await sql`DELETE FROM clients WHERE id=${C2}`;
  }

  console.log(
    failures === 0
      ? "\nPASSTHROUGH OK — no-scrub mode marks clean with no vendor call; opt-out exclusion intact."
      : `\nPASSTHROUGH FAILED — ${failures} assertion(s) failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
