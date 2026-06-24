/**
 * scrub.test.ts — unit tests for lib/scrub's pure logic.
 *
 * Runner: Node built-in test module via `tsx --test lib/*.test.ts`.
 * Covers the credit pre-flight threshold (the 2026-06-23 credit-safety fix) and the
 * fail-closed classify() verdict contract. The DB-backed selection/re-billing fix
 * (getContactsForScrub excludes scrub_status='clean') is proven by a live fixture, not here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  creditsCoverScrub,
  InsufficientCreditsError,
  SCRUB_CREDITS_PER_PHONE,
  type ScrubReason,
} from "./scrub-logic";
import type { ScrubResultRow } from "./tracerfy";

// ============================================================================
// creditsCoverScrub — the pre-flight threshold (refuse before spending)
// ============================================================================

test("creditsCoverScrub: exact balance covers exactly the pending count", () => {
  assert.equal(creditsCoverScrub(175, 175), true);
});

test("creditsCoverScrub: surplus balance covers", () => {
  assert.equal(creditsCoverScrub(501, 175), true);
});

test("creditsCoverScrub: one short → refuse", () => {
  assert.equal(creditsCoverScrub(174, 175), false);
});

test("creditsCoverScrub: the live bug state (1 credit, 175 pending) → refuse", () => {
  assert.equal(creditsCoverScrub(1, 175), false);
});

test("creditsCoverScrub: zero pending is always coverable (nothing to bill)", () => {
  assert.equal(creditsCoverScrub(0, 0), true);
});

test("creditsCoverScrub: cost scales by SCRUB_CREDITS_PER_PHONE", () => {
  // Guards the cost constant the pre-flight + the 'need N' report rely on.
  assert.equal(SCRUB_CREDITS_PER_PHONE, 1);
  assert.equal(creditsCoverScrub(10, 10), true);
  assert.equal(creditsCoverScrub(9, 10 * SCRUB_CREDITS_PER_PHONE), false);
});

// ============================================================================
// InsufficientCreditsError — shape the route maps to a 402 and the CLI prints
// ============================================================================

test("InsufficientCreditsError carries credits/needed/pending", () => {
  const e = new InsufficientCreditsError(1, 175, 175);
  assert.equal(e.credits, 1);
  assert.equal(e.needed, 175);
  assert.equal(e.pending, 175);
  assert.equal(e.name, "InsufficientCreditsError");
  assert.ok(e instanceof Error);
});

// ============================================================================
// classify — fail-closed verdicts (UNCHANGED logic; documents the contract)
// ============================================================================

function row(over: Partial<ScrubResultRow>): ScrubResultRow {
  return {
    phone: "8505550000",
    federalDnc: false,
    stateDnc: false,
    dma: false,
    litigator: false,
    isClean: true,
    ...over,
  };
}

test("classify: missing result → scrub_error (fail closed)", () => {
  assert.equal(classify(undefined), "scrub_error" as ScrubReason);
});

test("classify: litigator wins over everything", () => {
  assert.equal(classify(row({ litigator: true, isClean: true })), "litigator");
});

test("classify: federal DNC → dnc", () => {
  assert.equal(classify(row({ federalDnc: true, isClean: false })), "dnc");
});

test("classify: state DNC → dnc", () => {
  assert.equal(classify(row({ stateDnc: true, isClean: false })), "dnc");
});

test("classify: DMA → dnc", () => {
  assert.equal(classify(row({ dma: true, isClean: false })), "dnc");
});

test("classify: explicit clean, no flags → null (eligible)", () => {
  assert.equal(classify(row({ isClean: true })), null);
});

test("classify: not flagged but not explicitly clean → scrub_error (fail closed)", () => {
  assert.equal(classify(row({ isClean: false })), "scrub_error");
});
