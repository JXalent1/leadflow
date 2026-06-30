// /api/followups — create a FOLLOW-UP / re-engagement send to a prior campaign's non-responders.
// (Build: followup-campaigns)
//
// AUTH: both verbs require an operator session (requireOperator) — this seeds a send list.
//
// GET  ?clientId=&sourceCampaignId=  → the follow-up audience COUNT for that source campaign + the
//      preview metadata the UI needs (default template, the client's opt-out line + biz name so the
//      live segment preview matches what will actually send, the source campaign name, the cap).
//      Reads only — spends NOTHING.
// POST { sourceCampaignId, name?, messageTemplate?, maxFollowups? }
//      → create the follow-up campaign + seed it from the audience, REUSING the existing phones with
//      NO re-trace / NO re-scrub (zero vendor credits). Returns { campaignId, seeded }. The operator
//      then opens that campaign and runs the EXISTING send pipeline (suppression/claim/window/segment
//      cap all unchanged).
//
// Scoping: the resolved client comes from the session (resolveClientIdForUser), and the source
// campaign MUST belong to that client (getCampaignForClient) — an operator can't follow up another
// tenant's campaign.

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId } from "@/lib/request-client";
import { getClientById, clientBizName, clientOptOutInstruction } from "@/lib/clients";
import { getCampaignForClient } from "@/lib/campaigns";
import {
  getFollowupAudienceCount,
  createFollowupCampaign,
  DEFAULT_FOLLOWUP_TEMPLATE,
} from "@/lib/followups";
import { clampMaxFollowups, DEFAULT_MAX_FOLLOWUPS } from "@/lib/followup-audience";

// Seeding a large audience runs one INSERT … SELECT; allow the platform max to be safe.
export const maxDuration = 300;

function parseSourceCampaignId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const sourceCampaignId = parseSourceCampaignId(
      new URL(req.url).searchParams.get("sourceCampaignId")
    );
    if (sourceCampaignId === null) {
      return NextResponse.json({ error: "source_campaign_id_required" }, { status: 400 });
    }

    const client = await getClientById(clientId);
    if (!client) return NextResponse.json({ error: "client_not_found" }, { status: 404 });
    // Ownership: the source campaign must belong to this client.
    const source = await getCampaignForClient(clientId, sourceCampaignId);
    if (!source) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });

    const count = await getFollowupAudienceCount(clientId, sourceCampaignId);
    return NextResponse.json({
      clientId,
      sourceCampaignId,
      sourceName: source.name,
      count,
      maxFollowups: DEFAULT_MAX_FOLLOWUPS,
      defaultTemplate: DEFAULT_FOLLOWUP_TEMPLATE,
      // So the UI's live preview renders the exact opt-out line + brand the send will use.
      bizName: clientBizName(client),
      optOutInstruction: clientOptOutInstruction(client),
    });
  } catch (err) {
    console.error("[followups] count failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "followups_count_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const sourceCampaignId = parseSourceCampaignId(body.sourceCampaignId);
    if (sourceCampaignId === null) {
      return NextResponse.json({ error: "source_campaign_id_required" }, { status: 400 });
    }

    const client = await getClientById(clientId);
    if (!client) return NextResponse.json({ error: "client_not_found" }, { status: 404 });
    // Ownership before any write: an operator can't follow up another client's campaign.
    const source = await getCampaignForClient(clientId, sourceCampaignId);
    if (!source) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });

    const name = typeof body.name === "string" ? body.name : undefined;
    const messageTemplate =
      typeof body.messageTemplate === "string" ? body.messageTemplate : undefined;
    const maxFollowups =
      body.maxFollowups == null ? undefined : clampMaxFollowups(Number(body.maxFollowups));

    const result = await createFollowupCampaign(clientId, sourceCampaignId, {
      name,
      messageTemplate,
      maxFollowups,
    });

    return NextResponse.json({
      ok: true,
      clientId,
      sourceCampaignId,
      campaignId: result.campaignId,
      seeded: result.seeded,
    });
  } catch (err) {
    console.error("[followups] create failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "followups_create_failed" }, { status: 500 });
  }
}
