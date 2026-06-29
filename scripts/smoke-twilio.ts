// scripts/smoke-twilio.ts — the Session 3 acceptance gate.
//
// Sends ONE real SMS to your own phone (SMOKE_TO_NUMBER) using the SAME rendering
// path the campaign uses (renderMessage from lib/sms.ts), then prints the Twilio
// SID + status. Purpose: prove Twilio auth, the sender (from-number / messaging
// service), and the rendered single-segment message all work before any list send.
//
// This does NOT touch the contacts table and does NOT run the campaign. It only
// texts the one number you put in SMOKE_TO_NUMBER.
//
// Run: npm run smoke:twilio   (or npx tsx scripts/smoke-twilio.ts)

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import {
  renderMessage,
  segmentInfo,
  withinSegmentLimit,
  MAX_MESSAGE_SEGMENTS,
  TALAN_MESSAGE_TEMPLATE,
} from "@/lib/sms";
import { sendOne, getSenderField, sendWindowLabel } from "@/lib/twilio";

function hr(label: string) {
  console.log(`\n===== ${label} =====`);
}

async function main() {
  const to = process.env.SMOKE_TO_NUMBER?.trim();
  if (!to) {
    throw new Error(
      "SMOKE_TO_NUMBER is not set. Add your own phone (E.164, e.g. +16195551234) to .env.local."
    );
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing — add them to .env.local.");
  }

  const biz = process.env.BIZ_NAME?.trim() || "Talan Window Cleaning";

  // Render exactly as the campaign would (single-segment, opt-out line included), from the
  // approved client-1 template. Includes a sample situs address so the smoke shows the real
  // ADDRESS version ~98% of recipients get (not the no-address fallback). Override SMOKE_ADDRESS.
  const sampleAddress = process.env.SMOKE_ADDRESS?.trim() || "7445 Buck Lake Rd";
  const body = renderMessage(
    TALAN_MESSAGE_TEMPLATE,
    { firstName: "Jordan", zip: "32301", address: sampleAddress },
    biz
  );
  const seg = segmentInfo(body);

  hr("SENDER");
  // Print which sender we resolved WITHOUT printing the auth token. NOTE (review M): this uses the
  // ENV sender (TWILIO_FROM_NUMBER / TWILIO_MESSAGING_SERVICE_SID), not the client record. For a
  // production-parity smoke, ensure the env from-number EQUALS client 1's clients.from_number
  // (+18508213720) — otherwise this proves a different sender than the campaign actually uses.
  console.log(getSenderField());
  console.log("send window:", sendWindowLabel(), "(smoke ignores the window — it texts only you)");

  hr("MESSAGE");
  console.log("to:", to);
  console.log("body:", body);
  console.log(`length: ${seg.length}  segments: ${seg.segments}  encoding: ${seg.encoding} (cap ${MAX_MESSAGE_SEGMENTS})`);
  if (seg.segments > 1) {
    console.log(`note: ${seg.segments}-segment message — costs ~${seg.segments}× per send (within the ${MAX_MESSAGE_SEGMENTS}-segment campaign cap).`);
  }

  if (!withinSegmentLimit(body)) {
    throw new Error(`Rendered message is ${seg.segments} segments — over the ${MAX_MESSAGE_SEGMENTS}-segment cap; aborting (the campaign would drain this to 'failed').`);
  }

  hr("SENDING");
  const res = await sendOne(to, body);
  if (res.ok) {
    console.log("SID:   ", res.sid);
    console.log("STATUS:", res.status);
    hr("DONE");
    console.log("Smoke send accepted by Twilio. Confirm the text arrived on your phone.");
  } else {
    console.error("SEND FAILED:", res.error, "code:", res.code ?? "?");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err);
  process.exit(1);
});
