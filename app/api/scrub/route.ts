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
import { isAuthed } from "@/app/actions";
import { scrubBatch } from "@/lib/scrub";

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    // AUTH GATE — scrubbing spends Tracerfy credits and mutates suppression flags.
    if (!(await isAuthed())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const traceQueueId = typeof body.traceQueueId === "number" ? body.traceQueueId : undefined;
    const phoneColumns: string[] | undefined = Array.isArray(body.phoneColumns)
      ? body.phoneColumns
      : undefined;

    const result = await scrubBatch({ limit, traceQueueId, phoneColumns });
    return NextResponse.json(result);
  } catch (err) {
    // Log detail server-side; return a generic label (avoid leaking Tracerfy/DB internals).
    console.error("[scrub] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "scrub_failed" }, { status: 502 });
  }
}
