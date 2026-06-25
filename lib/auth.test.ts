import { test } from "node:test";
import assert from "node:assert/strict";

// SESSION_SECRET must be set before importing/using the token helpers (fail-closed).
process.env.SESSION_SECRET = "test-session-secret-at-least-16-chars";

import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  SESSION_MAX_AGE_SECONDS,
} from "./auth";

// ---- Passwords -------------------------------------------------------------

test("hashPassword → verifyPassword round-trips for the right password", () => {
  const h = hashPassword("correct horse battery staple");
  assert.ok(h.startsWith("scrypt$"));
  assert.equal(verifyPassword("correct horse battery staple", h), true);
});

test("verifyPassword rejects the wrong password", () => {
  const h = hashPassword("s3cret");
  assert.equal(verifyPassword("s3cre7", h), false);
  assert.equal(verifyPassword("", h), false);
});

test("the same password hashes differently each time (random salt)", () => {
  assert.notEqual(hashPassword("samePass1"), hashPassword("samePass1"));
});

test("verifyPassword returns false on a malformed stored hash (never throws)", () => {
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", "scrypt$bad"), false);
  assert.equal(verifyPassword("x", ""), false);
});

// ---- Session tokens --------------------------------------------------------

test("signSession → verifySession round-trips and carries the payload", () => {
  const now = 1_000_000;
  const t = signSession({ uid: 7, role: "operator", cid: null }, now);
  const p = verifySession(t, now + 10);
  assert.ok(p);
  assert.equal(p!.uid, 7);
  assert.equal(p!.role, "operator");
  assert.equal(p!.cid, null);
  assert.equal(p!.exp, now + SESSION_MAX_AGE_SECONDS);
});

test("verifySession rejects a tampered payload (forged role/client)", () => {
  const now = 1_000_000;
  const t = signSession({ uid: 9, role: "client", cid: 2 }, now);
  // Forge: swap the payload for one claiming operator, keep the old signature.
  const forgedPayload = Buffer.from(JSON.stringify({ uid: 9, role: "operator", cid: null, exp: now + 999 }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const forged = `${forgedPayload}.${t.split(".")[1]}`;
  assert.equal(verifySession(forged, now), null);
});

test("verifySession rejects an expired token", () => {
  const now = 1_000_000;
  const t = signSession({ uid: 1, role: "client", cid: 1 }, now);
  assert.equal(verifySession(t, now + SESSION_MAX_AGE_SECONDS + 1), null);
});

test("verifySession rejects garbage / empty tokens", () => {
  assert.equal(verifySession(undefined), null);
  assert.equal(verifySession(""), null);
  assert.equal(verifySession("nodot"), null);
  assert.equal(verifySession("a.b.c"), null);
});

test("a token signed under a different secret does not verify", () => {
  const now = 1_000_000;
  const t = signSession({ uid: 1, role: "operator", cid: null }, now);
  const orig = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "a-completely-different-secret-value";
  const p = verifySession(t, now + 1);
  process.env.SESSION_SECRET = orig;
  assert.equal(p, null);
});
