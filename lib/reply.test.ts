import { test } from "node:test";
import assert from "node:assert/strict";
import { replyRefusalReason } from "./reply";

// The compliance gate for the manual reply path. The hard requirement: we must NEVER
// be cleared to text a suppressed / opted-out contact, and we must fail closed on any
// missing/unusable contact. These prove the refusal the /api/reply route returns 4xx for.

test("refuses a suppressed contact (the load-bearing case)", () => {
  const contact = { phone: "8505551234", suppressed: true };
  assert.equal(replyRefusalReason(contact, false), "recipient_suppressed");
});

test("refuses a contact with a permanent opt-out record even if not flagged suppressed", () => {
  const contact = { phone: "8505551234", suppressed: false };
  assert.equal(replyRefusalReason(contact, true), "recipient_suppressed");
});

test("refuses when both suppressed and opted out", () => {
  const contact = { phone: "8505551234", suppressed: true };
  assert.equal(replyRefusalReason(contact, true), "recipient_suppressed");
});

test("refuses a missing contact (not found) — fail closed", () => {
  assert.equal(replyRefusalReason(null, false), "recipient_suppressed");
});

test("refuses a contact with no phone", () => {
  assert.equal(replyRefusalReason({ phone: null, suppressed: false }, false), "recipient_suppressed");
});

test("refuses a contact with a blank/whitespace phone", () => {
  assert.equal(replyRefusalReason({ phone: "   ", suppressed: false }, false), "recipient_suppressed");
});

test("clears a clean, non-suppressed, non-opted-out contact to send", () => {
  const contact = { phone: "8505551234", suppressed: false };
  assert.equal(replyRefusalReason(contact, false), null);
});
