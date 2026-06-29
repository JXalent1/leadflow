/**
 * lib/sms.test.ts — Unit tests for lib/sms.ts
 * Run via: npm test  (tsx --test lib/*.test.ts)
 *
 * v2: renderMessage is now TEMPLATE-driven (renderMessage(template, contact, bizName)). The
 * Talan (client 1) assertions use TALAN_MESSAGE_TEMPLATE and are the regression proof that
 * client 1's copy is byte-identical to the v1 pilot. Generic-template tests prove the renderer
 * substitutes placeholders + honors the {...} optional clause for ANY client's template.
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
  withinSegmentLimit,
  MAX_MESSAGE_SEGMENTS,
  optOutInstructionFor,
  TALAN_MESSAGE_TEMPLATE,
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
  assert.equal(isNonHumanName("A"), true);
  assert.equal(isNonHumanName("X"), true);
});

// ---------------------------------------------------------------------------
// renderMessage — Talan (client 1) template: byte-identical to the v1 pilot
// ---------------------------------------------------------------------------

const TALAN = TALAN_MESSAGE_TEMPLATE;
const TYPICAL_CONTACT = { firstName: "James", zip: "32301", address: "123 Main St" };
const NULL_CONTACT = { firstName: null as null, zip: "32301", address: "123 Main St" };
const ENTITY_CONTACT = { firstName: "ACME LLC", zip: "32301", address: "123 Main St" };
const BIZ = "Talan's Window Cleaning";

test("renderMessage (Talan): normal/null/entity names all carry the opt-out line at the end", () => {
  for (const c of [TYPICAL_CONTACT, NULL_CONTACT, ENTITY_CONTACT]) {
    const msg = renderMessage(TALAN, c, BIZ);
    assert.ok(/Reply STOP to opt out\.?$/.test(msg), `missing opt-out line — got: "${msg}"`);
  }
});

test("renderMessage (Talan): no leftover merge brackets or braces", () => {
  for (const c of [TYPICAL_CONTACT, NULL_CONTACT, ENTITY_CONTACT, { firstName: "James", zip: null, address: "123 Main St" }]) {
    const msg = renderMessage(TALAN, c, BIZ);
    assert.ok(!msg.includes("["), `unresolved "[" in: "${msg}"`);
    assert.ok(!msg.includes("{") && !msg.includes("}"), `leftover clause brace in: "${msg}"`);
  }
});

test("renderMessage (Talan): normal name → 'Hey James busy season...'", () => {
  const msg = renderMessage(TALAN, TYPICAL_CONTACT, BIZ);
  assert.ok(msg.startsWith("Hey James busy season is here,"), `got: "${msg}"`);
});

test("renderMessage (Talan): typical 1-segment render is BYTE-IDENTICAL (unchanged by the segment-cap raise)", () => {
  const msg = renderMessage(TALAN, TYPICAL_CONTACT, BIZ);
  assert.equal(
    msg,
    "Hey James busy season is here, we are working close by if you were interested in window cleaning services at 123 Main St. Reply STOP to opt out"
  );
  assert.equal(segmentInfo(msg).segments, 1, "Talan's typical render must stay 1 segment");
});

test("renderMessage (Talan): null name → 'Hey there busy season...'", () => {
  const msg = renderMessage(TALAN, NULL_CONTACT, BIZ);
  assert.ok(msg.startsWith("Hey there busy season is here,"), `got: "${msg}"`);
});

test("renderMessage (Talan): entity name → 'Hey there' (not 'Hey ACME LLC')", () => {
  const msg = renderMessage(TALAN, ENTITY_CONTACT, BIZ);
  assert.ok(msg.startsWith("Hey there busy season is here,"), `got: "${msg}"`);
  assert.ok(!msg.includes("ACME LLC"), `entity name leaked: "${msg}"`);
});

test("renderMessage (Talan): title-cases ALL-CAPS name and address", () => {
  const msg = renderMessage(TALAN, { firstName: "ROBERT", zip: "32317", address: "7445 BUCK LAKE RD" }, BIZ);
  assert.ok(msg.startsWith("Hey Robert busy season"), `name not title-cased: "${msg}"`);
  assert.ok(msg.includes("at 7445 Buck Lake Rd."), `address not title-cased: "${msg}"`);
  assert.ok(!/[A-Z]{2,}/.test(msg.replace("STOP", "")), `leftover all-caps (besides STOP): "${msg}"`);
});

test("renderMessage (Talan): contains no business name", () => {
  const msg = renderMessage(TALAN, TYPICAL_CONTACT, BIZ);
  assert.ok(!msg.includes(BIZ), `pilot copy must not contain the business name: "${msg}"`);
  assert.ok(!msg.toLowerCase().includes("talan"), `pilot copy must not name the business: "${msg}"`);
});

test("renderMessage (Talan): ends verbatim with 'Reply STOP to opt out' (no period)", () => {
  const msg = renderMessage(TALAN, TYPICAL_CONTACT, BIZ);
  assert.ok(msg.endsWith("Reply STOP to opt out"), `got: "${msg}"`);
});

test("renderMessage (Talan): a moderately long address now KEEPS the clause (2 segments ≤ cap)", () => {
  // Previously this dropped at 1 segment; with the relaxed cap a 2-segment message keeps the clause.
  const longAddress = "1234 " + "Verylongstreetname ".repeat(3) + "Boulevard";
  const msg = renderMessage(TALAN, { firstName: "James", zip: "32301", address: longAddress }, BIZ);
  const seg = segmentInfo(msg);
  assert.ok(seg.segments >= 2, `expected a multi-segment message, got ${seg.segments}`);
  assert.ok(withinSegmentLimit(msg), `must stay within the cap, got ${seg.segments}`);
  assert.ok(msg.includes(" at "), `clause must be kept within the cap: "${msg}"`);
  assert.ok(msg.endsWith("Reply STOP to opt out"), `got: "${msg}"`);
});

test("renderMessage (Talan): drops the address clause only when keeping it would exceed the cap", () => {
  const pathological = "1234 " + "VERYLONGSTREETNAME ".repeat(40) + "BOULEVARD";
  const msg = renderMessage(TALAN, { firstName: "James", zip: "32301", address: pathological }, BIZ);
  assert.ok(!msg.includes(" at "), `over-cap fallback must drop the "at <address>" clause: "${msg}"`);
  assert.ok(
    msg.endsWith("interested in window cleaning services. Reply STOP to opt out"),
    `fallback wording must match the approved no-address copy: "${msg}"`
  );
  assert.ok(withinSegmentLimit(msg), `the dropped fallback itself must be within the cap`);
});

test("renderMessage (Talan): blank address → drops the clause (no dangling 'at ')", () => {
  const msg = renderMessage(TALAN, { firstName: "James", zip: "32301", address: "" }, BIZ);
  assert.ok(!msg.includes(" at "), `must drop the empty-address clause: "${msg}"`);
  assert.ok(msg.endsWith("window cleaning services. Reply STOP to opt out"), `got: "${msg}"`);
});

test("renderMessage (Talan): typical first-name + address fits one segment", () => {
  const info = segmentInfo(renderMessage(TALAN, TYPICAL_CONTACT, BIZ));
  assert.equal(info.segments, 1, `overflows to ${info.segments} segments (${info.length}/${info.encoding})`);
});

// ---------------------------------------------------------------------------
// renderMessage — generic template (any client): placeholder substitution
// ---------------------------------------------------------------------------

const GENERIC = "Hi [NAME], [BIZ] here serving [ZIP]. Want a free quote? Reply STOP to opt out.";

test("renderMessage (generic): substitutes [NAME]/[BIZ]/[ZIP]", () => {
  const msg = renderMessage(GENERIC, { firstName: "James", zip: "32301", address: "x" }, "Acme Co");
  assert.ok(msg.startsWith("Hi James, Acme Co here serving 32301."), `got: "${msg}"`);
  assert.ok(!msg.includes("["), `leftover bracket: "${msg}"`);
});

test("renderMessage (generic): null name → 'Hi there,', null zip → 'your area'", () => {
  const msg = renderMessage(GENERIC, { firstName: null, zip: null, address: "x" }, "Acme Co");
  assert.ok(msg.startsWith("Hi there, Acme Co here serving your area."), `got: "${msg}"`);
});

test("renderMessage: a DIFFERENT template produces DIFFERENT output (template-driven, per the client record)", () => {
  const c = { firstName: "James", zip: "32301", address: "123 Main St" };
  const a = renderMessage("Hey [NAME], offer one. Reply STOP to opt out.", c, "Acme");
  const b = renderMessage("Yo [NAME], offer two. Reply STOP to opt out.", c, "Acme");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("Hey James, offer one."), `got: "${a}"`);
  assert.ok(b.startsWith("Yo James, offer two."), `got: "${b}"`);
});

test("renderMessage: appends the opt-out line if a template omits it (hard guardrail)", () => {
  const msg = renderMessage("Hi [NAME], quick note.", { firstName: "James", zip: null, address: "x" }, "Acme");
  assert.ok(/Reply STOP to opt out\.?$/.test(msg), `guardrail must append opt-out: "${msg}"`);
});

// ---------------------------------------------------------------------------
// optOutInstructionFor + per-client opt-out line (configured keyword like "2")
// ---------------------------------------------------------------------------

test("optOutInstructionFor: keyword '2' → Reply \"2\" to opt out", () => {
  assert.equal(optOutInstructionFor("2", null), 'Reply "2" to opt out');
});
test("optOutInstructionFor: null keyword → default Reply STOP to opt out", () => {
  assert.equal(optOutInstructionFor(null, null), "Reply STOP to opt out");
});
test("optOutInstructionFor: an explicit instruction wins verbatim", () => {
  assert.equal(optOutInstructionFor("2", "Txt 2 2 stop"), "Txt 2 2 stop");
});

const POWERWASH =
  'Hey [NAME], this is the crew working near [ADDRESS] — want a free quote on pressure washing? Reply "2" to opt out';

test('renderMessage (keyword "2" client): keeps Reply "2" to opt out, never appends a STOP line', () => {
  const line = optOutInstructionFor("2", null);
  const msg = renderMessage(
    POWERWASH,
    { firstName: "Chris", zip: "32801", address: "1424 EDGEWATER DR" },
    "",
    line
  );
  assert.ok(msg.endsWith('Reply "2" to opt out'), `got: "${msg}"`);
  // No contradictory / double opt-out line.
  assert.ok(!msg.includes("Reply STOP to opt out"), `must not contain a STOP line: "${msg}"`);
  assert.equal(msg.match(/to opt out/g)?.length, 1, `exactly one opt-out line: "${msg}"`);
});

test('renderMessage (keyword "2" client): appends Reply "2" to opt out when the template omits it', () => {
  const line = optOutInstructionFor("2", null);
  const msg = renderMessage("Hi [NAME], quick powerwash note.", { firstName: "Chris", zip: null, address: "x" }, "", line);
  assert.ok(msg.endsWith('Reply "2" to opt out'), `must append the per-client line: "${msg}"`);
  assert.ok(!msg.includes("Reply STOP to opt out"), `must not append a STOP line: "${msg}"`);
});

test("renderMessage (Talan): passing the derived STOP-only instruction is BYTE-IDENTICAL to the default", () => {
  const c = { firstName: "James", zip: "32301", address: "7445 BUCK LAKE RD" };
  const withDefault = renderMessage(TALAN_MESSAGE_TEMPLATE, c, BIZ);
  const withDerived = renderMessage(TALAN_MESSAGE_TEMPLATE, c, BIZ, optOutInstructionFor(null, null));
  assert.equal(withDerived, withDefault, "client-1 render must not change when threading the derived opt-out line");
  assert.ok(withDefault.endsWith("Reply STOP to opt out"));
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
  const info = segmentInfo("A".repeat(160));
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 1);
});

test("segmentInfo: 161-char ASCII string → GSM-7, 2 segments", () => {
  const info = segmentInfo("A".repeat(161));
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 2);
  assert.equal(info.length, 161);
});

test("segmentInfo: 306-char ASCII string → GSM-7, 2 segments (2×153)", () => {
  const info = segmentInfo("A".repeat(306));
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 2);
});

test("segmentInfo: 307-char ASCII string → GSM-7, 3 segments", () => {
  const info = segmentInfo("A".repeat(307));
  assert.equal(info.encoding, "GSM-7");
  assert.equal(info.segments, 3);
});

test("segmentInfo: string with emoji → UCS-2", () => {
  assert.equal(segmentInfo("Hello 🎉").encoding, "UCS-2");
});

test("segmentInfo: short UCS-2 string → 1 segment (≤ 70 chars)", () => {
  const info = segmentInfo("Hello 世界");
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.segments, 1);
});

test("segmentInfo: exactly 70-char UCS-2 string → 1 segment", () => {
  const info = segmentInfo("世" + "A".repeat(69));
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.length, 70);
  assert.equal(info.segments, 1);
});

test("segmentInfo: 71-char UCS-2 string → 2 segments", () => {
  const info = segmentInfo("世" + "A".repeat(70));
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.length, 71);
  assert.equal(info.segments, 2);
});

test("segmentInfo: 134-char UCS-2 string → 2 segments (2×67)", () => {
  const info = segmentInfo("世" + "A".repeat(133));
  assert.equal(info.encoding, "UCS-2");
  assert.equal(info.segments, 2);
});

test("segmentInfo: 135-char UCS-2 string → 3 segments", () => {
  const info = segmentInfo("世" + "A".repeat(134));
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
  assert.equal(withinSingleSegment("世" + "A".repeat(70)), false);
});

// ---------------------------------------------------------------------------
// withinSegmentLimit / MAX_MESSAGE_SEGMENTS — the campaign send-guard predicate
// ---------------------------------------------------------------------------
// The send loop drains a contact to 'failed' iff `!withinSegmentLimit(body)`. These prove a 1–3
// segment message PASSES the guard (sends) and a 4+ segment message is drained (fail-closed cap).

test("MAX_MESSAGE_SEGMENTS default is 3", () => {
  assert.equal(MAX_MESSAGE_SEGMENTS, 3);
});

test("withinSegmentLimit: a 1-segment message passes (would send)", () => {
  // 1 segment = up to 160 GSM-7 units.
  assert.equal(segmentInfo("A".repeat(160)).segments, 1);
  assert.equal(withinSegmentLimit("A".repeat(160)), true);
});

test("withinSegmentLimit: a 2-segment message passes (would send, NOT drained)", () => {
  const body = "A".repeat(200); // 200 > 160 → 2 segments
  assert.equal(segmentInfo(body).segments, 2);
  assert.equal(withinSegmentLimit(body), true);
});

test("withinSegmentLimit: a 3-segment message (at the cap) passes", () => {
  const body = "A".repeat(459); // ceil(459/153) = 3
  assert.equal(segmentInfo(body).segments, 3);
  assert.equal(withinSegmentLimit(body), true);
});

test("withinSegmentLimit: a 4-segment message is OVER the cap → drained (guard fails)", () => {
  const body = "A".repeat(460); // ceil(460/153) = 4
  assert.equal(segmentInfo(body).segments, 4);
  assert.equal(withinSegmentLimit(body), false);
});

test("withinSegmentLimit: a custom max is honored", () => {
  const twoSeg = "A".repeat(200);
  assert.equal(withinSegmentLimit(twoSeg, 1), false);
  assert.equal(withinSegmentLimit(twoSeg, 2), true);
});

// ---------------------------------------------------------------------------
// renderMessage (Talan) — REAL DATA proof (session-6.md Task 0)
//   Every real contact must render single-segment AND end with the opt-out line.
//   The longest real addresses must STILL fit with the address (no fallback).
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

test("renderMessage (Talan): ALL 500 real contacts render WITHIN the segment cap + opt-out line", () => {
  const rows = loadPilotContacts();
  assert.ok(rows.length >= 500, `expected ~500 rows, got ${rows.length}`);
  for (const row of rows) {
    const msg = renderMessage(TALAN, { firstName: row.firstName, zip: row.zip, address: row.address }, BIZ);
    assert.ok(
      withinSegmentLimit(msg),
      `Row "${row.firstName} / ${row.address}" over cap: ${JSON.stringify(segmentInfo(msg))} — "${msg}"`
    );
    assert.ok(
      msg.endsWith("Reply STOP to opt out"),
      `Row "${row.firstName} / ${row.address}" missing verbatim opt-out line — "${msg}"`
    );
  }
});

test("renderMessage (Talan): the LONGEST real addresses stay within the cap (clause kept up to the cap)", () => {
  const rows = loadPilotContacts();
  const longest = [...rows].sort((a, b) => b.address.length - a.address.length).slice(0, 10);
  assert.ok(longest[0].address.length >= 24, `expected a long real address, got "${longest[0].address}"`);
  for (const row of longest) {
    const msg = renderMessage(TALAN, { firstName: row.firstName, zip: row.zip, address: row.address }, BIZ);
    assert.ok(
      withinSegmentLimit(msg),
      `Longest address row over cap — ${JSON.stringify(segmentInfo(msg))} — "${msg}"`
    );
    assert.ok(msg.endsWith("Reply STOP to opt out"), `Missing opt-out line — "${msg}"`);
  }
});

test("renderMessage (Talan): the address clause is retained for nearly all real contacts (fallback is rare)", () => {
  const rows = loadPilotContacts();
  let retained = 0;
  for (const row of rows) {
    const msg = renderMessage(TALAN, { firstName: row.firstName, zip: row.zip, address: row.address }, BIZ);
    if (msg.includes(" at ")) retained++;
  }
  assert.ok(
    retained >= rows.length - 10,
    `Fallback dropped the address on ${rows.length - retained}/${rows.length} contacts (expected ≤ 10)`
  );
});
