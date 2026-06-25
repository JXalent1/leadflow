// GET /api/portal — the CLIENT dashboard's read-only data, for client-side polling. (v2 Module V5)
//
// AUTH: any logged-in user (requireUser). The client is resolved through the SESSION via
// resolveClientIdForUser — a CLIENT user is hard-locked to their own client_id (a ?clientId= for
// anyone else → 403). This is the only API a client role can successfully call; every operator
// endpoint requires the operator role. Returns ONLY client-safe data (their leads + cycle progress).

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId } from "@/lib/request-client";
import { getClientById } from "@/lib/clients";
import { getPortalData } from "@/lib/portal";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const g = await requireUser();
    if (!g.ok) return g.response;

    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const client = await getClientById(clientId);
    if (!client) return NextResponse.json({ error: "client_not_found" }, { status: 404 });

    const data = await getPortalData(client);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[portal] read failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "portal_read_failed" }, { status: 500 });
  }
}
