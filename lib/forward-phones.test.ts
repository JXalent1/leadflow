/**
 * lib/forward-phones.test.ts — unit tests for parseForwardPhones / isProbablyPhone.
 * Runner: `tsx --test lib/*.test.ts`. Pure (no DB), so it runs under `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForwardPhones, isProbablyPhone } from "./forward-phones";

// --- parseForwardPhones -----------------------------------------------------

test("parseForwardPhones: comma separator 'a, b' → [a, b]", () => {
  assert.deepEqual(parseForwardPhones("a, b"), ["a", "b"]);
});

test("parseForwardPhones: semicolon separator", () => {
  assert.deepEqual(parseForwardPhones("+15551112222;+15553334444"), [
    "+15551112222",
    "+15553334444",
  ]);
});

test("parseForwardPhones: whitespace + newline separators", () => {
  assert.deepEqual(parseForwardPhones("+15551112222 +15553334444\n+15555556666"), [
    "+15551112222",
    "+15553334444",
    "+15555556666",
  ]);
});

test("parseForwardPhones: mixed separators collapse", () => {
  assert.deepEqual(parseForwardPhones(" +15551112222 ,; \n +15553334444 "), [
    "+15551112222",
    "+15553334444",
  ]);
});

test("parseForwardPhones: dedupe by last-10 digits (keeps first form)", () => {
  assert.deepEqual(parseForwardPhones("+18508213720, 850-821-3720"), ["+18508213720"]);
  // Same last-10 across formats → one recipient (first form kept). NOTE: numbers must not contain
  // internal spaces — whitespace is a separator (the helper text says "comma-separate").
  assert.deepEqual(parseForwardPhones("(407)555-1234, 4075551234, +14075551234"), [
    "(407)555-1234",
  ]);
});

test("parseForwardPhones: a single number → one-element list (unchanged behavior)", () => {
  assert.deepEqual(parseForwardPhones("+18508213720"), ["+18508213720"]);
});

test("parseForwardPhones: single number with surrounding whitespace trims", () => {
  assert.deepEqual(parseForwardPhones("  +18508213720  "), ["+18508213720"]);
});

test("parseForwardPhones: empty / null / undefined / whitespace → []", () => {
  assert.deepEqual(parseForwardPhones(""), []);
  assert.deepEqual(parseForwardPhones(null), []);
  assert.deepEqual(parseForwardPhones(undefined), []);
  assert.deepEqual(parseForwardPhones("   \n  "), []);
});

test("parseForwardPhones: distinct numbers are preserved in order", () => {
  assert.deepEqual(parseForwardPhones("+15551112222, +15553334444, +15555556666"), [
    "+15551112222",
    "+15553334444",
    "+15555556666",
  ]);
});

// --- isProbablyPhone --------------------------------------------------------

test("isProbablyPhone: E.164 / NANP forms → true", () => {
  assert.equal(isProbablyPhone("+18508213720"), true);
  assert.equal(isProbablyPhone("850-821-3720"), true);
  assert.equal(isProbablyPhone("(407) 555-1234"), true);
});

test("isProbablyPhone: clearly-invalid entries → false", () => {
  assert.equal(isProbablyPhone("call me"), false);
  assert.equal(isProbablyPhone("12345"), false); // too few digits
  assert.equal(isProbablyPhone(""), false);
  assert.equal(isProbablyPhone("1234567890123456"), false); // 16 digits, too many
});
