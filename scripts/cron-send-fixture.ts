// scripts/cron-send-fixture.ts — proves the SERVER-SIDE sender (2026-06-30 acceptance).
//
// Drives the REAL drain endpoint (app/api/cron/send GET) — no browser — and asserts, THROUGH the
// shared send path it shares with /api/campaign (getEligibleContacts + the atomic claimForSend +
// the send-window gate):
//   1. AUTH: a request with no CRON_SECRET → 401; a wrong secret → 401. The endpoint is not
//      publicly triggerable.
//   2. ONE CALL ≤ ONE BATCH: each cron tick attempts at most cronBatchSize(rate) contacts.
//   3. DRAIN + CLOSE: repeated ticks drain the eligible set to completion, close the run
//      (finished_at set), and clear auto_send so the campaign stops being driven.
//   4. SUPPRESSION HOLDS: an opted-out contact is NEVER texted (stays not_sent, 0 messages).
//   5. NO DOUBLE-SEND: every eligible contact gets EXACTLY ONE outbound message — even when two
//      ticks run CONCURRENTLY (the atomic claim is the guarantee).
//   6. WINDOW: with the send window closed, a tick sends NOTHING and leaves auto_send ON (resumes).
//
// Sends use Twilio MAGIC numbers (+1500555xxxx) so nothing real is delivered regardless of creds;
// with no/live creds sendOne simply returns a typed failure and the contact is marked terminal —
// the no-double-send / drain / suppression invariants hold either way. Everything is cleaned up and
// client 1 (Talan) is proven untouched. Exits non-zero on any failure.
//
// Run: npm run test:cron

import { config } from "dotenv";
config({ path: ".env.local" });
config();

// CRON_SECRET must be set BEFORE the route reads it (it reads at request time, so setting it here is
// fine). Force a known value so the auth assertions are deterministic regardless of the .env.
process.env.CRON_SECRET = "test-cron-secret-cron-fixture";
const SECRET = process.env.CRON_SECRET;

