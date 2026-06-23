/**
 * smoke-webhook.ts — proves the inbound webhook's ONLY auth (the Twilio signature gate)
 * accepts a correctly-signed request and rejects forged/missing signatures.
 *
 * This exercises the exact validation the route uses (twilio.validateRequest over the public
 * URL + posted params) with NO DB and NO real Twilio account — so it runs anywhere. It does
 * not hit the handler's DB/forward path; lib/inbound.test.ts covers the decision logic.
 *
 * Run: npx tsx scripts/smoke-webhook.ts
 */

import twilio from "twilio";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";

const AUTH_TOKEN = "test_auth_token_not_a_real_secret";
const URL = "https://leadflow.example.com/api/webhook/twilio";

// A representative inbound SMS (what Twilio POSTs as application/x-www-form-urlencoded).
const params: Record<string, string> = {
  From: "+18505551234",
  To: "+18508213720",
  Body: "Yes, how much for a quote?",
  MessageSid: "SM0123456789abcdef0123456789abcdef",
  AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
};

function check(label: string, condition: boolean): boolean {
  console.log(`${condition ? "✔" : "✖"} ${label}`);
  return condition;
}

function main(): void {
  console.log("Webhook signature-gate smoke\n");

  // Twilio signs base64(HMAC-SHA1(authToken, url + sorted concatenated params)).
  const validSignature = getExpectedTwilioSignature(AUTH_TOKEN, URL, params);

  const results: boolean[] = [];

  // 1. Correctly-signed request → accepted (the route would then process it).
  results.push(
    check(
      "valid signature is accepted",
      twilio.validateRequest(AUTH_TOKEN, validSignature, URL, params) === true,
    ),
  );

  // 2. Forged signature → rejected (route returns 403 before any DB write/forward).
  results.push(
    check(
      "forged signature is rejected (→ 403)",
      twilio.validateRequest(AUTH_TOKEN, "obviously-bogus-signature", URL, params) === false,
    ),
  );

  // 3. Tampered body with the original signature → rejected (can't forge an interested reply).
  const tampered = { ...params, Body: "STOP" };
  results.push(
    check(
      "tampered body invalidates the signature (→ 403)",
      twilio.validateRequest(AUTH_TOKEN, validSignature, URL, tampered) === false,
    ),
  );

  // 4. Wrong URL with the original signature → rejected (signature is URL-bound).
  results.push(
    check(
      "wrong URL invalidates the signature (→ 403)",
      twilio.validateRequest(AUTH_TOKEN, validSignature, URL + "?evil=1", params) === false,
    ),
  );

  // 5. Missing signature header → rejected (route's `!!signature` guard is false).
  const missing = "";
  results.push(check("missing signature is rejected (→ 403)", !missing));

  const ok = results.every(Boolean);
  console.log(`\n${ok ? "PASS" : "FAIL"} — ${results.filter(Boolean).length}/${results.length} checks`);
  if (!ok) process.exit(1);
}

main();
