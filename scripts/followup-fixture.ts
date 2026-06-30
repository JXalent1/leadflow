// scripts/followup-fixture.ts — proves follow-up / re-engagement campaigns (Build: followup-campaigns).
//
// On a THROWAWAY client (high id) with a source campaign, asserts (NO real sends, NO vendor spend):
//   (1) the audience EXCLUDES responders, leads, opt-outs, not-sent, and no-phone contacts — only
//       sent, clean, non-responding, with-phone contacts are in it.
//   (2) creating the follow-up spends ZERO trace/scrub credits — no Tracerfy/scrub call, and NO
//       trace_jobs / scrub_jobs row is created. The follow-up campaign carries source_campaign_id and
//       scrub_mode='none'; its seeded contacts are skiptrace_status='matched', scrub_status='clean',
//       send_status='not_sent', suppressed=false, phone copied from the source.
//   (3) the seeded contacts run through the EXISTING eligibility path — getEligibleContacts returns
//       exactly them; a STOP landing AFTER seeding both removes a contact from eligibility AND makes
//       claimForSend refuse it (never texts an opted-out contact).
//   (4) NO double-send — claimForSend on a seeded contact succeeds once, then refuses (atomic claim).
//   (5) re-running the audience is IDEMPOTENT — after one follow-up round the same source yields 0
//       (the follow-up cap excludes already-followed-up phones), so no duplicate texts.
// Everything created is cleaned up; client 1 (Talan) is proven unchanged. Exits non-zero on any fail.
//
// Run: npm run test:followup   (requires DATABASE_URL in .env.local)

import { config } from "dotenv";
config({ path: ".env.local" });
config();

