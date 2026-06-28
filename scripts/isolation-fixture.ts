// scripts/isolation-fixture.ts — proves multi-tenant isolation (v2 Module V1 acceptance).
//
// Creates a temporary client #2 with its own contact, opt-out, inbound message + lead, then
// asserts through the REAL lib helpers that:
//   1. Eligibility / inbox / suppression / contact-lookup never cross clients (both directions).
//   2. The inbound webhook routes strictly by the To number → owning client, and processing an
//      inbound to client 2's number writes ONLY client 2's data (client 1 untouched).
//   3. Config is read from the client record: changing client 1's message_template changes what
//      renderMessage produces for client 1 ONLY (client 2 unchanged).
// Everything it creates is cleaned up at the end (and client 1's template is restored), so it is
// safe to re-run. Exits non-zero on any failed assertion.
//
// Run: npm run test:isolation

import { config } from "dotenv";
config({ path: ".env.local" });
config();

// High throwaway id (NOT a low/real client id — see scripts/fixture-safety.ts; 2026-06-27 incident).
const C2 = 900002;
const C2_NAME = "ISOLATION TEST CLIENT";
const C2_FROM = "+15005550006"; // client 2's campaign number (not client 1's +18508213720)
const C2_PHONE = "9995551234"; // a client-2 contact phone (last-10)
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql } = await import("@/lib/db");
  const {
    getEligibleContacts,
    findContactByPhone,
    recordOptOut,
    markSuppressed,
    logInboundOnce,
    createLead,
  } = await import("@/lib/db");
  const { getInboxThreads, isPhoneOptedOut } = await import("@/lib/inbox-db");
  const { getClientById, getClientByInboundNumber } = await import("@/lib/clients");
  const { resolveCampaignForClient } = await import("@/lib/campaigns");
  const { renderMessage } = await import("@/lib/sms");
  const { processInbound } = await import("@/lib/inbound");

  // --- snapshot client 1's pre-fixture state so we can prove "unchanged" + restore template ---
  const c1Before = await getClientById(1);
  if (!c1Before) throw new Error("client 1 (Talan) missing — run npm run schema first.");
  const c1TemplateOrig = c1Before.message_template;
  const c1EligibleBefore = (await getEligibleContacts(1)).length;
  const c1InboxBefore = (await getInboxThreads(1)).length;
  const c1OptOutsBefore = (await sql`SELECT count(*)::int n FROM opt_outs WHERE client_id=1`)[0] as { n: number };
  const c1MsgsBefore = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=1`)[0] as { n: number };

  // SAFETY: refuse to run if C2 is a real client (its cleanup deletes ALL client_id=C2 data).
  // Must run BEFORE the try/finally so a guard failure can never reach the cleanup deletes.
  const { assertDisposableClientId } = await import("./fixture-safety");
  await assertDisposableClientId(sql, C2, C2_NAME);

  try {
    // --- create client 2 + its data ---------------------------------------------------------
    await sql`
      INSERT INTO clients (id, name, from_number, message_template, forward_phone,
                           send_rate_per_hour, optout_confirmation)
      VALUES (${C2}, ${C2_NAME}, ${C2_FROM},
              'Yo [NAME], different copy entirely. Reply STOP to opt out.', ${C2_FROM},
              60, 'Client2 opt-out confirmation.')
      ON CONFLICT (id) DO NOTHING
    `;
    // Two client-2 campaigns: "A" holds the opted-out contact; "B" is a brand-new campaign used
    // for the client-level-suppression-by-phone check below.
    const c2CampA = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${C2}, 'iso c2 campaign A') RETURNING id`)[0] as { id: number }
    ).id;
    const c2CampB = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${C2}, 'iso c2 campaign B') RETURNING id`)[0] as { id: number }
    ).id;
    // A client-2 contact that is fully eligible (phone, scrubbed clean, not sent), in campaign A.
    const c2ContactRows = await sql`
      INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip,
                            phone, phone_type, skiptrace_status, scrub_status, send_status)
      VALUES (${C2}, ${c2CampA}, 'Casey', 'Two', '900 Other St', 'Tallahassee', 'FL', '32301',
              ${C2_PHONE}, 'mobile', 'matched', 'clean', 'not_sent')
      RETURNING id
    `;
    const c2ContactId = (c2ContactRows[0] as { id: number }).id;
    // A client-2 opt-out + inbound + lead (so the inbox/suppression checks have data).
    await recordOptOut(C2, c2ContactId, C2_PHONE);
    await markSuppressed(C2, c2ContactId, "opt_out");
    await logInboundOnce({ clientId: C2, contactId: c2ContactId, body: "hi", twilioSid: "SM_ISO_C2" });
    await createLead({ clientId: C2, contactId: c2ContactId, replyText: "interested" });

    // === 1. Eligibility never crosses clients ===
    const elig1 = await getEligibleContacts(1);
    const elig2 = await getEligibleContacts(C2);
    check("getEligibleContacts(1) excludes the client-2 contact", !elig1.some((c) => c.id === c2ContactId));
    check("getEligibleContacts(1) only returns client_id=1 rows", elig1.every((c) => c.client_id === 1));
    // The client-2 contact is suppressed (we opted it out), so it isn't eligible for client 2 either —
    // prove the scope instead: every client-2 eligible row is client 2's.
    check("getEligibleContacts(C2) only returns client-2 rows", elig2.every((c) => c.client_id === C2));

    // === 1b. CLIENT-LEVEL suppression by phone (v2 V2, LOAD-BEARING) ===
    // A person who opted out under ANY of a client's campaigns must be excluded from EVERY
    // campaign — even a brand-new contact row in a new campaign with the same number and its own
    // suppressed=false flag. C2_PHONE opted out in campaign A; insert a FRESH, never-flagged,
    // scrubbed-clean contact with that same phone into campaign B and prove it is NOT eligible.
    const dupRows = await sql`
      INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip,
                            phone, phone_type, skiptrace_status, scrub_status, send_status, suppressed)
      VALUES (${C2}, ${c2CampB}, 'Dupe', 'Phone', '111 New Campaign Rd', 'Tallahassee', 'FL', '32301',
              ${C2_PHONE}, 'mobile', 'matched', 'clean', 'not_sent', false)
      RETURNING id
    `;
    const dupContactId = (dupRows[0] as { id: number }).id;
    // A control: a fresh contact in campaign B whose phone was NEVER opted out → must be eligible.
    const FRESH_PHONE = "9995550000";
    const freshRows = await sql`
      INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip,
                            phone, phone_type, skiptrace_status, scrub_status, send_status, suppressed)
      VALUES (${C2}, ${c2CampB}, 'Fresh', 'Lead', '222 New Campaign Rd', 'Tallahassee', 'FL', '32301',
              ${FRESH_PHONE}, 'mobile', 'matched', 'clean', 'not_sent', false)
      RETURNING id
    `;
    const freshContactId = (freshRows[0] as { id: number }).id;

    const campBEligible = await getEligibleContacts(C2, { campaignId: c2CampB });
    check(
      "a fresh contact in a NEW campaign with an opted-out phone is EXCLUDED (client-level suppression)",
      !campBEligible.some((c) => c.id === dupContactId)
    );
    check(
      "...and its suppressed flag is still false (proof the exclusion is by opt_outs, not the row flag)",
      ((await sql`SELECT suppressed FROM contacts WHERE id = ${dupContactId}`)[0] as { suppressed: boolean }).suppressed === false
    );
    check(
      "a fresh contact with a never-opted-out phone IS eligible in the new campaign (control)",
      campBEligible.some((c) => c.id === freshContactId)
    );
    // And the dup is excluded from a client-WIDE eligibility too (not just campaign B).
    check(
      "the opted-out phone is excluded from client-wide eligibility as well",
      !(await getEligibleContacts(C2)).some((c) => c.id === dupContactId)
    );

    // === 1c. resolveCampaignForClient never reaches another client's campaign (v2 V2 review) ===
    // Asking for client 1 while passing a client-2 campaign id must FALL BACK to client 1's own
    // default campaign (campaign 1 = pilot), never return the client-2 campaign.
    const crossResolve = await resolveCampaignForClient(1, c2CampA);
    check(
      "resolveCampaignForClient(client 1, client-2 campaign id) falls back to client 1's campaign 1",
      crossResolve?.id === 1 && crossResolve?.client_id === 1
    );
    // And resolving within client 2 for a valid client-2 campaign returns exactly that campaign.
    const c2Resolve = await resolveCampaignForClient(C2, c2CampB);
    check(
      "resolveCampaignForClient(client 2, its own campaign) returns that campaign",
      c2Resolve?.id === c2CampB && c2Resolve?.client_id === C2
    );

    // === 2. Inbox never crosses clients ===
    const inbox1 = await getInboxThreads(1);
    const inbox2 = await getInboxThreads(C2);
    check("getInboxThreads(1) excludes the client-2 contact", !inbox1.some((t) => t.id === c2ContactId));
    check("getInboxThreads(2) includes ONLY the client-2 contact", inbox2.length === 1 && inbox2[0].id === c2ContactId);

    // === 3. Suppression / opt-out never crosses clients ===
    check("isPhoneOptedOut(C2, c2phone) = true (client 2 owns the opt-out)", (await isPhoneOptedOut(C2, C2_PHONE)) === true);
    check("isPhoneOptedOut(1, c2phone) = false (client 1 must NOT see client 2's opt-out)", (await isPhoneOptedOut(1, C2_PHONE)) === false);

    // === 4. Contact lookup never crosses clients ===
    check("findContactByPhone(C2, c2phone) finds the client-2 contact", (await findContactByPhone(C2, C2_PHONE))?.id === c2ContactId);
    check("findContactByPhone(1, c2phone) = null (client 1 can't see client 2's contact)", (await findContactByPhone(1, C2_PHONE)) === null);

    // === 5. Webhook routes strictly by To → owning client ===
    const byC2 = await getClientByInboundNumber(C2_FROM);
    const byC1 = await getClientByInboundNumber("+18508213720");
    check("getClientByInboundNumber(client2 number) → client 2", byC2?.id === C2);
    check("getClientByInboundNumber(client1 number) → client 1", byC1?.id === 1);
    check("getClientByInboundNumber(unknown number) → null (rejected)", (await getClientByInboundNumber("+19998887777")) === null);

    // === 6. Processing an inbound to client 2's number writes ONLY client 2 ===
    // Build client-2-scoped deps the same way the route does, then send a fresh interested reply
    // from a NEW number we don't have a contact for under EITHER client, and confirm it lands as a
    // client-2 orphan log and never creates a client-1 row.
    const ORPHAN = "9995559999";
    const deps = {
      findContactByPhone: (p: string) => findContactByPhone(C2, p) as any,
      logInboundOnce: (a: any) => logInboundOnce({ clientId: C2, ...a }),
      recordOptOut: (cid: number | null, p: string) => recordOptOut(C2, cid, p),
      markSuppressed: (cid: number, r: string) => markSuppressed(C2, cid, r),
      recordOutbound: async () => {},
      createLead: (a: any) => createLead({ clientId: C2, ...a }),
      forwardLead: async () => true,
    };
    await processInbound(
      { fromPhone: ORPHAN, body: "STOP", messageSid: "SM_ISO_ORPHAN" },
      deps as any,
      { bizName: "x", emitConfirmation: false }
    );
    const orphanInC2 = (await sql`SELECT count(*)::int n FROM opt_outs WHERE client_id=${C2} AND phone=${ORPHAN}`)[0] as { n: number };
    const orphanInC1 = (await sql`SELECT count(*)::int n FROM opt_outs WHERE client_id=1 AND phone=${ORPHAN}`)[0] as { n: number };
    check("an inbound STOP to client 2's number records the opt-out under client 2", orphanInC2.n === 1);
    check("...and creates NO opt-out under client 1", orphanInC1.n === 0);

    // === 7. Config from the client record: template change affects client 1 ONLY ===
    const sampleContact = { firstName: "James", zip: "32301", address: "123 Main St" };
    const c1RenderOrig = renderMessage((await getClientById(1))!.message_template ?? "", sampleContact);
    const c2Render = renderMessage((await getClientById(C2))!.message_template ?? "", sampleContact);
    check("client 1 and client 2 render DIFFERENT copy from their own templates", c1RenderOrig !== c2Render);
    // Change client 1's template in the DB, reload, re-render — output must change for client 1...
    await sql`UPDATE clients SET message_template = 'CHANGED [NAME] copy. Reply STOP to opt out.' WHERE id = 1`;
    const c1RenderAfter = renderMessage((await getClientById(1))!.message_template ?? "", sampleContact);
    const c2RenderAfter = renderMessage((await getClientById(C2))!.message_template ?? "", sampleContact);
    check("changing client 1's message_template changes renderMessage for client 1", c1RenderAfter !== c1RenderOrig && c1RenderAfter.startsWith("CHANGED James copy."));
    check("...and does NOT change client 2's render", c2RenderAfter === c2Render);
  } finally {
    // --- cleanup: restore client 1's template + remove ALL client-2 fixture data -------------
    await sql`UPDATE clients SET message_template = ${c1TemplateOrig} WHERE id = 1`;
    await sql`DELETE FROM client_invoices WHERE client_id = ${C2}`;
    await sql`DELETE FROM leads WHERE client_id = ${C2}`;
    await sql`DELETE FROM opt_outs WHERE client_id = ${C2}`;
    await sql`DELETE FROM messages WHERE client_id = ${C2}`;
    await sql`DELETE FROM contacts WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id = ${C2}`;
    await sql`DELETE FROM trace_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM scrub_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id = ${C2}`;
    await sql`DELETE FROM clients WHERE id = ${C2}`;
  }

  // --- prove client 1 is byte-for-byte unchanged by the whole fixture ---
  const c1After = await getClientById(1);
  check("client 1 message_template restored exactly", (c1After?.message_template ?? null) === c1TemplateOrig);
  check("client 1 eligible count unchanged", (await getEligibleContacts(1)).length === c1EligibleBefore);
  check("client 1 inbox count unchanged", (await getInboxThreads(1)).length === c1InboxBefore);
  const c1OptOutsAfter = (await sql`SELECT count(*)::int n FROM opt_outs WHERE client_id=1`)[0] as { n: number };
  const c1MsgsAfter = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=1`)[0] as { n: number };
  check("client 1 opt_outs count unchanged", c1OptOutsAfter.n === c1OptOutsBefore.n);
  check("client 1 messages count unchanged", c1MsgsAfter.n === c1MsgsBefore.n);

  console.log(failures === 0 ? "\nISOLATION OK — all assertions passed." : `\nISOLATION FAILED — ${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[isolation] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
