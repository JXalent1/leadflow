// /api/reply — the manual 1:1 reply send path. (Session 7, Module 7)
//
// AUTH: requires the admin cookie (isAuthed) — this endpoint sends real SMS and spends
// money, so it must never be world-callable. 401 if unauthenticated.
//
// COMPLIANCE (load-bearing): this is a NEW outbound-send path, so the same "never text a
// suppressed/opted-out number" guarantee that governs the campaign blast applies here.
//   - The destination is NEVER taken from the request body. We load the contact by id and
//     send ONLY to contact.phone — so the tool can't be used to text an arbitrary number.
//   - If the contact is missing, has no phone, is suppressed, or has an opt_outs row, we
//     REFUSE with a 4xx (recipient_suppressed). Fail closed.
//   - Every outbound reply (success OR failure) is logged to messages via recordMessage.
//
// Unlike the campaign blast, a 1:1 reply is NOT blocked by the send window (it's a
// conversational, time-sensitive response to someone who just messaged us) and may exceed
// one segment (a human is typing). Suppression is the only hard gate.

import { NextResponse } from "next/server";
import { isAuthed } from "@/app/actions";
import { recordMessage } from "@/lib/db";
import { getContactById, isPhoneOptedOut } from "@/lib/inbox-db";
import { sendOne } from "@/lib/twilio";
import { replyRefusalReason } from "@/lib/reply";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    // AUTH GATE — never allow an unauthenticated send.
    if (!(await isAuthed())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const contactId = Number(body?.contactId);
    const text = typeof body?.body === "string" ? body.body : "";

    if (!Number.isInteger(contactId) || contactId <= 0) {
      return NextResponse.json({ error: "invalid_contact_id" }, { status: 400 });
    }
    if (!text.trim()) {
      return NextResponse.json({ error: "empty_body" }, { status: 400 });
    }

    // Load the contact — the ONLY source of the destination number. We never honor a
    // phone supplied in the request.
    const contact = await getContactById(contactId);

    // Suppression gate (fail closed): refuse if not found, no phone, suppressed flag set,
    // or a permanent opt-out record exists. Decision lives in the pure replyRefusalReason.
    const optedOut = contact?.phone ? await isPhoneOptedOut(contact.phone) : true;
    const refusal = replyRefusalReason(contact, optedOut);
    if (refusal) {
      return NextResponse.json({ error: refusal }, { status: 422 });
    }
    // After the gate, contact + contact.phone are guaranteed present.
    const phone = contact!.phone as string;

    // Passed the gate — send only to the stored phone (never a request-supplied number).
    const res = await sendOne(phone, text);

    if (!res.ok) {
      // Log the failed attempt (null sid, status 'failed') so it still appears in the thread.
      await recordMessage({
        contactId,
        direction: "outbound",
        body: text,
        twilioSid: null,
        status: "failed",
      });
      console.error(`[reply] send failed contact=${contactId} code=${res.code ?? "?"}`);
      return NextResponse.json({ ok: false, error: "send_failed", code: res.code }, { status: 502 });
    }

    const messageId = await recordMessage({
      contactId,
      direction: "outbound",
      body: text,
      twilioSid: res.sid,
      status: res.status,
    });

    return NextResponse.json({ ok: true, messageId, sid: res.sid, status: res.status });
  } catch (err) {
    // Log server-side only; never echo raw errors (they can carry account ids / tokens).
    console.error("[reply] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "reply_failed" }, { status: 500 });
  }
}