// High throwaway id (NOT a low/real client id — see scripts/fixture-safety.ts; 2026-06-27 incident).
const C2 = 900003;
const C2_NAME = "FOLLOWUP TEST CLIENT";
const C2_FROM = "+15005550007";
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql, getEligibleContacts, claimForSend } = await import("@/lib/db");
  const { createCampaign, getCampaignForClient } = await import("@/lib/campaigns");
  const {
    getFollowupAudienceIds,
    getFollowupAudienceCount,
    createFollowupCampaign,
  } = await import("@/lib/followups");

  // Snapshot client 1 so we can prove the fixture didn't touch it.
  const c1Before = (
    await sql`SELECT
      (SELECT count(*)::int FROM contacts WHERE client_id=1) AS contacts,
      (SELECT count(*)::int FROM campaigns WHERE client_id=1) AS campaigns,
      (SELECT count(*)::int FROM opt_outs WHERE client_id=1) AS optouts`
  )[0] as { contacts: number; campaigns: number; optouts: number };

  // SAFETY: refuse to run if C2 is a real client (cleanup deletes ALL client_id=C2 data). Before try.
  const { assertDisposableClientId } = await import("./fixture-safety");
  await assertDisposableClientId(sql, C2, C2_NAME);

  try {
    await sql`
      INSERT INTO clients (id, name, status, plan_amount_cents, lead_guarantee, from_number, send_rate_per_hour)
      VALUES (${C2}, ${C2_NAME}, 'active', 250000, 50, ${C2_FROM}, 60)
      ON CONFLICT (id) DO NOTHING
    `;

    // Source campaign with a mix of contacts.
    const source = await createCampaign(C2, "source camp");

    async function addContact(
      camp: number,
      phone: string | null,
      sendStatus: string
    ): Promise<number> {
      const r = (await sql`
        INSERT INTO contacts (client_id, campaign_id, first_name, address, phone, phone_type,
                              skiptrace_status, scrub_status, send_status)
        VALUES (${C2}, ${camp}, 'Pat', '1 Test St', ${phone}, 'mobile', 'matched', 'clean', ${sendStatus})
        RETURNING id`)[0] as { id: number };
      return r.id;
    }

    const rSent1 = await addContact(source, "8005551001", "sent"); // non-responder → IN
    const rSent2 = await addContact(source, "8005551002", "sent"); // non-responder → IN
    const rSent3 = await addContact(source, "8005551007", "sent"); // non-responder → IN
    const rReplied = await addContact(source, "8005551003", "sent"); // replied → OUT
    const rLead = await addContact(source, "8005551004", "sent"); // lead → OUT
    const rOptedOut = await addContact(source, "8005551005", "sent"); // opted out → OUT
    const rNotSent = await addContact(source, "8005551006", "not_sent"); // never sent → OUT
    const rNoPhone = await addContact(source, null, "sent"); // no phone → OUT

    // Facts that drive the exclusions.
    await sql`INSERT INTO messages (client_id, contact_id, direction, body, twilio_sid)
              VALUES (${C2}, ${rReplied}, 'inbound', 'how much?', 'SMfollowuptest1')`;
    await sql`INSERT INTO leads (client_id, contact_id, reply_text) VALUES (${C2}, ${rLead}, 'yes interested')`;
    await sql`INSERT INTO opt_outs (client_id, contact_id, phone) VALUES (${C2}, ${rOptedOut}, '8005551005')`;

    // Baselines: no trace_jobs / scrub_jobs for C2 (creating a follow-up must never create any).
    const jobsBefore = (
      await sql`SELECT
        (SELECT count(*)::int FROM trace_jobs WHERE client_id=${C2}) AS trace,
        (SELECT count(*)::int FROM scrub_jobs WHERE client_id=${C2}) AS scrub`
    )[0] as { trace: number; scrub: number };

    // (1) audience = exactly the three sent, with-phone, non-responding contacts.
    const ids = await getFollowupAudienceIds(C2, source);
    const idSet = new Set(ids);
    check("(1) audience count = 3", ids.length === 3);
    check("(1) includes the three non-responders", idSet.has(rSent1) && idSet.has(rSent2) && idSet.has(rSent3));
    check("(1) excludes the responder", !idSet.has(rReplied));
    check("(1) excludes the lead", !idSet.has(rLead));
    check("(1) excludes the opted-out", !idSet.has(rOptedOut));
    check("(1) excludes the not-sent", !idSet.has(rNotSent));
    check("(1) excludes the no-phone", !idSet.has(rNoPhone));
    check("(1) getFollowupAudienceCount agrees", (await getFollowupAudienceCount(C2, source)) === 3);

    // (2) create the follow-up — zero vendor spend, seeded send-ready.
    const { campaignId: followupId, seeded } = await createFollowupCampaign(C2, source, {
      messageTemplate: "Hi [NAME], following up.",
    });
    check("(2) seeded = 3", seeded === 3);

    const fu = await getCampaignForClient(C2, followupId);
    check("(2) follow-up campaign carries source_campaign_id", fu?.source_campaign_id === source);
    check("(2) follow-up campaign scrub_mode = 'none'", fu?.scrub_mode === "none");

    const jobsAfter = (
      await sql`SELECT
        (SELECT count(*)::int FROM trace_jobs WHERE client_id=${C2}) AS trace,
        (SELECT count(*)::int FROM scrub_jobs WHERE client_id=${C2}) AS scrub`
    )[0] as { trace: number; scrub: number };
    check(
      "(2) ZERO trace/scrub spend — no trace_jobs/scrub_jobs created",
      jobsAfter.trace === jobsBefore.trace && jobsAfter.scrub === jobsBefore.scrub
    );

    const seededRows = (await sql`
      SELECT id, phone, skiptrace_status, scrub_status, send_status, suppressed
      FROM contacts WHERE campaign_id=${followupId} ORDER BY id
    `) as {
      id: number;
      phone: string;
      skiptrace_status: string;
      scrub_status: string;
      send_status: string;
      suppressed: boolean;
    }[];
    check("(2) seeded rows are matched+clean+not_sent+not-suppressed, with phone", seededRows.every(
      (r) =>
        r.skiptrace_status === "matched" &&
        r.scrub_status === "clean" &&
        r.send_status === "not_sent" &&
        r.suppressed === false &&
        !!r.phone
    ));
    const seededPhones = new Set(seededRows.map((r) => r.phone));
    check("(2) seeded phones copied from the source non-responders",
      seededPhones.has("8005551001") && seededPhones.has("8005551002") && seededPhones.has("8005551007"));

    const seededA = seededRows.find((r) => r.phone === "8005551001")!; // → opt out after seed
    const seededB = seededRows.find((r) => r.phone === "8005551002")!; // → reply after seed (HIGH fix)
    const seededC = seededRows.find((r) => r.phone === "8005551007")!; // → clean, for no-double-send

    // (3) the seeded contacts go through the EXISTING eligibility path. The send route passes
    // followUp:true for a follow-up campaign, which ALSO re-checks opt-out + replied + lead each batch.
    let eligible = await getEligibleContacts(C2, { campaignId: followupId, followUp: true });
    check("(3) all three seeded contacts are eligible to send", eligible.length === 3);

    // (3a) a STOP landing AFTER seeding → excluded + un-claimable (opt-out is checked regardless).
    await sql`INSERT INTO opt_outs (client_id, contact_id, phone) VALUES (${C2}, ${seededA.id}, '8005551001')
              ON CONFLICT (client_id, phone) DO NOTHING`;
    check("(3a) claimForSend REFUSES the opted-out seeded contact", (await claimForSend(C2, seededA.id, true)) === false);

    // (3b) a REPLY landing AFTER seeding (the review HIGH fix): without followUp the base path would
    // still text it (proving the gap), but the follow-up send (followUp:true) excludes + refuses it.
    await sql`INSERT INTO messages (client_id, contact_id, direction, body, twilio_sid)
              VALUES (${C2}, ${seededB.id}, 'inbound', 'actually yes', 'SMfollowuptest2')`;
    const baseEligible = await getEligibleContacts(C2, { campaignId: followupId }); // followUp defaults false
    check("(3b) base eligibility (no followUp) STILL includes the since-replied contact (the gap)",
      baseEligible.some((c) => c.id === seededB.id));
    const fuEligible = await getEligibleContacts(C2, { campaignId: followupId, followUp: true });
    check("(3b) follow-up eligibility EXCLUDES the since-replied contact (fix)",
      !fuEligible.some((c) => c.id === seededB.id));
    check("(3b) claimForSend(followUp) REFUSES the since-replied contact", (await claimForSend(C2, seededB.id, true)) === false);

    // (3c) only the clean seeded contact remains eligible for the follow-up.
    eligible = await getEligibleContacts(C2, { campaignId: followupId, followUp: true });
    check("(3c) exactly the clean seeded contact is eligible", eligible.length === 1 && eligible[0].id === seededC.id);

    // (4) no double-send: claim the clean seeded contact once → true, again → false.
    check("(4) claimForSend succeeds once", (await claimForSend(C2, seededC.id, true)) === true);
    check("(4) claimForSend refuses the second claim (no double-send)", (await claimForSend(C2, seededC.id, true)) === false);

    // (5) idempotency: re-running the audience for the source now yields 0 (cap: already followed up).
    const afterCount = await getFollowupAudienceCount(C2, source);
    check("(5) re-running the audience is idempotent (0 after one round, default cap=1)", afterCount === 0);
    const afterRound2 = await createFollowupCampaign(C2, source, {});
    check("(5) a second create seeds 0 (no duplicate texts)", afterRound2.seeded === 0);

    // client 1 unchanged.
    const c1After = (
      await sql`SELECT
        (SELECT count(*)::int FROM contacts WHERE client_id=1) AS contacts,
        (SELECT count(*)::int FROM campaigns WHERE client_id=1) AS campaigns,
        (SELECT count(*)::int FROM opt_outs WHERE client_id=1) AS optouts`
    )[0] as typeof c1Before;
    check("client 1 contacts unchanged", c1After.contacts === c1Before.contacts);
    check("client 1 campaigns unchanged", c1After.campaigns === c1Before.campaigns);
    check("client 1 opt_outs unchanged", c1After.optouts === c1Before.optouts);
  } finally {
    // Cleanup — FK order. leads/messages/opt_outs reference contacts; contacts reference campaigns.
    await sql`DELETE FROM leads WHERE client_id=${C2}`;
    await sql`DELETE FROM messages WHERE client_id=${C2}`;
    await sql`DELETE FROM opt_outs WHERE client_id=${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id=${C2}`;
    await sql`DELETE FROM contacts WHERE client_id=${C2}`;
    await sql`DELETE FROM scrub_jobs WHERE client_id=${C2}`;
    await sql`DELETE FROM trace_jobs WHERE client_id=${C2}`;
    await sql`DELETE FROM client_invoices WHERE client_id=${C2}`;
    // source_campaign_id is a self-FK on campaigns; clear it before deleting so order can't trip the FK.
    await sql`UPDATE campaigns SET source_campaign_id = NULL WHERE client_id=${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id=${C2}`;
    await sql`DELETE FROM clients WHERE id=${C2}`;
  }

  console.log(
    failures === 0
      ? "\nFOLLOWUP OK — audience excludes responders/leads/opt-outs; zero trace/scrub spend; no double-send; idempotent."
      : `\nFOLLOWUP FAILED — ${failures} assertion(s) failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
