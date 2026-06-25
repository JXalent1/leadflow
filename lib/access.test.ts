import { test } from "node:test";
import assert from "node:assert/strict";
import { isOperator, resolveClientIdForUser } from "./access";
import { DEFAULT_CLIENT_ID } from "./constants";
import { isLockedOut, recordFailure, clearAttempts } from "./login-throttle";

// The access-control chokepoint that closes the V1 ?clientId= gate. These are the load-bearing
// rules: an operator may act on any client; a client user is hard-locked to their own client_id
// and any foreign client id is rejected.

const operator = { id: 1, role: "operator", client_id: null };
const client2 = { id: 2, role: "client", client_id: 2 };

test("isOperator only for the operator role", () => {
  assert.equal(isOperator(operator), true);
  assert.equal(isOperator(client2), false);
  assert.equal(isOperator(null), false);
});

test("operator may act on any requested client (else default)", () => {
  assert.equal(resolveClientIdForUser(operator, 1), 1);
  assert.equal(resolveClientIdForUser(operator, 2), 2);
  assert.equal(resolveClientIdForUser(operator, undefined), DEFAULT_CLIENT_ID);
  assert.equal(resolveClientIdForUser(operator, 0), DEFAULT_CLIENT_ID); // invalid → default
});

test("client user is locked to their own client_id", () => {
  assert.equal(resolveClientIdForUser(client2, undefined), 2); // no param → own
  assert.equal(resolveClientIdForUser(client2, 2), 2); // own id → ok
});

test("client user requesting ANOTHER client is rejected (the closed gate)", () => {
  assert.equal(resolveClientIdForUser(client2, 1), null); // ?clientId=1 → DENIED
  assert.equal(resolveClientIdForUser(client2, 999), null);
});

test("a misconfigured client user (no client_id) is rejected", () => {
  assert.equal(resolveClientIdForUser({ id: 3, role: "client", client_id: null }, undefined), null);
});

test("no user → no access", () => {
  assert.equal(resolveClientIdForUser(null, 1), null);
  assert.equal(resolveClientIdForUser(undefined, undefined), null);
});

// ---- login throttle --------------------------------------------------------

test("login throttle locks out after MAX_ATTEMPTS within the window, clears on success", () => {
  const key = "brute@example.com";
  const t0 = 5_000_000;
  clearAttempts(key);
  for (let i = 0; i < 4; i++) recordFailure(key, t0);
  assert.equal(isLockedOut(key, t0), false); // 4 failures, still allowed
  recordFailure(key, t0); // 5th
  assert.equal(isLockedOut(key, t0), true); // locked
  // window rolls off
  assert.equal(isLockedOut(key, t0 + 16 * 60 * 1000), false);
  // a success clears immediately
  for (let i = 0; i < 5; i++) recordFailure(key, t0);
  assert.equal(isLockedOut(key, t0), true);
  clearAttempts(key);
  assert.equal(isLockedOut(key, t0), false);
});
