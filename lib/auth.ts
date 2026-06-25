/**
 * lib/auth.ts — password hashing + signed session tokens. (v2 Module V5)
 *
 * Pure crypto over node:crypto — no DB, no next/headers — so it unit-tests in isolation. Two jobs:
 *
 *  1. Passwords: scrypt (a vetted, memory-hard KDF in the Node core) with a per-password random
 *     salt; verification is constant-time. Stored as `scrypt$N$r$p$saltB64$hashB64` so the cost
 *     params travel with the hash. We NEVER store or log a plaintext password.
 *
 *  2. Sessions: a stateless, HMAC-SHA256-signed token `b64(payload).b64(sig)`. The signature is
 *     over the encoded payload with SESSION_SECRET, so the cookie CANNOT be forged or tampered
 *     (a client can't flip their role to operator or point at another client_id). The payload
 *     carries the user id + role + client_id + expiry, but authorization always re-loads the user
 *     from the DB (see lib/session.ts) so the DB row — not the cookie — is the source of truth.
 *
 * SESSION_SECRET is REQUIRED (fail-closed): signing/verifying throws if it is unset, so a
 * misconfigured deploy can't silently fall back to a guessable key.
 */

import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";

// ---- Passwords (scrypt) ----------------------------------------------------

const SCRYPT_N = 16384; // CPU/memory cost (2^14)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

/** Hash a plaintext password. Returns `scrypt$N$r$p$saltB64$hashB64` (salt is random per call). */
export function hashPassword(plain: string): string {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("hashPassword: password must be a non-empty string");
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time verify of a plaintext against a stored `scrypt$...` hash. False on any malformed input. */
export function verifyPassword(plain: string, stored: string): boolean {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Bounds-check the cost params read from the stored hash. A DB-write compromise must not be able
  // to downgrade the KDF (tiny N) or DoS login (huge N/r/p). Range covers our own hashes with room
  // to raise cost later; anything outside it is rejected as malformed.
  if (N < 16384 || N > 1048576) return false; // 2^14 .. 2^20
  if (r < 8 || r > 32) return false;
  if (p < 1 || p > 4) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- Session tokens (HMAC-signed) ------------------------------------------

/** 8 hours — short enough to limit a stolen cookie, long enough to not nag the operator. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export interface SessionPayload {
  /** user id */
  uid: number;
  /** 'operator' | 'client' */
  role: string;
  /** client_id (null for operator) — convenience only; DB is authoritative for authz */
  cid: number | null;
  /** unix-seconds expiry */
  exp: number;
}

function getSecret(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET is not set (need ≥32 chars). Set it in .env.local / Vercel env before login works."
    );
  }
  return Buffer.from(secret, "utf8");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(encodedPayload: string): Buffer {
  return createHmac("sha256", getSecret()).update(encodedPayload).digest();
}

/**
 * Sign a session payload into `b64(payload).b64(sig)`. `nowSeconds` is injectable for tests; the
 * caller supplies uid/role/cid and we stamp the expiry SESSION_MAX_AGE_SECONDS out.
 */
export function signSession(
  data: { uid: number; role: string; cid: number | null },
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const payload: SessionPayload = {
    uid: data.uid,
    role: data.role,
    cid: data.cid,
    exp: nowSeconds + SESSION_MAX_AGE_SECONDS,
  };
  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(hmac(encoded));
  return `${encoded}.${sig}`;
}

/**
 * Verify a token's signature + expiry and return its payload, or null if anything is off
 * (bad shape, bad signature, expired). Signature check is constant-time. `nowSeconds` is
 * injectable for tests.
 */
export function verifySession(
  token: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SessionPayload | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = b64url(hmac(encoded));
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    const json = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.uid !== "number" ||
    typeof payload.role !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp <= nowSeconds) return null;
  return payload;
}
