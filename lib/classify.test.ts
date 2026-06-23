/**
 * classify.test.ts — unit tests for lib/classify
 *
 * Runner: Node built-in test module via `tsx --test lib/*.test.ts`
 * No extra test-framework dependencies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOptOut, classifyInterest } from "./classify";

// ============================================================================
// isOptOut — comprehensive coverage
// ============================================================================

test("isOptOut: bare CTIA mandatory keyword STOP (lower)", () => {
  assert.equal(isOptOut("stop"), true);
});

test("isOptOut: bare CTIA keyword STOP (upper)", () => {
  assert.equal(isOptOut("STOP"), true);
});

test("isOptOut: bare CTIA keyword STOP (mixed case)", () => {
  assert.equal(isOptOut("Stop"), true);
});

test("isOptOut: STOP with leading/trailing whitespace", () => {
  assert.equal(isOptOut("  stop  "), true);
});

test("isOptOut: STOP with trailing space only", () => {
  assert.equal(isOptOut("stop "), true);
});

test("isOptOut: STOP with punctuation suffix — STOP!", () => {
  assert.equal(isOptOut("STOP!"), true);
});

test("isOptOut: STOP with punctuation suffix — STOP.", () => {
  assert.equal(isOptOut("STOP."), true);
});

test("isOptOut: STOP with punctuation — STOP,", () => {
  assert.equal(isOptOut("STOP,"), true);
});

test("isOptOut: STOPALL (single word)", () => {
  assert.equal(isOptOut("STOPALL"), true);
});

test("isOptOut: stopall (lower)", () => {
  assert.equal(isOptOut("stopall"), true);
});

test("isOptOut: STOP ALL (two words, upper)", () => {
  assert.equal(isOptOut("STOP ALL"), true);
});

test("isOptOut: stop all (two words, lower)", () => {
  assert.equal(isOptOut("stop all"), true);
});

test("isOptOut: UNSUBSCRIBE", () => {
  assert.equal(isOptOut("UNSUBSCRIBE"), true);
});

test("isOptOut: unsubscribe (lower)", () => {
  assert.equal(isOptOut("unsubscribe"), true);
});

test("isOptOut: CANCEL", () => {
  assert.equal(isOptOut("CANCEL"), true);
});

test("isOptOut: cancel (lower)", () => {
  assert.equal(isOptOut("cancel"), true);
});

test("isOptOut: END", () => {
  assert.equal(isOptOut("END"), true);
});

test("isOptOut: end (lower)", () => {
  assert.equal(isOptOut("end"), true);
});

test("isOptOut: QUIT", () => {
  assert.equal(isOptOut("QUIT"), true);
});

test("isOptOut: quit (lower)", () => {
  assert.equal(isOptOut("quit"), true);
});

test("isOptOut: OPTOUT (single word)", () => {
  assert.equal(isOptOut("OPTOUT"), true);
});

test("isOptOut: optout (lower)", () => {
  assert.equal(isOptOut("optout"), true);
});

test("isOptOut: OPT OUT (two words)", () => {
  assert.equal(isOptOut("OPT OUT"), true);
});

test("isOptOut: opt out (two words, lower)", () => {
  assert.equal(isOptOut("opt out"), true);
});

test("isOptOut: REMOVE", () => {
  assert.equal(isOptOut("REMOVE"), true);
});

test("isOptOut: remove (lower)", () => {
  assert.equal(isOptOut("remove"), true);
});

// Embedded in a sentence — fail-safe rule: keyword as token → opt-out
test("isOptOut: 'please stop' — ambiguity leans toward opt-out (fail-safe rule)", () => {
  // The word 'stop' is clearly a token in this phrase; we treat it as opt-out.
  assert.equal(isOptOut("please stop"), true);
});

test("isOptOut: 'stop texting me'", () => {
  assert.equal(isOptOut("stop texting me"), true);
});

test("isOptOut: 'remove me from your list'", () => {
  assert.equal(isOptOut("remove me from your list"), true);
});

test("isOptOut: 'stop all messages please'", () => {
  assert.equal(isOptOut("stop all messages please"), true);
});

test("isOptOut: 'I would like to unsubscribe'", () => {
  assert.equal(isOptOut("I would like to unsubscribe"), true);
});

test("isOptOut: 'please cancel'", () => {
  assert.equal(isOptOut("please cancel"), true);
});

test("isOptOut: keyword mid-sentence 'can you end these texts?'", () => {
  assert.equal(isOptOut("can you end these texts?"), true);
});

test("isOptOut: 'quit it already'", () => {
  assert.equal(isOptOut("quit it already"), true);
});

// Must NOT trigger — keyword must be a token, not a substring of another word
test("isOptOut: 'stopping' does NOT trigger stop", () => {
  // 'stopping' contains 'stop' but not as a standalone token — must NOT match
  assert.equal(isOptOut("stopping by tomorrow"), false);
});

test("isOptOut: 'endpoint' does NOT trigger 'end'", () => {
  assert.equal(isOptOut("endpoint configuration"), false);
});

test("isOptOut: 'cancellation' does NOT trigger 'cancel'", () => {
  assert.equal(isOptOut("cancellation policy"), false);
});

test("isOptOut: 'removal' does NOT trigger 'remove'", () => {
  assert.equal(isOptOut("window removal service"), false);
});

// Positive interested reply must NOT trigger opt-out
test("isOptOut: normal interested reply 'yes how much?' — must NOT trigger", () => {
  assert.equal(isOptOut("yes how much?"), false);
});

test("isOptOut: 'Sounds good, when can you come out?' — must NOT trigger", () => {
  assert.equal(isOptOut("Sounds good, when can you come out?"), false);
});

test("isOptOut: 'I'm interested, send me pricing' — must NOT trigger", () => {
  assert.equal(isOptOut("I'm interested, send me pricing"), false);
});

test("isOptOut: empty string returns false", () => {
  assert.equal(isOptOut(""), false);
});

// Document and exercise the ambiguous-leans-opt-out rule explicitly
test("isOptOut: ambiguity rule — 'I might want to stop getting these' treated as opt-out", () => {
  // Rule: if any opt-out keyword appears as a token anywhere in the message,
  // we return true. 'stop' is a token here. False positive is safer.
  assert.equal(isOptOut("I might want to stop getting these"), true);
});

test("isOptOut: ambiguity rule — 'maybe remove me?' treated as opt-out", () => {
  assert.equal(isOptOut("maybe remove me?"), true);
});

// ============================================================================
// classifyInterest — coverage across all three buckets
// ============================================================================

// --- INTERESTED ---

test("classifyInterest: 'yes' → interested", () => {
  assert.equal(classifyInterest("yes"), "interested");
});

test("classifyInterest: 'Yes!' → interested", () => {
  assert.equal(classifyInterest("Yes!"), "interested");
});

test("classifyInterest: 'yep' → interested", () => {
  assert.equal(classifyInterest("yep"), "interested");
});

test("classifyInterest: 'yeah' → interested", () => {
  assert.equal(classifyInterest("yeah"), "interested");
});

test("classifyInterest: 'sure' → interested", () => {
  assert.equal(classifyInterest("sure"), "interested");
});

test("classifyInterest: 'interested' → interested", () => {
  assert.equal(classifyInterest("interested"), "interested");
});

test("classifyInterest: 'how much does it cost?' → interested", () => {
  assert.equal(classifyInterest("how much does it cost?"), "interested");
});

test("classifyInterest: 'what's the cost?' → interested", () => {
  assert.equal(classifyInterest("what's the cost?"), "interested");
});

test("classifyInterest: 'can I get a quote?' → interested", () => {
  assert.equal(classifyInterest("can I get a quote?"), "interested");
});

test("classifyInterest: 'what's your pricing?' → interested", () => {
  assert.equal(classifyInterest("what's your pricing?"), "interested");
});

test("classifyInterest: 'when can you come out?' → interested", () => {
  assert.equal(classifyInterest("when can you come out?"), "interested");
});

test("classifyInterest: 'I'd like to schedule something' → interested", () => {
  assert.equal(classifyInterest("I'd like to schedule something"), "interested");
});

test("classifyInterest: 'are you available this week?' → interested", () => {
  assert.equal(classifyInterest("are you available this week?"), "interested");
});

test("classifyInterest: 'can you book me in?' → interested", () => {
  assert.equal(classifyInterest("can you book me in?"), "interested");
});

test("classifyInterest: 'sounds good!' → interested", () => {
  assert.equal(classifyInterest("sounds good!"), "interested");
});

test("classifyInterest: 'tell me more' → interested", () => {
  assert.equal(classifyInterest("tell me more"), "interested");
});

test("classifyInterest: 'please call me' → interested", () => {
  assert.equal(classifyInterest("please call me"), "interested");
});

test("classifyInterest: 'I'm interested, what's the price?' → interested", () => {
  assert.equal(
    classifyInterest("I'm interested, what's the price?"),
    "interested",
  );
});

// --- NOT_INTERESTED ---

test("classifyInterest: 'no' → not_interested", () => {
  assert.equal(classifyInterest("no"), "not_interested");
});

test("classifyInterest: 'No' → not_interested", () => {
  assert.equal(classifyInterest("No"), "not_interested");
});

test("classifyInterest: 'nope' → not_interested", () => {
  assert.equal(classifyInterest("nope"), "not_interested");
});

test("classifyInterest: 'no thanks' → not_interested", () => {
  assert.equal(classifyInterest("no thanks"), "not_interested");
});

test("classifyInterest: 'No thank you' → not_interested", () => {
  assert.equal(classifyInterest("No thank you"), "not_interested");
});

test("classifyInterest: 'not interested' → not_interested", () => {
  assert.equal(classifyInterest("not interested"), "not_interested");
});

test("classifyInterest: 'Not interested thanks' → not_interested", () => {
  assert.equal(classifyInterest("Not interested thanks"), "not_interested");
});

test("classifyInterest: 'remove me' → not_interested", () => {
  assert.equal(classifyInterest("remove me"), "not_interested");
});

test("classifyInterest: 'take me off your list' → not_interested", () => {
  assert.equal(classifyInterest("take me off your list"), "not_interested");
});

test("classifyInterest: 'wrong number' → not_interested", () => {
  assert.equal(classifyInterest("wrong number"), "not_interested");
});

test("classifyInterest: 'not looking right now' → not_interested", () => {
  assert.equal(classifyInterest("not looking right now"), "not_interested");
});

test("classifyInterest: 'don't text me' → not_interested", () => {
  assert.equal(classifyInterest("don't text me"), "not_interested");
});

test("classifyInterest: 'do not contact me' → not_interested", () => {
  assert.equal(classifyInterest("do not contact me"), "not_interested");
});

// Rejection wins over positive signal (not_interested checked first)
test("classifyInterest: 'no thanks but how much?' — rejection wins → not_interested", () => {
  // 'no thanks' is an explicit rejection; classification stops there.
  assert.equal(classifyInterest("no thanks but how much?"), "not_interested");
});

// --- NEUTRAL ---

test("classifyInterest: 'ok' → neutral", () => {
  assert.equal(classifyInterest("ok"), "neutral");
});

test("classifyInterest: 'thanks' → neutral", () => {
  assert.equal(classifyInterest("thanks"), "neutral");
});

test("classifyInterest: 'got it' → neutral", () => {
  assert.equal(classifyInterest("got it"), "neutral");
});

test("classifyInterest: emoji-only '👍' → neutral", () => {
  assert.equal(classifyInterest("👍"), "neutral");
});

test("classifyInterest: '?' → neutral", () => {
  assert.equal(classifyInterest("?"), "neutral");
});

test("classifyInterest: 'who is this?' → neutral", () => {
  assert.equal(classifyInterest("who is this?"), "neutral");
});

test("classifyInterest: 'huh' → neutral", () => {
  assert.equal(classifyInterest("huh"), "neutral");
});

test("classifyInterest: 'maybe later' → neutral (ambiguous, human decides)", () => {
  // 'maybe later' could be soft-interested but lacks a clear positive signal.
  // Bias: neutral so a human (Talan) follows up if they choose.
  assert.equal(classifyInterest("maybe later"), "neutral");
});

test("classifyInterest: 'I'll think about it' → neutral", () => {
  assert.equal(classifyInterest("I'll think about it"), "neutral");
});

test("classifyInterest: empty string → neutral", () => {
  assert.equal(classifyInterest(""), "neutral");
});
