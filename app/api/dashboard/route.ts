// GET /api/dashboard — READ-ONLY snapshot for the dashboard's client-side polling.
//
// AUTH: operator session (requireOperator) — 401 if not logged in, 403 if a client user; never
// expose contact data to an unauthenticated request. This route only reads (getDashboardData); it adds NO
// write/mutation logic. The dashboard's action buttons call the existing
// /api/{skiptrace,scrub,campaign} endpoints for anything that changes state.

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId, campaignIdFromRequest } from "@/lib/request-client";
import { getClientById } from "@/lib/clients";
import { resolveCampaignForClient } from "@/lib/campaigns";
import { getDashboardData } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const client = await getClientById(clientId);
    if (!client) {
      return NextResponse.json({ error: "client_not_found" }, { status: 404 });
    }
    const campaign = await resolveCampaignForClient(client.id, campaignIdFromRequest(req));
    if (!campaign) {
      return NextResponse.json({ error: "no_campaign" }, { status: 404 });
    }
    const data = await getDashboardData(client, campaign);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[dashboard] read failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "dashboard_read_failed" }, { status: 500 });
  }
}
