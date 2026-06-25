/**
 * lib/guard.ts — route guards (server-only). (v2 Module V5)
 *
 * The two checks every API route uses, centralized so there is ONE implementation of "is this an
 * operator?" / "is this a logged-in user?" — a route can't accidentally diverge. A guard returns
 * either the loaded user or a ready-to-return NextResponse (401/403), so a route reads:
 *
 *   const g = await requireOperator();
 *   if (!g.ok) return g.response;
 *   // ... g.user is an operator
 *
 * Client resolution (which client a request may act on) is the SEPARATE pure chokepoint
 * resolveClientIdForUser in lib/access.ts — that's what closes the V1 ?clientId= gate.
 */

import "server-only";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";
import type { User } from "@/lib/users";

export type GuardResult = { ok: true; user: User } | { ok: false; response: NextResponse };

function unauthorized(): GuardResult {
  return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
}
function forbidden(): GuardResult {
  return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
}

/** Require any logged-in user (operator OR client). 401 if not authenticated. */
export async function requireUser(): Promise<GuardResult> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  return { ok: true, user };
}

/** Require an OPERATOR. 401 if not logged in, 403 if logged in but not an operator. */
export async function requireOperator(): Promise<GuardResult> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  if (!isOperator(user)) return forbidden();
  return { ok: true, user };
}
