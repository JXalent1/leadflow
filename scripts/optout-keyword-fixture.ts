// scripts/optout-keyword-fixture.ts — live-DB acceptance for the per-client opt-out keyword.
// (2nd-client onboarding, 2026-06-27)
//
// Proves, against the REAL Neon DB and through the REAL inbound decision core (processInbound) wired
// to the REAL db deps (exactly as the webhook does), that:
//   - a throwaway client with optout_keyword='2' suppresses on an inbound "2" (opt_outs row + contact
//     suppressed), with the SAME precedence as STOP;
//   - "STOP" still suppresses (the keyword is additive, never a replacement);
//   - "2 services please" does NOT suppress (exact whole-body match only);
//   - a client with optout_keyword=NULL (Talan's config) does NOT suppress on "2";
//   - Talan (client 1) really is optout_keyword=NULL after the migration (byte-unchanged).
//
// Everything created here is deleted at the end → the live DB is left pristine. No SMS is sent (the
// opt-out path never calls forwardLead; we stub it to throw if it ever does).
//
// Run: npm run test:optout

import { config } from "dotenv";
config({ path: ".env.local" });
config();

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`✓  ${label}`);
  } else {
    fail++;
    console.error(`✗  ${label}`);
  }
}

const TEST_FROM = "+13215550199"; // the throwaway client's campaign number (distinct from Talan)

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql } = await import("@/lib/db");
  const {
    findContactByPhone,
    logInboundOnce,
    recordOptOut,
    markSuppressed,
    recordMessage,
    createLead,
  } = await import("@/lib/db");
  const { processInbound } = await import("@/lib/inbound");
  const { createClient, getClientById, getClientByInboundNumber, clientBizName, clientOptOutInstruction } =
    await import("@/lib/clients");
  const { normalizePhone } = await import("@/lib/tracerfy");

  // Build client-scoped deps exactly like the webhook's buildDeps (forwardLead stubbed to throw —
  // the opt-out path must never reach it).
  function deps(clientId: number) {
    return {
      findContactByPhone: (phone: string) => findContactByPhone(clientId, phone) as never,
      logInboundOnce: (a: { contactId: number | null; body: string; twilioSid: string }) =>
        logInboundOnce({ clientId, ...a }),
      recordOptOut: (contactId: number | null, phone: string) => recordOptOut(clientId, contactId, phone),
      markSuppressed: (contactId: number, reason: string) => markSuppressed(clientId, contactId, reason),
      recordOutbound: async (a: { contactId: number | null; body: string; status: string }) => {
        await recordMessage({ clientId, contactId: a.contactId, direction: "outbound", body: a.body, status: a.status });
      },
      createLead: (a: { contactId: number; replyText: string }) => createLead({ clientId, ...a }),
      forwardLead: async () => {
        throw new Error("forwardLead must NOT be called on an opt-out");
      },
    };
  }

  let clientId: number | null = null;
  try {
    // --- Talan (client 1) is untouched: optout_keyword stays NULL ---------------------------------
    const talan = await getClientById(1);
    check("client 1 (Talan) optout_keyword is NULL (STOP-only, byte-unchanged)", !!talan && talan.optout_keyword === null);

    // --- Create a throwaway client with optout_keyword='2' ----------------------------------------
    const client = await createClient({
      name: "OPTOUT-KW TEST CLIENT",
      from_number: TEST_FROM,
      forward_phone: TEST_FROM,
      optout_keyword: "2",
      message_template:
        'Hey [NAME], crew working near [ADDRESS] — free quote on pressure washing? Reply "2" to opt out',
      send_rate_per_hour: 60,
      optout_confirmation: "You're unsubscribed. Reply HELP for help.",
    });
    clientId = client.id;
    check("createClient persisted optout_keyword='2'", client.optout_keyword === "2");
    check(
      'clientOptOutInstruction derives Reply "2" to opt out',
      clientOptOutInstruction(client) === 'Reply "2" to opt out'
    );

    // Routing: the webhook resolves this client by its inbound (To) number.
    const resolved = await getClientByInboundNumber(TEST_FROM);
    check("getClientByInboundNumber(TEST_FROM) resolves the throwaway client", resolved?.id === client.id);
    check("resolved client carries optout_keyword='2'", resolved?.optout_keyword === "2");

    // A campaign to hold the contacts (campaign_id is NOT NULL on contacts).
    const campaignId = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${clientId}, 'optout-kw fixture') RETURNING id`)[0] as { id: number }
    ).id;

    async function makeContact(phone: string): Promise<number> {
      const rows = await sql`
        INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip,
                              phone, phone_type, skiptrace_status, scrub_status, send_status)
        VALUES (${clientId}, ${campaignId}, 'Pat', 'Test', '1 Test St', 'Orlando', 'FL', '32801',
                ${phone}, 'mobile', 'matched', 'clean', 'not_sent')
        RETURNING id
      `;
      return (rows[0] as { id: number }).id;
    }

    async function isSuppressed(id: number): Promise<boolean> {
      const r = (await sql`SELECT suppressed FROM contacts WHERE id = ${id}`)[0] as { suppressed: boolean };
      return !!r.suppressed;
    }
    async function optOutCount(phone: string): Promise<number> {
      const norm = phone.replace(/[^0-9]/g, "").slice(-10);
      const r = (await sql`SELECT count(*)::int n FROM opt_outs WHERE client_id = ${clientId} AND phone = ${norm}`)[0] as { n: number };
      return r.n;
    }

    const opts = {
      bizName: clientBizName(client),
      emitConfirmation: true,
      optOutConfirmation: client.optout_confirmation ?? undefined,
      optOutKeyword: client.optout_keyword,
    };

    // 1. Inbound "2" → opt-out + suppress.
    const p1 = "+14075550001";
    const id1 = await makeContact(p1);
    const out1 = await processInbound({ fromPhone: normalizePhone(p1), body: "2", messageSid: "SM_OPTKW_2" }, deps(clientId) as never, opts);
    check('inbound "2" → outcome kind=opt_out', out1.kind === "opt_out");
    check('inbound "2" → contact suppressed', await isSuppressed(id1));
    check('inbound "2" → opt_outs row recorded', (await optOutCount(p1)) === 1);

    // 2. Inbound "STOP" → opt-out + suppress (always, additive).
    const p2 = "+14075550002";
    const id2 = await makeContact(p2);
    const out2 = await processInbound({ fromPhone: normalizePhone(p2), body: "STOP", messageSid: "SM_OPTKW_STOP" }, deps(clientId) as never, opts);
    check('inbound "STOP" → outcome kind=opt_out', out2.kind === "opt_out");
    check('inbound "STOP" → contact suppressed', await isSuppressed(id2));

    // 3. Inbound "2 services please" → NOT an opt-out (exact whole-body match only).
    const p3 = "+14075550003";
    const id3 = await makeContact(p3);
    const out3 = await processInbound({ fromPhone: normalizePhone(p3), body: "2 services please", messageSid: "SM_OPTKW_SVC" }, deps(clientId) as never, opts);
    check('inbound "2 services please" → NOT opt_out', out3.kind !== "opt_out");
    check('inbound "2 services please" → contact NOT suppressed', !(await isSuppressed(id3)));
    check('inbound "2 services please" → no opt_outs row', (await optOutCount(p3)) === 0);

    // 4. STOP-only config (optOutKeyword=null, like Talan) → "2" does NOT opt out.
    const p4 = "+14075550004";
    const id4 = await makeContact(p4);
    const out4 = await processInbound(
      { fromPhone: normalizePhone(p4), body: "2", messageSid: "SM_OPTKW_NULL" },
      deps(clientId) as never,
      { ...opts, optOutKeyword: null }
    );
    check('STOP-only config: inbound "2" → NOT opt_out', out4.kind !== "opt_out");
    check('STOP-only config: inbound "2" → contact NOT suppressed', !(await isSuppressed(id4)));
  } finally {
    // --- Cleanup: delete everything we created, in FK order → DB pristine -------------------------
    if (clientId !== null) {
      await sql`DELETE FROM opt_outs WHERE client_id = ${clientId}`;
      await sql`DELETE FROM messages WHERE client_id = ${clientId}`;
      await sql`DELETE FROM leads WHERE client_id = ${clientId}`;
      await sql`DELETE FROM contacts WHERE client_id = ${clientId}`;
      await sql`DELETE FROM campaigns WHERE client_id = ${clientId}`;
      await sql`DELETE FROM clients WHERE id = ${clientId}`;
    }
    const strays = (await sql`SELECT count(*)::int n FROM clients WHERE name = 'OPTOUT-KW TEST CLIENT'`)[0] as { n: number };
    check("throwaway client cleaned up (DB pristine)", strays.n === 0);
  }

  console.log(`\n${fail === 0 ? "OPTOUT-KEYWORD OK" : "OPTOUT-KEYWORD FAILED"} — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[optout-keyword-fixture] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
