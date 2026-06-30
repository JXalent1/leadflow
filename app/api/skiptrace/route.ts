// POST /api/skiptrace — append phones to pending contacts via Tracerfy.
//
// Idempotent: only contacts with skiptrace_status='pending' are traced, so a
// re-run never re-traces matched/no_match rows. Fail closed: a no-match is
// suppressed (suppress_reason='no_match') so an unverified number can't be texted.
//
// Body (optional): { limit?: number, traceType?: 'normal' | 'advanced' }
// Returns: { traced, matched, noMatch }

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId, campaignIdFromRequest } from "@/lib/request-client";
import { resolveCampaignForClient } from "@/lib/campaigns";
import { traceBatch, InsufficientCreditsError } from "@/lib/skiptrace";
import { isTransientError } from "@/lib/retry";
import type { TraceType } from "@/lib/tracerfy";

// A 500-record trace can exceed the default function window; allow the max.
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    // AUTH GATE — operator only; skip-tracing spends Tracerfy credits.
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const traceType: TraceType = body.traceType === "advanced" ? "advanced" : "normal";

    // Scope the trace to the selected campaign (default = the client's pilot campaign).
    const campaign = await resolveCampaignForClient(clientId, campaignIdFromRequest(req));
    if (!campaign) {
      return NextResponse.json({ error: "no_campaign" }, { status: 404 });
    }
    const result = await traceBatch(clientId, { campaignId: campaign.id, limit, traceType });
    return NextResponse.json({ ...result, campaignId: campaign.id });
  } catch (err) {
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
    // Transient upstream failures survived the in-batch retries (e.g. a sustained rate-limit).
    // Flag them so the client driver can wait + auto-resume instead of dead-ending the pipeline;
    // the run is fully resumable (trace_jobs persisted, re-ingest is free, no double-charge).
    const retryable = isTransientError(err);
    console.error(
      `[skiptrace] failed${retryable ? " (transient, resumable)" : ""}:`,
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json({ error: "skiptrace_failed", retryable }, { status: 502 });
  }
}
