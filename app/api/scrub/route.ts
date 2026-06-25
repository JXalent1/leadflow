// POST /api/scrub — DNC + litigator scrub of traced numbers; hard-suppress flags.
//
// Runs on contacts that are matched, have a phone, and are not yet suppressed.
// Prefers scrub-from-queue when the caller passes the trace queue id (cheaper,
// no phone re-upload); otherwise scrubs the explicit phone list.
//
// Fail closed (load-bearing for compliance): a phone is left eligible ONLY if the
// scrub result explicitly marks it clean. Missing, ambiguous, or any-flag => suppress.
//
// Body (optional): { limit?, traceQueueId?, phoneColumns? }
// Returns: { scrubbed, suppressed, byReason }

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId, campaignIdFromRequest } from "@/lib/request-client";
import { resolveCampaignForClient } from "@/lib/campaigns";
import { scrubBatch, InsufficientCreditsError } from "@/lib/scrub";
import { passthroughScrubBatch } from "@/lib/scrub-passthrough";

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    // AUTH GATE — operator only; scrubbing spends Tracerfy credits and mutates suppression flags.
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const traceQueueId = typeof body.traceQueueId === "number" ? body.traceQueueId : undefined;
    const phoneColumns: string[] | undefined = Array.isArray(body.phoneColumns)
      ? body.phoneColumns
      : undefined;

    // Scope the scrub to the selected campaign (default = the client's pilot campaign).
    const campaign = await resolveCampaignForClient(clientId, campaignIdFromRequest(req));
    if (!campaign) {
      return NextResponse.json({ error: "no_campaign" }, { status: 404 });
    }

    // Module N: a 'none' campaign skips the vendor scrub entirely — passthrough-mark the campaign's
    // traced contacts clean with NO Tracerfy call/credit spend. Same response shape the pipeline
    // driver already loops on (scrubbed/clean/suppressed), so components/pipeline-runner.tsx is
    // unchanged. 'vendor' (the default) runs the existing Tracerfy scrubBatch byte-for-byte.
    if (campaign.scrub_mode === "none") {
      const result = await passthroughScrubBatch(clientId, { campaignId: campaign.id, limit });
      return NextResponse.json({ ...result, scrubMode: "none", campaignId: campaign.id });
    }

    const result = await scrubBatch(clientId, {
      campaignId: campaign.id,
      limit,
      traceQueueId,
      phoneColumns,
    });
    return NextResponse.json({ ...result, campaignId: campaign.id });
  } catch (err) {
    // Credit pre-flight refusal — nothing was submitted/spent. 402 so the caller can top up.
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json(
        {
          error: "insufficient_credits",
          credits: err.credits,
          needed: err.needed,
          pending: err.pending,
        },
        { status: 402 }
      );
    }
    // Log detail server-side; return a generic label (avoid leaking Tracerfy/DB internals).
    console.error("[scrub] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "scrub_failed" }, { status: 502 });
  }
}
