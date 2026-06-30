/**
 * lib/followup-audience.test.ts — unit tests for the PURE follow-up audience rule.
 * Runner: `tsx --test lib/*.test.ts`. Pure (no DB), so it runs under `npm test`.
 *
 * Proves the audience EXCLUDES responders, leads, opt-outs, suppressed, not-sent, no-phone, and
 * already-followed-up (cap) contacts, INCLUDES a clean non-responder, and that the cap makes
 * re-running idempotent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFollowupEligible,
  selectFollowupAudience,
  clampMaxFollowups,
  DEFAULT_MAX_FOLLOWUPS,
  type FollowupCandidate,
} from "./followup-audience";

/** A clean non-responder (the one shape that SHOULD be in the audience). Override per test. */
function candidate(over: Partial<FollowupCandidate> = {}): FollowupCandidate {
  return {
    id: 1,
    phone: "8505551234",
    was_sent: true,
    suppressed: false,
    replied: false,
    is_lead: false,
    opted_out: false,
    prior_followups: 0,
    ...over,
  };
}

// --- inclusion --------------------------------------------------------------

test("includes a sent, clean, non-responding, never-followed-up contact", () => {
  assert.equal(isFollowupEligible(candidate()), true);
});

// --- each exclusion ---------------------------------------------------------

test("excludes a contact that was never sent", () => {
  assert.equal(isFollowupEligible(candidate({ was_sent: false })), false);
});

test("excludes a contact with no phone (null and blank)", () => {
  assert.equal(isFollowupEligible(candidate({ phone: null })), false);
  assert.equal(isFollowupEligible(candidate({ phone: "   " })), false);
});

test("excludes a suppressed contact", () => {
  assert.equal(isFollowupEligible(candidate({ suppressed: true })), false);
});

test("excludes a responder (replied)", () => {
  assert.equal(isFollowupEligible(candidate({ replied: true })), false);
});

test("excludes a lead", () => {
  assert.equal(isFollowupEligible(candidate({ is_lead: true })), false);
});

test("excludes an opted-out contact", () => {
  assert.equal(isFollowupEligible(candidate({ opted_out: true })), false);
});

// --- the follow-up cap / idempotency ----------------------------------------

test("excludes a contact at/over the follow-up cap (default max = 1)", () => {
  assert.equal(DEFAULT_MAX_FOLLOWUPS, 1);
  assert.equal(isFollowupEligible(candidate({ prior_followups: 1 })), false);
  assert.equal(isFollowupEligible(candidate({ prior_followups: 2 })), false);
});

test("cap is configurable: max=2 admits a once-followed-up contact, excludes twice", () => {
  assert.equal(isFollowupEligible(candidate({ prior_followups: 1 }), 2), true);
  assert.equal(isFollowupEligible(candidate({ prior_followups: 2 }), 2), false);
});

test("idempotency: a contact already in a follow-up round drops out next time (default cap)", () => {
  // First round: prior_followups=0 → eligible. After seeding, prior_followups becomes 1 → not eligible.
  assert.equal(isFollowupEligible(candidate({ prior_followups: 0 })), true);
  assert.equal(isFollowupEligible(candidate({ prior_followups: 1 })), false);
});

// --- selectFollowupAudience -------------------------------------------------

test("selectFollowupAudience keeps only the eligible rows, in order", () => {
  const rows = [
    candidate({ id: 1 }), // eligible
    candidate({ id: 2, replied: true }), // responder → out
    candidate({ id: 3, is_lead: true }), // lead → out
    candidate({ id: 4, opted_out: true }), // opted out → out
    candidate({ id: 5, prior_followups: 1 }), // capped → out
    candidate({ id: 6 }), // eligible
  ];
  assert.deepEqual(
    selectFollowupAudience(rows).map((r) => r.id),
    [1, 6]
  );
});

// --- clampMaxFollowups -------------------------------------------------------

test("clampMaxFollowups: defaults, floors, and bounds", () => {
  assert.equal(clampMaxFollowups(undefined), DEFAULT_MAX_FOLLOWUPS);
  assert.equal(clampMaxFollowups(null), DEFAULT_MAX_FOLLOWUPS);
  assert.equal(clampMaxFollowups(Number.NaN), DEFAULT_MAX_FOLLOWUPS);
  assert.equal(clampMaxFollowups(0), 1);
  assert.equal(clampMaxFollowups(-3), 1);
  assert.equal(clampMaxFollowups(2.9), 2);
  assert.equal(clampMaxFollowups(999), 10);
});
