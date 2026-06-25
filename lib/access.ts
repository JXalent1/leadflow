/**
 * lib/access.ts — the access-control decision, pure + centralized. (v2 Module V5)
 *
 * THIS IS THE CHOKEPOINT that closes the V1 `?clientId=` gate. Every request that acts on a
 * client resolves the client id THROUGH HERE, from the logged-in user — never directly from a
 * request param. The rule:
 *
 *   - OPERATOR: may act on any client. Uses the requested client id if given, else the default
 *     (client 1). The cockpit click-through is how an operator selects a client.
 *   - CLIENT user: HARD-LOCKED to their own client_id. A requested id that isn't theirs is
 *     REJECTED (returns null → the route 403s). With no requested id they get their own. They can
 *     never reach another client's data by any param/route/API.
 *
 * Keeping this pure (no DB, no cookies) lets the security fixture exhaustively prove the lock.
 */

import { DEFAULT_CLIENT_ID } from "@/lib/constants";

export interface SessionUserLike {
  id: number;
  role: string; // 'operator' | 'client'
  client_id: number | null;
}

/** True iff the user is an operator (the only role allowed on operator surfaces). */
export function isOperator(user: SessionUserLike | null | undefined): boolean {
  return !!user && user.role === "operator";
}

/**
 * Resolve which client id a request may act on, given the logged-in user and the (optional)
 * requested client id parsed from the request. Returns the allowed client id, or null if the
 * request is not permitted (caller returns 403).
 *
 * - operator → requested (if a positive int) else DEFAULT_CLIENT_ID.
 * - client   → their own client_id; null if they requested a DIFFERENT client, or if the client
 *              user is misconfigured (no client_id).
 */
export function resolveClientIdForUser(
  user: SessionUserLike | null | undefined,
  requested?: number | null
): number | null {
  if (!user) return null;
  const req =
    typeof requested === "number" && Number.isInteger(requested) && requested > 0
      ? requested
      : undefined;

  if (user.role === "operator") {
    return req ?? DEFAULT_CLIENT_ID;
  }

  // Client user: locked to their own client_id.
  if (user.role !== "client" || user.client_id == null) return null;
  if (req !== undefined && req !== user.client_id) return null; // foreign client requested → deny
  return user.client_id;
}
