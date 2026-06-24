// POST /api/skiptrace — append phones to pending contacts via Tracerfy.
//
// Idempotent: only contacts with skiptrace_status='pending' are traced, so a
// re-run never re-traces matched/no_match rows. Fail closed: a no-match is
// suppressed (suppress_reason='no_match') so an unverified number can't be texted.
//
// Body (optional): { limit?: number, traceType?: 'normal' | 'advanced' }
// Returns: { traced, matched, noMatch }

import { NextResponse } from "next/server";
import { isAuthed } from "@/app/actions";
import { clientIdFromRequest } from "@/lib/request-client";
import { traceBatch, InsufficientCreditsError } from "@/lib/skiptrace";
import type { TraceType } from "@/lib/tracerfy";

// A 500-record trace can exceed the default function window; allow the max.
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    // AUTH GATE — skip-tracing spends Tracerfy credits; never allow it unauthenticated.
    if (!(await isAuthed())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const traceType: TraceType = body.traceType === "advanced" ? "advanced" : "normal";

    const result = await traceBatch(clientIdFromRequest(req), { limit, traceType });
    return NextResponse.json(result);
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
    console.error("[skiptrace] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "skiptrace_failed" }, { status: 502 });
  }
}
