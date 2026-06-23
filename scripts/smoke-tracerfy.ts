// scripts/smoke-tracerfy.ts — the hard gate before any full run.
//
// Takes ONE real pending contact and runs the full trace -> scrub round-trip
// against the LIVE Tracerfy API. Prints the raw API responses AND the parsed
// shapes, plus what it WOULD write to the DB. It does NOT mutate contacts.
//
// Purpose: prove the request/response field names are right before we spend
// credits on the 500. Run: npm run smoke:tracerfy  (or npx tsx scripts/smoke-tracerfy.ts)

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { neon } from "@neondatabase/serverless";
import {
  getCredits,
  submitTrace,
  getTraceResults,
  submitScrub,
  getScrubResults,
  matchKey,
  normalizePhone,
} from "@/lib/tracerfy";

interface Row {
  id: number;
  first_name: string | null;
  last_name: string | null;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
}

function hr(label: string) {
  console.log(`\n===== ${label} =====`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Add it to .env.local.");
  if (!process.env.TRACERFY_API_KEY) {
    throw new Error("TRACERFY_API_KEY is not set. Add it to .env.local before the smoke test.");
  }
  const sql = neon(url);

  // 1) Pull ONE pending contact.
  const rows = (await sql`
    SELECT id, first_name, last_name, address, city, state, zip
    FROM contacts
    WHERE skiptrace_status = 'pending'
    ORDER BY id
    LIMIT 1
  `) as Row[];
  if (rows.length === 0) {
    console.log("No pending contacts. Nothing to smoke-test.");
    return;
  }
  const c = rows[0];
  hr("CONTACT (input)");
  console.log(c);

  // 2) Credits pre-flight.
  hr("CREDITS");
  const credits = await getCredits();
  console.log("balance:", credits);

  // 3) Submit trace for the one contact.
  hr("TRACE submit");
  const { queueId, rowsUploaded } = await submitTrace([
    {
      address: c.address,
      city: c.city,
      state: c.state,
      zip: c.zip,
      firstName: c.first_name,
      lastName: c.last_name,
    },
  ]);
  console.log("queueId:", queueId, "rowsUploaded:", rowsUploaded);

  // 4) Poll trace results — print raw + parsed.
  hr("TRACE results");
  const trace = await getTraceResults(queueId, {
    intervalMs: 5000,
    maxAttempts: 36,
    expectedRows: 1,
  });
  console.log("RAW:", JSON.stringify(trace.raw, null, 2).slice(0, 3000));
  console.log("PARSED rows:", trace.rows);

  const hit =
    trace.rows.find(
      (r) =>
        r.matched &&
        r.phone &&
        matchKey(r.address, r.city, r.state) === matchKey(c.address, c.city, c.state)
    ) ?? trace.rows.find((r) => r.matched && r.phone);

  hr("WOULD WRITE (trace)");
  if (hit && hit.phone) {
    console.log({
      id: c.id,
      phone: hit.phone,
      phone_type: hit.phoneType,
      skiptrace_status: "matched",
    });
  } else {
    console.log({
      id: c.id,
      phone: null,
      phone_type: null,
      skiptrace_status: "no_match",
      suppressed: true,
      suppress_reason: "no_match",
      note: "FAIL CLOSED: no match suppressed",
    });
    console.log("\nNo phone matched — scrub step skipped (nothing to scrub).");
    return;
  }

  // 5) Scrub the EXACT phone we'd text (the picked mobile), via the phone-list
  //    path — this is the number that lands in contacts.phone, so it's what the
  //    scrub verdict must apply to (primary_phone may differ when it's a landline).
  hr("SCRUB submit (explicit phone)");
  const { scrubQueueId } = await submitScrub({ phones: [hit.phone] });
  console.log("scrubQueueId:", scrubQueueId);

  // 6) Poll scrub results — print raw + parsed.
  hr("SCRUB results");
  const scrub = await getScrubResults(scrubQueueId, { intervalMs: 5000, maxAttempts: 36 });
  console.log("RAW:", JSON.stringify(scrub.raw, null, 2).slice(0, 3000));
  console.log("PARSED rows:", scrub.rows);

  const row = scrub.byPhone.get(normalizePhone(hit.phone));
  hr("WOULD WRITE (scrub verdict)");
  if (!row) {
    console.log({ id: c.id, suppressed: true, suppress_reason: "scrub_error", note: "FAIL CLOSED: phone not in scrub results" });
  } else if (row.litigator) {
    console.log({ id: c.id, suppressed: true, suppress_reason: "litigator" });
  } else if (row.federalDnc || row.stateDnc || row.dma) {
    console.log({ id: c.id, suppressed: true, suppress_reason: "dnc" });
  } else if (row.isClean) {
    console.log({ id: c.id, suppressed: false, note: "CLEAN — eligible to text" });
  } else {
    console.log({ id: c.id, suppressed: true, suppress_reason: "scrub_error", note: "FAIL CLOSED: ambiguous" });
  }

  hr("DONE");
  console.log("Smoke test complete. No DB rows were modified.");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err);
  process.exit(1);
});
