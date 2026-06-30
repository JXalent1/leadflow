// /api/webhook/twilio — inbound SMS: STOP + interest triage + lead forward. (Session 4, Module 4)
//
// AUTH: this endpoint is PUBLIC (Twilio calls it) so it has no admin cookie. Its only auth is the
// X-Twilio-Signature header, validated with twilio.validateRequest against the exact public URL and
// the posted params. An invalid/missing signature is rejected with 403 BEFORE any DB write or
// forward — without this, anyone could forge an "interested" reply (spamming Talan) or a fake STOP.
//
// Decision logic (STOP precedence, idempotency, classification routing) lives in lib/inbound.ts and
// is unit-tested with fakes. This file owns transport only: signature validation, body parsing, and
// TwiML. STOP confirmation is sent via TwiML <Message> (exactly once), not a second API call.

import { NextResponse } from "next/server";
import twilio from "twilio";
import { normalizePhone } from "@/lib/tracerfy";
import {
  processInbound,
  type InboundDeps,
  type InboundContactLite,
} from "@/lib/inbound";
import {
  findContactByPhone,
  logInboundOnce,
  recordOptOut,
  markSuppressed,
  recordMessage,
  createLead,
} from "@/lib/db";
import { getClientByInboundNumber, clientSender, clientBizName, type Client } from "@/lib/clients";
import { forwardLead } from "@/lib/forward";
import { aiResponderGloballyEnabled, buildRunAiResponder } from "@/lib/ai-responder-wire";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// TwiML helpers
// ---------------------------------------------------------------------------

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);
}

/** Empty <Response/>, or a single <Message> (used only for the STOP confirmation). */
function twiml(message?: string): NextResponse {
  const inner = message ? `<Message>${escapeXml(message)}</Message>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
  return new NextResponse(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Whether to emit our own opt-out confirmation. If a Twilio Messaging Service with
 * Advanced Opt-Out is enabled, Twilio confirms STOP itself — set TWILIO_ADVANCED_OPT_OUT=true
 * so we don't double-confirm. Default: we own STOP (plain from-number).
 */
function emitConfirmation(): boolean {
  return process.env.TWILIO_ADVANCED_OPT_OUT?.trim().toLowerCase() !== "true";
}

/**
 * The exact public URL Twilio signed. Twilio computes the signature over the URL it
 * POSTed to; behind Vercel's proxy req.url is the internal URL, so prefer an explicit
 * TWILIO_WEBHOOK_URL, else reconstruct from x-forwarded-* headers.
 */
function publicUrl(req: Request): string {
  const configured = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (configured) return configured;
  // Reconstruction is fine on Vercel (the platform sets x-forwarded-* to the real host, and a
  // forger still can't compute the HMAC without the auth token). But behind a different proxy a
  // host/proto mismatch would make validateRequest REJECT legit Twilio requests — so prefer the
  // explicit env in production. Warn once per cold start.
  console.warn("[webhook] TWILIO_WEBHOOK_URL not set — reconstructing the URL from x-forwarded-* headers; set it explicitly for production.");
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

/**
 * Wire the real lib/db + lib/forward implementations into the inbound core, ALL scoped to the
 * client that owns the inbound number. Every read/write is bound to `client.id` so an inbound to
 * client A's number can never touch client B's contacts, suppression, opt-outs, leads, or forward.
 */
function buildDeps(client: Client): InboundDeps {
  const clientId = client.id;
  const forwardCfg = {
    clientId,
    forwardPhone: client.forward_phone,
    sender: clientSender(client),
  };
  return {
    findContactByPhone: (phone) =>
      findContactByPhone(clientId, phone) as Promise<InboundContactLite | null>,
    logInboundOnce: (args) => logInboundOnce({ clientId, ...args }),
    recordOptOut: (contactId, phone) => recordOptOut(clientId, contactId, phone),
    markSuppressed: (contactId, reason) => markSuppressed(clientId, contactId, reason),
    recordOutbound: async (args) => {
      await recordMessage({
        clientId,
        contactId: args.contactId,
        direction: "outbound",
        body: args.body,
        status: args.status,
      });
    },
    createLead: (args) => createLead({ clientId, ...args }),
    forwardLead: (args) => forwardLead(args, forwardCfg),
    // Conversational AI responder — wired ONLY when the global kill switch (AI_RESPONDER_ENABLED)
    // AND this client's ai_enabled are both on. processInbound runs it AFTER the opt-out/suppression
    // gate and only on the first delivery, and falls back to the keyword path on any error. When
    // either switch is off, runAiResponder stays undefined and the keyword path is used unchanged.
    runAiResponder:
      aiResponderGloballyEnabled() && client.ai_enabled
        ? buildRunAiResponder(client)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  try {
    // --- AUTH: signature validation gates EVERYTHING. -----------------------
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      // Can't validate without the token — fail closed. Distinct from a forged request:
      // this is our misconfiguration, so 500 (and never process).
      console.error("[webhook] TWILIO_AUTH_TOKEN not set — cannot validate inbound; rejecting.");
      return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
    }

    // Read the body once; Twilio signs over the URL + the posted form params.
    const rawBody = await req.text();
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;

    const signature = req.headers.get("x-twilio-signature");
    const valid =
      !!signature && twilio.validateRequest(authToken, signature, publicUrl(req), params);
    if (!valid) {
      console.warn("[webhook] rejected: invalid or missing X-Twilio-Signature");
      return new NextResponse("Forbidden", { status: 403 });
    }

    // --- Parse the inbound message. -----------------------------------------
    const from = params.From ?? "";
    const to = params.To ?? "";
    const body = params.Body ?? "";
    const messageSid = params.MessageSid || params.SmsSid || "";
    if (!from || !messageSid) {
      // Signed but not a recognizable inbound SMS (e.g. a status callback). Ack, do nothing.
      console.warn("[webhook] valid signature but missing From/MessageSid; acking without processing.");
      return twiml();
    }

    // --- Resolve the OWNING client by the To number (the client's campaign number). ----------
    // Multi-tenant: the message belongs to whichever client owns the number it came in on. All
    // downstream effects are scoped to that client. If no client owns the number, we ack and do
    // NOTHING — a message to an unknown number never reads or writes anyone's data.
    const client = await getClientByInboundNumber(to);
    if (!client) {
      console.warn(`[webhook] valid signature but no client owns To=${to}; acking without processing.`);
      return twiml();
    }

    // --- Decide + execute (STOP precedence / idempotency / triage), scoped to the client. ----
    const outcome = await processInbound(
      { fromPhone: normalizePhone(from), body, messageSid },
      buildDeps(client),
      {
        bizName: clientBizName(client),
        emitConfirmation: emitConfirmation(),
        optOutConfirmation: client.optout_confirmation ?? undefined,
        optOutKeyword: client.optout_keyword,
      },
    );

    // Only the STOP confirmation goes back as a TwiML <Message> (sent exactly once).
    if (outcome.kind === "opt_out" && outcome.confirmation) {
      return twiml(outcome.confirmation);
    }
    return twiml();
  } catch (err) {
    // Log server-side; return 5xx so Twilio retries (idempotency makes a retry safe).
    // Never echo raw errors — they can carry account IDs / connection fragments.
    console.error("[webhook] failed:", err instanceof Error ? err.message : String(err));
    return new NextResponse("Error", { status: 500 });
  }
}
