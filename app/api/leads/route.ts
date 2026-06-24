// /api/leads — update a lead's status / notes. (Session 7, Module 7)
//
// AUTH: requires the admin cookie (isAuthed) — 401 if not. Pure DB write to the leads
// table (no SMS, no contact mutation). Status is validated against the allowed funnel set.

import { NextResponse } from "next/server";
import { isAuthed } from "@/app/actions";
import { clientIdFromRequest } from "@/lib/request-client";
import { setLeadStatus } from "@/lib/inbox-db";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/lead-status";

function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

export async function POST(req: Request) {
  try {
    if (!(await isAuthed())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const leadId = Number(body?.leadId);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return NextResponse.json({ error: "invalid_lead_id" }, { status: 400 });
    }

    const hasStatus = body?.status !== undefined;
    const hasNotes = body?.notes !== undefined;
    if (!hasStatus && !hasNotes) {
      return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
    }
    if (hasStatus && !isLeadStatus(body.status)) {
      return NextResponse.json(
        { error: "invalid_status", allowed: LEAD_STATUSES },
        { status: 400 }
      );
    }
    // notes may be any string (including ""), or null to clear. Reject other types.
    if (hasNotes && body.notes !== null && typeof body.notes !== "string") {
      return NextResponse.json({ error: "invalid_notes" }, { status: 400 });
    }

    const lead = await setLeadStatus(clientIdFromRequest(req), leadId, {
      status: hasStatus ? (body.status as string) : undefined,
      notes: hasNotes ? (body.notes as string | null) : undefined,
    });
    if (!lead) {
      return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, lead });
  } catch (err) {
    console.error("[leads] update failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "lead_update_failed" }, { status: 500 });
  }
}