// High throwaway id (NOT a low/real client id — see scripts/fixture-safety.ts; 2026-06-27 incident).
const C2 = 900030;
const C2_NAME = "CRON-SEND TEST CLIENT";
const C2_FROM = "+15005550006"; // Twilio magic "valid sender"
const RATE = 60; // → cronBatchSize(60) = 1, so each tick sends ≤ 1 and draining needs several ticks
const CRON_URL = "http://localhost/api/cron/send";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local).");

  const { sql } = await import("@/lib/db");
  const { cronBatchSize } = await import("@/lib/pipeline");
  const route = await import("@/app/api/cron/send/route");

  const callCron = async (secret?: string) => {
    const headers: Record<string, string> = {};
    if (secret !== undefined) headers["authorization"] = `Bearer ${secret}`;
    const res = await route.GET(new Request(CRON_URL, { method: "GET", headers }));
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  };

  // Magic eligible phones + one opted-out (last-10-digit suppression).
  const ELIGIBLE = ["+15005550010", "+15005550011", "+15005550012", "+15005550013"];
  const OPTED_OUT = "+15005559999";
  const N = ELIGIBLE.length;

  const c1MsgBefore = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=1`)[0] as { n: number };

  const { assertDisposableClientId } = await import("./fixture-safety");
  await assertDisposableClientId(sql, C2, C2_NAME);

  // Helper: reset all C2 contacts to a fresh not_sent state + wipe their messages + reopen the run.
  const resetForRun = async (startHour: number, endHour: number) => {
    await sql`DELETE FROM messages WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id = ${C2}`;
    await sql`UPDATE contacts SET send_status = 'not_sent', variant = NULL WHERE client_id = ${C2}`;
    await sql`UPDATE campaigns SET auto_send = true WHERE client_id = ${C2}`;
    await sql`UPDATE clients SET send_window_start_hour = ${startHour}, send_window_end_hour = ${endHour} WHERE id = ${C2}`;
  };

  try {
    // ---- AUTH (no DB needed) ------------------------------------------------------------
    const noAuth = await callCron(undefined);
    check("1. cron with NO secret → 401 (not publicly triggerable)", noAuth.status === 401);
    const badAuth = await callCron("wrong-secret");
    check("1. cron with WRONG secret → 401", badAuth.status === 401);

    // ---- Seed client 2: active, high target (never met), one always-open campaign -------
    // Window [0,24) is open at every hour; lead_target null + huge guarantee → target never met.
    await sql`
      INSERT INTO clients (id, name, status, plan_amount_cents, lead_guarantee, from_number,
                           send_window_start_hour, send_window_end_hour, send_timezone,
                           send_rate_per_hour, message_template)
      VALUES (${C2}, ${C2_NAME}, 'active', 250000, 100000, ${C2_FROM},
              0, 24, 'America/New_York', ${RATE},
              'Hey [NAME] quick note. Reply STOP to opt out')
      ON CONFLICT (id) DO NOTHING
    `;
    const camp = (
      (await sql`INSERT INTO campaigns (client_id, name, auto_send) VALUES (${C2}, 'cron camp', true) RETURNING id`)[0] as { id: number }
    ).id;
    for (let i = 0; i < N; i++) {
      await sql`
        INSERT INTO contacts (client_id, campaign_id, first_name, address, phone, skiptrace_status, scrub_status, send_status)
        VALUES (${C2}, ${camp}, ${"T" + i}, ${"10" + i + " Test St"}, ${ELIGIBLE[i]}, 'matched', 'clean', 'not_sent')
      `;
    }
    // Opted-out contact: clean + not_sent, but its phone is in opt_outs → must NEVER be texted.
    await sql`
      INSERT INTO contacts (client_id, campaign_id, first_name, address, phone, skiptrace_status, scrub_status, send_status)
      VALUES (${C2}, ${camp}, 'Nope', '999 Opted Out Ln', ${OPTED_OUT}, 'matched', 'clean', 'not_sent')
    `;
    await sql`INSERT INTO opt_outs (client_id, phone) VALUES (${C2}, ${OPTED_OUT})`;

    const batch = cronBatchSize(RATE);
    check("cronBatchSize(60) = 1 (each tick sends ≤ 1 here)", batch === 1);

    // ---- 2 + 3 + 4: repeated ticks drain the set, ≤1 batch each, opted-out untouched ----
    await resetForRun(0, 24);
    let ticks = 0;
    let maxAttemptedInATick = 0;
    let drainedReported = false;
    for (let i = 0; i < 50; i++) {
      const { status, json } = await callCron(SECRET);
      check(`tick ${i + 1}: authorized → 200`, status === 200);
      ticks++;
      const results = (json.results as Record<string, unknown>[]) ?? [];
      const r = results.find((x) => Number(x.campaignId) === camp);
      if (r) {
        const attempted = Number(r.sent ?? 0) + Number(r.failed ?? 0);
        maxAttemptedInATick = Math.max(maxAttemptedInATick, attempted);
        if (r.kind === "drained" || (r.kind === "sent" && r.done === true)) drainedReported = true;
      }
      const elig = (await sql`
        SELECT count(*)::int n FROM contacts
        WHERE client_id=${C2} AND send_status='not_sent' AND suppressed=false AND scrub_status='clean'
          AND phone IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.client_id=${C2}
            AND right(regexp_replace(o.phone,'[^0-9]','','g'),10)=right(regexp_replace(contacts.phone,'[^0-9]','','g'),10))
      `)[0] as { n: number };
      if (elig.n === 0) break;
    }

    check("2. each tick attempted ≤ one batch (cronBatchSize)", maxAttemptedInATick <= batch);
    check("3. draining took MULTIPLE ticks (the cron, not one call, drains it)", ticks >= N);

    const terminal = (await sql`
      SELECT count(*)::int n FROM contacts WHERE client_id=${C2} AND send_status IN ('sent','failed')
    `)[0] as { n: number };
    check("3. all eligible contacts reached a terminal state (drained)", terminal.n === N);

    const optedRow = (await sql`SELECT send_status FROM contacts WHERE client_id=${C2} AND phone=${OPTED_OUT}`)[0] as { send_status: string };
    check("4. opted-out contact NEVER texted (still not_sent)", optedRow.send_status === "not_sent");

    const outToOpted = (await sql`
      SELECT count(*)::int n FROM messages m JOIN contacts c ON c.id=m.contact_id
      WHERE m.client_id=${C2} AND c.phone=${OPTED_OUT} AND m.direction='outbound'
    `)[0] as { n: number };
    check("4. zero outbound messages to the opted-out contact", outToOpted.n === 0);

    // No double-send: exactly ONE outbound message per eligible contact, N total.
    const out1 = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=${C2} AND direction='outbound'`)[0] as { n: number };
    check("5. exactly N outbound messages after drain (one per eligible, no double-send)", out1.n === N);
    const dupes1 = (await sql`
      SELECT count(*)::int n FROM (
        SELECT contact_id FROM messages WHERE client_id=${C2} AND direction='outbound'
        GROUP BY contact_id HAVING count(*) > 1
      ) d
    `)[0] as { n: number };
    check("5. no contact has >1 outbound message", dupes1.n === 0);

    const run = (await sql`SELECT finished_at FROM campaign_runs WHERE client_id=${C2} ORDER BY id DESC LIMIT 1`)[0] as { finished_at: string | null } | undefined;
    check("3. the run is CLOSED (finished_at set) once drained", !!run && run.finished_at !== null);
    const runCount = (await sql`SELECT count(*)::int n FROM campaign_runs WHERE client_id=${C2}`)[0] as { n: number };
    check("3. exactly ONE run spanned the whole multi-tick drain", runCount.n === 1);

    const autoAfter = (await sql`SELECT auto_send FROM campaigns WHERE id=${camp}`)[0] as { auto_send: boolean };
    check("3. auto_send CLEARED after drain (campaign stops being driven)", autoAfter.auto_send === false);
    check("drainedReported in the cron response", drainedReported);

    // A further tick now drives nothing (no auto_send targets) — idempotent, no new sends.
    const afterDrain = await callCron(SECRET);
    const afterResults = (afterDrain.json.results as unknown[]) ?? [];
    const out1b = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=${C2} AND direction='outbound'`)[0] as { n: number };
    check("3. a tick after drain drives this campaign nothing (auto_send off)",
      !afterResults.some((x) => Number((x as Record<string, unknown>).campaignId) === camp) && out1b.n === N);

    // ---- 6. WINDOW CLOSED: a tick sends nothing and leaves auto_send ON --------------------
    await resetForRun(0, 0); // [0,0) is closed at every hour
    const winTick = await callCron(SECRET);
    const winRes = ((winTick.json.results as Record<string, unknown>[]) ?? []).find((x) => Number(x.campaignId) === camp);
    check("6. window-closed tick reports outside_window for the campaign", winRes?.kind === "outside_window");
    const stillNotSent = (await sql`SELECT count(*)::int n FROM contacts WHERE client_id=${C2} AND send_status='not_sent'`)[0] as { n: number };
    check("6. window closed → contacts untouched (all not_sent)", stillNotSent.n === N + 1);
    const outWin = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=${C2} AND direction='outbound'`)[0] as { n: number };
    check("6. window closed → ZERO outbound messages sent", outWin.n === 0);
    const autoStillOn = (await sql`SELECT auto_send FROM campaigns WHERE id=${camp}`)[0] as { auto_send: boolean };
    check("6. window-closed pause leaves auto_send ON (resumes when the window opens)", autoStillOn.auto_send === true);

    // ---- 5b. OVERLAP: two ticks running CONCURRENTLY never double-send --------------------
    await resetForRun(0, 24);
    for (let round = 0; round < 50; round++) {
      // Fire two cron invocations at once each round — they adopt the same run and race the claim.
      await Promise.all([callCron(SECRET), callCron(SECRET)]);
      const elig = (await sql`
        SELECT count(*)::int n FROM contacts WHERE client_id=${C2} AND send_status='not_sent'
          AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.client_id=${C2}
            AND right(regexp_replace(o.phone,'[^0-9]','','g'),10)=right(regexp_replace(contacts.phone,'[^0-9]','','g'),10))
      `)[0] as { n: number };
      if (elig.n === 0) break;
    }
    const out2 = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=${C2} AND direction='outbound'`)[0] as { n: number };
    check("5. OVERLAPPING ticks still produce exactly N outbound messages (no double-send)", out2.n === N);
    const dupes2 = (await sql`
      SELECT count(*)::int n FROM (
        SELECT contact_id FROM messages WHERE client_id=${C2} AND direction='outbound'
        GROUP BY contact_id HAVING count(*) > 1
      ) d
    `)[0] as { n: number };
    check("5. overlap: no contact double-texted", dupes2.n === 0);
    const optedRow2 = (await sql`SELECT send_status FROM contacts WHERE client_id=${C2} AND phone=${OPTED_OUT}`)[0] as { send_status: string };
    check("5. overlap: opted-out contact STILL never texted", optedRow2.send_status === "not_sent");
  } finally {
    await sql`DELETE FROM messages WHERE client_id = ${C2}`;
    await sql`DELETE FROM leads WHERE client_id = ${C2}`;
    await sql`DELETE FROM opt_outs WHERE client_id = ${C2}`;
    await sql`DELETE FROM contacts WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaign_runs WHERE client_id = ${C2}`;
    await sql`DELETE FROM trace_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM scrub_jobs WHERE client_id = ${C2}`;
    await sql`DELETE FROM campaigns WHERE client_id = ${C2}`;
    await sql`DELETE FROM clients WHERE id = ${C2}`;
  }

  const c1MsgAfter = (await sql`SELECT count(*)::int n FROM messages WHERE client_id=1`)[0] as { n: number };
  check("client 1 (Talan) messages unchanged by the fixture", c1MsgAfter.n === c1MsgBefore.n);

  console.log(
    failures === 0
      ? "\nCRON-SEND OK — the server drains the campaign without a browser; no double-send, window + suppression hold."
      : `\nCRON-SEND FAILED — ${failures} assertion(s) failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[cron-send] FAILED:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
