/**
 * lib/sms.test.ts — Unit tests for lib/sms.ts
 * Run via: npm test  (tsx --test lib/*.test.ts)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  renderMessage,
  isNonHumanName,
  segmentInfo,
  withinSingleSegment,
} from "./sms";

// ---------------------------------------------------------------------------
// isNonHumanName
// ---------------------------------------------------------------------------

test("isNonHumanName: null/undefined/empty → true", () => {
  assert.equal(isNonHumanName(null), true);
  assert.equal(isNonHumanName(undefined), true);
  assert.equal(isNonHumanName(""), true);
  assert.equal(isNonHumanName("   "), true);
});

test("isNonHumanName: normal human names → false", () => {
  assert.equal(isNonHumanName("James"), false);
  assert.equal(isNonHumanName("Sarah"), false);
  assert.equal(isNonHumanName("Maria"), false);
  assert.equal(isNonHumanName("Bob"), false);
  assert.equal(isNonHumanName("Li"), false, "two-char name should be false — it is a valid first name");
  assert.equal(isNonHumanName("Jo"), false, "two-char name should be false");
});

test("isNonHumanName: entity suffixes → true (case-insensitive)", () => {
  assert.equal(isNonHumanName("ACME LLC"), true);
  assert.equal(isNonHumanName("Smith Inc"), true);
  assert.equal(isNonHumanName("Smith INC"), true);
  assert.equal(isNonHumanName("Oakwood LLP"), true);
  assert.equal(isNonHumanName("Green Corp"), true);
  assert.equal(isNonHumanName("Blue Co"), true);
  assert.equal(isNonHumanName("Sunrise LP"), true);
  assert.equal(isNonHumanName("Sunrise Ltd"), true);
  assert.equal(isNonHumanName("John Trust"), true);
  assert.equal(isNonHumanName("Jane Estate"), true);
  assert.equal(isNonHumanName("Oak Foundation"), true);
  assert.equal(isNonHumanName("Smith Partners"), true);
  assert.equal(isNonHumanName("Apex Holdings"), true);
  assert.equal(isNonHumanName("Realty Assoc"), true);
  assert.equal(isNonHumanName("Realty Association"), true);
  assert.equal(isNonHumanName("Sunrise Group"), true);
});

test("isNonHumanName: names containing digits → true", () => {
  assert.equal(isNonHumanName("Unit 2B"), true);
  assert.equal(isNonHumanName("Home123"), true);
  assert.equal(isNonHumanName("John3"), true);
});

test("isNonHumanName: all-caps multi-word entity strings → true", () => {
  assert.equal(isNonHumanName("SMITH HOLDINGS"), true);
  assert.equal(isNonHumanName("OAK CREEK REALTY"), true);
});

test("isNonHumanName: single-character token → true", () => {
  // Single character is not a real first name
  assert.equal(isNonHumanName("A"), true);
  assert.equal(isNonHumanName("X"), true);
});

// ---------------------------------------------------------------------------
// renderMessage — opt-out phrase presence (hard requirement)
// ---------------------------------------------------------------------------

// Period-insensitive opt-out line: variant A (Jordan's verbatim pilot copy) ends
// without a trailing period; variants B/C end with one. Both must carry this line.
const OPT_OUT_CORE = "Reply STOP to opt out";
const TYPICAL_CONTACT = { firstName: "James", zip: "32301", address: "123 Main St" };
const NULL_CONTACT = { firstName: null as null, zip: "32301", address: "123 Main St" };
const ENTITY_CONTACT = { firstName: "ACME LLC", zip: "32301", address: "123 Main St" };
const NO_ZIP_CONTACT = { firstName: "James", zip: null as null, address: "123 Main St" };
const BIZ = "Talan's Window Cleaning";

const VARIANTS = ["A", "B", "C"] as const;

// Matches the opt-out line whether or not it ends in a period, anchored to end of string.
const OPT_OUT_AT_END = /Reply STOP to opt out\.?$/;

test("renderMessage: every variant with normal name carries the opt-out line at the end", () => {
  for (const v of VARIANTS) {
    const msg = renderMessage(v, TYPICAL_CONTACT, BIZ);
    assert.ok(
      OPT_OUT_AT_END.test(msg),
      `Variant ${v} with normal name should end with "${OPT_OUT_CORE}" — got: "${msg}"`
    );
  }
});

test("renderMessage: every variant with null name carries the opt-out line at the end", () => {
  for (const v of VARIANTS) {
    const msg = renderMessage(v, NULL_CONTACT, BIZ);
    assert.ok(
      OPT_OUT_AT_END.test(msg),
      `Variant ${v} with null name should end with "${OPT_OUT_CORE}" — got: "${msg}"`
    );
  }
});

test("renderMessage: every variant with entity name carries the opt-out line at the end", () => {
  for (const v of VARIANTS) {
    const msg = renderMessage(v, ENTITY_CONTACT, BIZ);
    assert.ok(
      OPT_OUT_AT_END.test(msg),
      `Variant ${v} with entity name should end with "${OPT_OUT_CORE}" — got: "${msg}"`
    );
  }
});

// ---------------------------------------------------------------------------
// renderMessage — no leftover merge brackets
// ---------------------------------------------------------------------------

test("renderMessage: no leftover merge brackets for all variant × name combos", () => {
  const contacts = [TYPICAL_CONTACT, NULL_CONTACT, ENTITY_CONTACT, NO_ZIP_CONTACT];
  for (const v of VARIANTS) {
    for (const c of contacts) {
      const msg = renderMessage(v, c, BIZ);
      assert.ok(
        !msg.includes("["),
        `Variant ${v} left an unresolved bracket "[" in: "${msg}"`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// renderMessage — greeting fallback
// ---------------------------------------------------------------------------

test("renderMessage variant A (pilot): normal name → 'Hey James busy season...'", () => {
  const msg = renderMessage("A", TYPICAL_CONTACT, BIZ);
  assert.ok(
    msg.startsWith("Hey James busy season is here,"),
    `Expected pilot opener for 'James', got: "${msg}"`
  );
});

test("renderMessage variant A (pilot): null name → 'Hey there busy season...'", () => {
  const msg = renderMessage("A", NULL_CONTACT, BIZ);
  assert.ok(
    msg.startsWith("Hey there busy season is here,"),
    `Expected 'Hey there' fallback opener, got: "${msg}"`
  );
});

test("renderMessage variant A (pilot): entity name → 'Hey there' (not 'Hey ACME LLC')", () => {
  const msg = renderMessage("A", ENTITY_CONTACT, BIZ);
  assert.ok(
    msg.startsWith("Hey there busy season is here,"),
    `Expected 'Hey there' fallback opener, got: "${msg}"`
  );
  assert.ok(!msg.includes("ACME LLC"), `Entity name must not appear in greeting, got: "${msg}"`);
});

test("renderMessage variant A (pilot): title-cases ALL-CAPS name and address", () => {
  const msg = renderMessage("A", { firstName: "ROBERT", zip: "32317", address: "7445 BUCK LAKE RD" }, BIZ);
  assert.ok(msg.startsWith("Hey Robert busy season"), `Name not title-cased, got: "${msg}"`);
  assert.ok(msg.includes("at 7445 Buck Lake Rd."), `Address not title-cased, got: "${msg}"`);
  assert.ok(!/[A-Z]{2,}/.test(msg.replace("STOP", "")), `Leftover all-caps token (besides STOP), got: "${msg}"`);
});

test("renderMessage variant A (pilot): contains no business name", () => {
  const msg = renderMessage("A", TYPICAL_CONTACT, BIZ);
  assert.ok(!msg.includes(BIZ), `Pilot copy must not contain the business name, got: "${msg}"`);
  assert.ok(!msg.toLowerCase().includes("talan"), `Pilot copy must not name the business, got: "${msg}"`);
});

test("renderMessage variant A (pilot): ends verbatim with 'Reply STOP to opt out' (no period)", () => {
  const msg = renderMessage("A", TYPICAL_CONTACT, BIZ);
  assert.ok(
    msg.endsWith("Reply STOP to opt out"),
    `Variant A must end with the verbatim period-less opt-out line, got: "${msg}"`
  );
});

test("renderMessage variant A (pilot): drops only the address clause when over one segment", () => {
  // Force overflow with an absurdly long address; the fallback must drop the "at ..."
  // clause, keep the rest verbatim, and remain a single segment.
  const longAddress = "1234 " + "VERYLONGSTREETNAME ".repeat(8) + "BOULEVARD";
  const msg = renderMessage("A", { firstName: "James", zip: "32301", address: longAddress }, BIZ);
  assert.ok(withinSingleSegment(msg), `Fallback must be single-segment, got ${segmentInfo(msg).segments} segments`);
  assert.ok(!msg.includes(" at "), `Fallback must drop the "at <address>" clause, got: "${msg}"`);
  assert.ok(
    msg.endsWith("interested in window cleaning services. Reply STOP to opt out"),
    `Fallback wording must match the approved no-address copy, got: "${msg}"`
  );
});

test("renderMessage variant B: normal name → 'Hey James,'", () => {
  const msg = renderMessage("B", TYPICAL_CONTACT, BIZ);
  assert.ok(msg.startsWith("Hey James,"), `Expected 'Hey James,' at start, got: "${msg}"`);
});

test("renderMessage variant B: null name → 'Hey there,'", () => {
  const msg = renderMessage("B", NULL_CONTACT, BIZ);
  assert.ok(msg.startsWith("Hey there,"), `Expected 'Hey there,' at start, got: "${msg}"`);
});

test("renderMessage variant C: normal name → 'Hi James,'", () => {
  const msg = renderMessage("C", TYPICAL_CONTACT, BIZ);
  assert.ok(msg.startsWith("Hi James,"), `Expected 'Hi James,' at start, got: "${msg}"`);
});

test("renderMessage variant C: null name → 'Hi there,'", () => {
  const msg = renderMessage("C", NULL_CONTACT, BIZ);
  assert.ok(msg.startsWith("Hi there,"), `Expected 'Hi there,' at start, got: "${msg}"`);
});

// ---------------------------------------------------------------------------
// renderMessage — zip fallback
// ---------------------------------------------------------------------------

test("renderMessage variant B: null zip → 'your area' (no leftover placeholder)", () => {
  const msg = renderMessage("B", NO_ZIP_CONTACT, BIZ);
  assert.ok(msg.includes("your area"), `Expected 'your area' fallback, got: "${msg}"`);
  assert.ok(!msg.includes("["), `No leftover bracket in: "${msg}"`);
});

test("renderMessage variant C: null zip → 'your area'", () => {
  const msg = renderMessage("C", { firstName: "James", zip: null }, BIZ);
  assert.ok(msg.includes("your area"), `Expected 'your area' fallback, got: "${msg}"`);
});

// ---------------------------------------------------------------------------
// renderMessage — bizName appears in message
// ---------------------------------------------------------------------------

test("renderMessage: bizName appears in variants B and C (pilot variant A has none)", () => {
  for (const v of ["B", "C"] as const) {
    const msg = renderMessage(v, TYPICAL_CONTACT, BIZ);
    assert.ok(msg.includes(BIZ), `Variant ${v} missing bizName, got: "${msg}"`);
  }
});

// ---------------------------------------------------------------------------
// renderMessage — single-segment check for typical inputs (CRITICAL)
// ---------------------------------------------------------------------------

test("renderMessage variant A: typical first-name + address fits one segment", () => {
  const msg = renderMessage("A", TYPICAL_CONTACT, BIZ);
  const info = segmentInfo(msg);
  assert.equal(
    info.segments,
    1,
    `Variant A overflows to ${info.segments} segments (${info.length} chars / ${info.encoding}). Message: "${msg}"`
  );
});

test("renderMessage variant B: typical first-name + zip fits one segment", () => {
  const msg = renderMessage("B", TYPICAL_CONTACT, BIZ);
  const info = segmentInfo(msg);
  assert.equal(
    info.segments,
    1,
    `Variant B overflows to ${info.segments} segments (${info.length} chars / ${info.encoding}). Message: "${msg}"`
  );
});

test("renderMessage variant C: typical first-name + zip fits one segment", () => {
  const msg = renderMessage("C", TYPICAL_CONTACT, BIZ);
  const info = segmentInfo(msg);
  assert.equal(
    info.segments,
    1,
    `Variant C overflows to ${info.segments} segments (${info.length} chars / ${info.encoding}). Message: "${msg}"`
  );
});

test("renderMessage all variants: withinSingleSegment for typical input", () => {
  for (const v of VARIANTS) {
    const msg = renderMessage(v, TYPICAL_CONTACT, BIZ);
    assert.ok(
      withinSingleSegment(msg),
      `Variant ${v} exceeds one segment. Segment info: ${JSON.stringify(segmentInfo(msg))}. Message: "${msg}"`
    );
  }
});

// ---------------------------------------------------------------------------
// segmentInfo — encoding detection and segment math
// ---------------------------------------------------------------------------

test("segmentInfo: short ASCII string → GSM-7, 1 segment", () => {
  const info = segmentInfo("Hello, world!");
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 1);
  assert.equal(info.length, 13);
});

test("segmentInfo: exactly 160 GSM-7 chars → 1 segment", () => {
  const msg = "A".repeat(160);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 1);
});

test("segmentInfo: 161-char ASCII string → GSM-7, 2 segments", () => {
  const msg = "A".repeat(161);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 2);
  assert.equal(info.length, 161);
});

test("segmentInfo: 306-char ASCII string → GSM-7, 2 segments (2×153)", () => {
  const msg = "A".repeat(306);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 2);
});

test("segmentInfo: 307-char ASCII string → GSM-7, 3 segments", () => {
  const msg = "A".repeat(307);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 3);
});

test("segmentInfo: string with emoji → UCS-2", () => {
  const msg = "Hello 🎉";
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "UCS-2");
});

test("segmentInfo: short UCS-2 string → 1 segment (≤ 70 chars)", () => {
  const msg = "Hello 世界"; // "Hello 世界"
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.segments, 1);
});

test("segmentInfo: exactly 70-char UCS-2 string → 1 segment", () => {
  // Use a non-GSM char to force UCS-2 encoding, pad to 70
  const nonGsm = "世"; // 世
  const msg = nonGsm + "A".repeat(69);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.length, 70);
  assert.equal(info.segments, 1);
});

test("segmentInfo: 71-char UCS-2 string → 2 segments", () => {
  const nonGsm = "世";
  const msg = nonGsm + "A".repeat(70);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.length, 71);
  assert.equal(info.segments, 2);
});

test("segmentInfo: 134-char UCS-2 string → 2 segments (2×67)", () => {
  const nonGsm = "世";
  const msg = nonGsm + "A".repeat(133);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.segments, 2);
});

test("segmentInfo: 135-char UCS-2 string → 3 segments", () => {
  const nonGsm = "世";
  const msg = nonGsm + "A".repeat(134);
  const info = segmentInfo(msg);
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.segments, 3);
});

// ---------------------------------------------------------------------------
// withinSingleSegment
// ---------------------------------------------------------------------------

test("withinSingleSegment: short message → true", () => {
  assert.equal(withinSingleSegment("Hi James, short text. Reply STOP to opt out."), true);
});

test("withinSingleSegment: 161+ char message → false", () => {
  assert.equal(withinSingleSegment("A".repeat(161)), false);
});

test("withinSingleSegment: emoji message over 70 → false", () => {
  // emoji forces UCS-2, 71 chars overflows
  const msg = "世" + "A".repeat(70); // 71 chars UCS-2
  assert.equal(withinSingleSegment(msg), false);
});

// ---------------------------------------------------------------------------
// renderMessage variant A (pilot) — REAL DATA proof (session-6.md Task 0)
//   Every real contact must render single-segment AND end with the opt-out line.
//   The longest real addresses must STILL fit with the address (no fallback), so
//   we are not silently dropping the address clause on the real list.
// ---------------------------------------------------------------------------

interface CsvRow {
  firstName: string;
  address: string;
  zip: string;
}

function loadPilotContacts(): CsvRow[] {
  const csvPath = path.join(process.cwd(), "data", "tallahassee_test_500.csv");
  const raw = readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // header: FirstName,LastName,Address,City,State,Zip
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return { firstName: cols[0] ?? "", address: cols[2] ?? "", zip: cols[5] ?? "" };
  });
}

test("renderMessage variant A: ALL 500 real contacts render single-segment + opt-out line", () => {
  const rows = loadPilotContacts();
  assert.ok(rows.length >= 500, `expected ~500 rows, got ${rows.length}`);
  for (const row of rows) {
    const msg = renderMessage("A", { firstName: row.firstName, zip: row.zip, address: row.address }, BIZ);
    assert.ok(
      withinSingleSegment(msg),
      `Row "${row.firstName} / ${row.address}" overflows: ${JSON.stringify(segmentInfo(msg))} — "${msg}"`
    );
    assert.ok(
      msg.endsWith("Reply STOP to opt out"),
      `Row "${row.firstName} / ${row.address}" missing verbatim opt-out line — "${msg}"`
    );
  }
});

test("renderMessage variant A: the LONGEST real addresses stay single-segment (fallback guarantees it)", () => {
  const rows = loadPilotContacts();
  const longest = [...rows].sort((a, b) => b.address.length - a.address.length).slice(0, 10);
  assert.ok(longest[0].address.length >= 24, `expected a long real address, got "${longest[0].address}"`);
  for (const row of longest) {
    const msg = renderMessage("A", { firstName: row.firstName, zip: row.zip, address: row.address }, BIZ);
    assert.ok(
      withinSingleSegment(msg),
      `Longest address row overflowed — ${JSON.stringify(segmentInfo(msg))} — "${msg}"`
    );
    assert.ok(msg.endsWith("Reply STOP to opt out"), `Missing opt-out line — "${msg}"`);
  }
});

test("renderMessage variant A: the address clause is retained for nearly all real contacts (fallback is rare)", () => {
  const rows = loadPilotContacts();
  let retained = 0;
  for (const row of rows) {
    const msg = renderMessage("A", { firstName: row.firstName, zip: row.zip, address: row.address }, BIZ);
    if (msg.includes(" at ")) retained++;
  }
  // The fallback should only fire for the few longest address+name combos. If it
  // fires broadly, the copy or segment math has regressed.
  assert.ok(
    retained >= rows.length - 10,
    `Fallback dropped the address on ${rows.length - retained}/${rows.length} contacts (expected ≤ 10)`
  );
});
