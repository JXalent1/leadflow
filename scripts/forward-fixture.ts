// scripts/forward-fixture.ts — live-DB acceptance for multi-recipient lead forwarding.
// (Multi-recipient lead forwarding, 2026-06-27)
//
// Exercises the REAL forwardLead against the REAL Neon DB (real markLeadForwarded) with a MOCKED
// sendOne (no Twilio call). Proves:
//   - two recipients → TWO pings + lead forwarded=true;
//   - one fails + one succeeds → still forwarded=true (mark on at-least-one success);
//   - all fail → forwarded=false and the lead stays (forwarded=false in the DB);
//   - a SINGLE recipient → ONE ping + forwarded=true (today's behavior, unchanged).
// Everything created is deleted at the end → the live DB is left pristine. No SMS is sent.
//
// Run: npm run test:forward

import { config } from "dotenv";
import type { ForwardDeps } from "@/lib/forward";
import type { SendResult } from "@/lib/twilio";
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

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql, createLead, markLeadForwarded } = await import("@/lib/db");
  const { forwardLead } = await import("@/lib/forward");
  const { createClient } = await import("@/lib/clients");

  // A mocked sendOne: returns ok per a scripted queue of booleans, recording each recipient.
  function mockSend(results: boolean[]) {
    const calls: string[] = [];
    let i = 0;
    const send: ForwardDeps["send"] = async (to: string) => {
      calls.push(to);
      const ok = results[i++] ?? true;
      return ok
        ? ({ ok: true, sid: `SM_FAKE_${i}`, status: "queued" } as SendResult)
        : ({ ok: false, error: "mock failure", code: 21610 } as SendResult);
    };
    return { send, calls };
  }

  let clientId: number | null = null;
  try {
    const client = await createClient({
      name: "FORWARD-FIXTURE TEST CLIENT",
      from_number: "+13215550188",
      send_rate_per_hour: 60,
    });
    clientId = client.id;

    const campaignId = (
      (await sql`INSERT INTO campaigns (client_id, name) VALUES (${clientId}, 'forward fixture') RETURNING id`)[0] as { id: number }
    ).id;
    const contactId = (
      (await sql`
        INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip,
                              phone, phone_type, skiptrace_status, scrub_status, send_status)
        VALUES (${clientId}, ${campaignId}, 'Pat', 'Lead', '1 Test St', 'Orlando', 'FL', '32801',
                '+14075550000', 'mobile', 'matched', 'clean', 'sent')
        RETURNING id`)[0] as { id: number }
    ).id;

    const contact = {
      id: contactId,
      first_name: "Pat",
      last_name: "Lead",
      address: "1 Test St",
      city: "Orlando",
      state: "FL",
      zip: "32801",
      phone: "+14075550000",
    };
    const sender = { from: "+13215550188" };

    async function freshLead(): Promise<number> {
      return createLead({ clientId: clientId!, contactId, replyText: "yes please send a quote" });
    }
    async function isForwarded(leadId: number): Promise<boolean> {
      const r = (await sql`SELECT forwarded FROM leads WHERE id = ${leadId}`)[0] as { forwarded: boolean };
      return !!r.forwarded;
    }
    const deps = (send: ForwardDeps["send"]): ForwardDeps => ({ send, markForwarded: markLeadForwarded });

    // 1. Two recipients, both succeed → two pings + forwarded=true.
    {
      const leadId = await freshLead();
      const m = mockSend([true, true]);
      const ok = await forwardLead(
        { contact, leadId, replyText: "yes please send a quote" },
        { clientId: clientId!, forwardPhone: "+14075551111, +14075552222", sender },
        deps(m.send)
      );
      check("two recipients: forwardLead returned true", ok === true);
      check("two recipients: sendOne called exactly twice", m.calls.length === 2);
      check("two recipients: lead forwarded=true in DB", await isForwarded(leadId));
    }

    // 2. One fails + one succeeds → still forwarded=true.
    {
      const leadId = await freshLead();
      const m = mockSend([false, true]);
      const ok = await forwardLead(
        { contact, leadId, replyText: "yes please send a quote" },
        { clientId: clientId!, forwardPhone: "+14075551111, +14075552222", sender },
        deps(m.send)
      );
      check("one fail + one success: forwardLead returned true", ok === true);
      check("one fail + one success: both recipients attempted", m.calls.length === 2);
      check("one fail + one success: lead forwarded=true in DB", await isForwarded(leadId));
    }

    // 3. All fail → forwarded=false, lead stays.
    {
      const leadId = await freshLead();
      const m = mockSend([false, false]);
      const ok = await forwardLead(
        { contact, leadId, replyText: "yes please send a quote" },
        { clientId: clientId!, forwardPhone: "+14075551111, +14075552222", sender },
        deps(m.send)
      );
      check("all fail: forwardLead returned false", ok === false);
      check("all fail: both recipients attempted", m.calls.length === 2);
      check("all fail: lead stays forwarded=false in DB", (await isForwarded(leadId)) === false);
    }

    // 4. Single recipient → one ping + forwarded=true (unchanged behavior).
    {
      const leadId = await freshLead();
      const m = mockSend([true]);
      const ok = await forwardLead(
        { contact, leadId, replyText: "yes please send a quote" },
        { clientId: clientId!, forwardPhone: "+14075553333", sender },
        deps(m.send)
      );
      check("single recipient: forwardLead returned true", ok === true);
      check("single recipient: sendOne called exactly once", m.calls.length === 1);
      check("single recipient: lead forwarded=true in DB", await isForwarded(leadId));
    }

    // 5. No forward_phone (non-default client) → no ping, returns false, lead stays.
    {
      const leadId = await freshLead();
      const m = mockSend([]);
      const ok = await forwardLead(
        { contact, leadId, replyText: "yes please send a quote" },
        { clientId: clientId!, forwardPhone: null, sender },
        deps(m.send)
      );
      check("no forward_phone: forwardLead returned false", ok === false);
      check("no forward_phone: sendOne never called", m.calls.length === 0);
      check("no forward_phone: lead stays forwarded=false", (await isForwarded(leadId)) === false);
    }
  } finally {
    if (clientId !== null) {
      await sql`DELETE FROM leads WHERE client_id = ${clientId}`;
      await sql`DELETE FROM contacts WHERE client_id = ${clientId}`;
      await sql`DELETE FROM campaigns WHERE client_id = ${clientId}`;
      await sql`DELETE FROM clients WHERE id = ${clientId}`;
    }
    const strays = (await sql`SELECT count(*)::int n FROM clients WHERE name = 'FORWARD-FIXTURE TEST CLIENT'`)[0] as { n: number };
    check("throwaway client cleaned up (DB pristine)", strays.n === 0);
  }

  console.log(`\n${fail === 0 ? "FORWARD OK" : "FORWARD FAILED"} — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[forward-fixture] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
