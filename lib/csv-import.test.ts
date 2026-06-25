/**
 * csv-import.test.ts — unit tests for the pure CSV → contacts parser (v2 Module V2).
 * Runner: Node built-in test module via `tsx --test lib/*.test.ts`. No DB needed (the parser
 * is pure; it imports NewContact type-only, which is erased at runtime).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContactsCsv } from "./csv-import";

const HEADER = "FirstName,LastName,Address,City,State,Zip";

test("parses a well-formed CSV into NewContact rows", () => {
  const csv = `${HEADER}\nJane,Doe,123 Main St,Tallahassee,FL,32301\nJohn,Smith,456 Oak Ave,Tallahassee,FL,32303`;
  const r = parseContactsCsv(csv);
  assert.equal(r.error, undefined);
  assert.equal(r.read, 2);
  assert.equal(r.skipped, 0);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], {
    first_name: "Jane",
    last_name: "Doe",
    address: "123 Main St",
    city: "Tallahassee",
    state: "FL",
    zip: "32301",
  });
});

test("dedupes within the upload by address+zip (case-insensitive address)", () => {
  const csv = `${HEADER}\nJane,Doe,123 Main St,Tallahassee,FL,32301\nJane,Dupe,123 MAIN ST,Tallahassee,FL,32301\nJohn,Smith,123 Main St,Tallahassee,FL,32399`;
  const r = parseContactsCsv(csv);
  // rows 1 & 2 are the same address+zip (dup → skipped); row 3 is a different zip (kept).
  assert.equal(r.read, 3);
  assert.equal(r.skipped, 1);
  assert.equal(r.rows.length, 2);
});

test("skips rows with no address but keeps the rest", () => {
  const csv = `${HEADER}\nJane,Doe,,Tallahassee,FL,32301\nJohn,Smith,456 Oak Ave,Tallahassee,FL,32303`;
  const r = parseContactsCsv(csv);
  assert.equal(r.skipped, 1);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].address, "456 Oak Ave");
});

test("accepts case-insensitive headers and optional missing columns", () => {
  const csv = `address,zip\n789 Pine Rd,32304`;
  const r = parseContactsCsv(csv);
  assert.equal(r.error, undefined);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], {
    first_name: null,
    last_name: null,
    address: "789 Pine Rd",
    city: null,
    state: null,
    zip: "32304",
  });
});

test("errors (no rows) when there is no Address column", () => {
  const csv = `FirstName,LastName,City\nJane,Doe,Tallahassee`;
  const r = parseContactsCsv(csv);
  assert.ok(r.error);
  assert.equal(r.rows.length, 0);
});

test("errors on an empty file", () => {
  const r = parseContactsCsv("");
  assert.ok(r.error);
  assert.equal(r.rows.length, 0);
});
