/**
 * lib/session.ts — the session cookie (server-only). (v2 Module V5)
 *
 * Reads/writes the `lf_session` cookie via next/headers, so it is usable only in a request scope
 * (route handlers, server components, server actions) — never in a client component. The cookie is
 * an HMAC-signed token (lib/auth.ts); on every read we VERIFY the signature + expiry and then
 * RE-LOAD the user from the DB by id, so authorization always reflects the current DB row (role /
 * client_id) — the cookie is a bearer of identity, the DB is the source of truth. A deleted or
 * altered user immediately loses/changes access.
 *
 * Cookie flags: httpOnly (no JS access), secure in production (HTTPS-only), sameSite=lax (CSRF
 * mitigation for top-level navigation), path=/, expiry = SESSION_MAX_AGE_SECONDS.
 */

import "server-only";
import { cookies } from "next/headers";
import { signSession, verifySession, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";
import { getUserById, type User } from "@/lib/users";

const COOKIE_NAME = "lf_session";

/** Mint a fresh signed session cookie for a just-authenticated user. (Login mints a new token → no fixation.) */
export function createSession(user: { id: number; role: string; client_id: number | null }): void {
  const token = signSession({ uid: user.id, role: user.role, cid: user.client_id });
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Clear the session cookie (logout). */
export function destroySession(): void {
  cookies().delete(COOKIE_NAME);
}

/**
 * The logged-in user for this request, or null. Verifies the signed cookie, then re-loads the user
 * from the DB (authoritative) — so role/client_id can never be forged via the cookie.
 */
export async function getSessionUser(): Promise<User | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  const payload = verifySession(token);
  if (!payload) return null;
  return getUserById(payload.uid);
}
