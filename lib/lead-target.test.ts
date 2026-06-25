import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentTargetPeriod,
  effectiveLeadTarget,
  nextPeriodLabel,
  toTargetPeriod,
} from "./lead-target";

// Pure lead-target + period math for the V6 deliver-then-stop gate. All UTC so deterministic. The
// load-bearing properties: the effective target falls back to the guarantee, the current period
// window containing `now` is correct for both 'week' (Mon–Mon UTC) and 'month' (billing cycle), and
// shifting `now` a week shifts the week window exactly a week (clean period rollover).

const iso = (d: Date) => d.toISOString().slice(0, 10);

test("toTargetPeriod: only 'week' maps to week; everything else → month", () => {
  assert.equal(toTargetPeriod("week"), "week");
  assert.equal(toTargetPeriod("month"), "month");
  assert.equal(toTargetPeriod(null), "month");
  assert.equal(toTargetPeriod(undefined), "month");
  assert.equal(toTargetPeriod("nonsense"), "month");
});

test("effectiveLeadTarget: null/non-finite → guarantee; else floored, clamped >= 0", () => {
  assert.equal(effectiveLeadTarget(null, 50), 50);
  assert.equal(effectiveLeadTarget(undefined, 50), 50);
  assert.equal(effectiveLeadTarget(NaN, 50), 50);
  assert.equal(effectiveLeadTarget(15, 50), 15);
  assert.equal(effectiveLeadTarget(2, 50), 2);
  assert.equal(effectiveLeadTarget(2.9, 50), 2);
  assert.equal(effectiveLeadTarget(-3, 50), 0);
});

test("month period delegates to the billing cycle (null billing_day → calendar month)", () => {
  const w = currentTargetPeriod(new Date(Date.UTC(2026, 5, 20, 12)), "month", null);
  assert.equal(w.period, "month");
  assert.equal(iso(w.start), "2026-06-01");
  assert.equal(iso(w.end), "2026-07-01");
});

test("month period honors a set billing_day", () => {
  const w = currentTargetPeriod(new Date(Date.UTC(2026, 5, 20, 12)), "month", 15);
  assert.equal(iso(w.start), "2026-06-15");
  assert.equal(iso(w.end), "2026-07-15");
});

test("week period: ISO week Mon..Mon (UTC) containing now", () => {
  // 2026-06-10 is a Wednesday → week is Mon Jun 8 .. Mon Jun 15.
  const w = currentTargetPeriod(new Date(Date.UTC(2026, 5, 10, 9)), "week", null);
  assert.equal(w.period, "week");
  assert.equal(iso(w.start), "2026-06-08");
  assert.equal(iso(w.end), "2026-06-15");
});

test("week period: a Monday is its own week start (inclusive)", () => {
  const w = currentTargetPeriod(new Date(Date.UTC(2026, 5, 8, 0)), "week", null);
  assert.equal(iso(w.start), "2026-06-08");
  assert.equal(iso(w.end), "2026-06-15");
});

test("week period: a Sunday belongs to the week that started the prior Monday", () => {
  // 2026-06-14 is a Sunday → still in the Jun 8..15 week (end is exclusive Mon Jun 15).
  const w = currentTargetPeriod(new Date(Date.UTC(2026, 5, 14, 23)), "week", null);
  assert.equal(iso(w.start), "2026-06-08");
  assert.equal(iso(w.end), "2026-06-15");
});

test("week period rolls over cleanly: now + 7 days → window + 7 days", () => {
  const a = currentTargetPeriod(new Date(Date.UTC(2026, 5, 10, 9)), "week", null);
  const b = currentTargetPeriod(new Date(Date.UTC(2026, 5, 17, 9)), "week", null);
  assert.equal(iso(b.start), "2026-06-15");
  assert.equal(iso(b.end), "2026-06-22");
  // A lead dated inside week A is NOT inside week B — exactly one period contains it.
  assert.equal(a.end.getTime(), b.start.getTime());
});

test("nextPeriodLabel is the YYYY-MM-DD of the period end", () => {
  const w = currentTargetPeriod(new Date(Date.UTC(2026, 5, 20, 12)), "month", null);
  assert.equal(nextPeriodLabel(w.end), "2026-07-01");
});
