import { test } from "node:test";
import assert from "node:assert/strict";
import { currentCycle, expectedLeads, paceFlag } from "./billing-cycle";

// Billing-cycle + pace math for the operator cockpit. All dates are UTC so the assertions are
// deterministic regardless of the machine timezone. The load-bearing properties: the cycle that
// CONTAINS `now` is identified correctly (incl. short-month clamping), and the pace flag matches
// the straight-line expectation (behind / on track / met).

const iso = (d: Date) => d.toISOString().slice(0, 10);

test("null billing_day → calendar month", () => {
  const c = currentCycle(new Date(Date.UTC(2026, 5, 24)), null); // 2026-06-24
  assert.equal(iso(c.start), "2026-06-01");
  assert.equal(iso(c.end), "2026-07-01");
  assert.equal(c.cycleLengthDays, 30);
  assert.equal(c.daysElapsed, 23); // Jun 1 00:00 → Jun 24 00:00
  assert.equal(c.daysLeft, 7); // Jun 24 → Jul 1
});

test("billing_day mid-month, now AFTER the anchor → cycle started this month", () => {
  const c = currentCycle(new Date(Date.UTC(2026, 5, 24)), 15); // 2026-06-24
  assert.equal(iso(c.start), "2026-06-15");
  assert.equal(iso(c.end), "2026-07-15");
});

test("billing_day mid-month, now BEFORE the anchor → cycle started last month", () => {
  const c = currentCycle(new Date(Date.UTC(2026, 5, 10)), 15); // 2026-06-10
  assert.equal(iso(c.start), "2026-05-15");
  assert.equal(iso(c.end), "2026-06-15");
});

test("billing_day 31 clamps in a short month (now before the clamped anchor)", () => {
  const c = currentCycle(new Date(Date.UTC(2026, 1, 10)), 31); // 2026-02-10, Feb clamps to 28
  assert.equal(iso(c.start), "2026-01-31");
  assert.equal(iso(c.end), "2026-02-28");
  assert.equal(c.cycleLengthDays, 28);
});

test("billing_day 31 clamps to the prior short month's last day as the cycle start", () => {
  const c = currentCycle(new Date(Date.UTC(2026, 2, 15)), 31); // 2026-03-15
  assert.equal(iso(c.start), "2026-02-28"); // Feb anchor clamps to 28
  assert.equal(iso(c.end), "2026-03-31");
});

test("expectedLeads is the straight-line fraction of the guarantee", () => {
  assert.equal(expectedLeads(50, 15, 30), 25);
  assert.equal(expectedLeads(50, 0, 30), 0);
  assert.equal(expectedLeads(50, 30, 30), 50);
  assert.equal(expectedLeads(50, 10, 0), 0); // guard div-by-zero
});

test("paceFlag: met once the guarantee is reached (even early)", () => {
  assert.equal(paceFlag(50, 50, 5, 30), "met");
  assert.equal(paceFlag(60, 50, 5, 30), "met");
});

test("paceFlag: behind when under the straight-line expectation", () => {
  assert.equal(paceFlag(5, 50, 15, 30), "behind"); // expected 25
});

test("paceFlag: on track when at/above the expectation", () => {
  assert.equal(paceFlag(30, 50, 15, 30), "on_track"); // expected 25
  assert.equal(paceFlag(25, 50, 15, 30), "on_track"); // exactly on the line
});

test("paceFlag: day 0 with no leads reads on_track, not behind", () => {
  assert.equal(paceFlag(0, 50, 0, 30), "on_track");
});
