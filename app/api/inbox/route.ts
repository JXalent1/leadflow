// GET /api/inbox — READ-ONLY inbox data for client-side refresh. (Session 7, Module 7)
//
// AUTH: operator session (requireOperator) — 401/403 otherwise; never expose contact/message data
// to an unauthenticated request. This route only reads. The reply SEND and lead UPDATE go through
// the dedicated /api/reply and /api/leads endpoints.
//
//   GET /api/inbox                 → { threads }     (the conversation list)
//   GET /api/inbox?contactId=123   → { thread }      (full detail for one contact)

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId } from "@/lib/request-client";
import { getInboxThreads, getThread } from "@/lib/inbox-db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const { searchParams } = new URL(req.url);
    const contactIdRaw = searchParams.get("contactId");

    if (contactIdRaw !== null) {
      const contactId = Number(contactIdRaw);
      if (!Number.isInteger(contactId) || contactId <= 0) {
        return NextResponse.json({ error: "invalid_contact_id" }, { status: 400 });
      }
      const thread = await getThread(clientId, contactId);
      if (!thread) {
        return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
      }
      return NextResponse.json({ thread });
    }

    const threads = await getInboxThreads(clientId);
    return NextResponse.json({ threads });
  } catch (err) {
    console.error("[inbox] read failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "inbox_read_failed" }, { status: 500 });
  }
}
