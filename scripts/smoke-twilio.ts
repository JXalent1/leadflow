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

import { renderMessage, segmentInfo, withinSingleSegment, type Variant } from "@/lib/sms";
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

  const variant = (process.env.SMOKE_VARIANT?.trim().toUpperCase() as Variant) || "A";
  const biz = process.env.BIZ_NAME?.trim() || "Talan Window Cleaning";

  // Render exactly as the campaign would (single-segment, opt-out line included).
  const body = renderMessage(variant, { firstName: "Jordan", zip: "32301" }, biz);
  const seg = segmentInfo(body);

  hr("SENDER");
  // Print which sender we resolved WITHOUT printing the auth token.
  console.log(getSenderField());
  console.log("send window:", sendWindowLabel(), "(smoke ignores the window — it texts only you)");

  hr("MESSAGE");
  console.log("variant:", variant);
  console.log("to:", to);
  console.log("body:", body);
  console.log(`length: ${seg.length}  segments: ${seg.segments}  encoding: ${seg.encoding}`);

  if (!withinSingleSegment(body)) {
    throw new Error("Rendered message is more than one segment — aborting (would never send 2 segments).");
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
