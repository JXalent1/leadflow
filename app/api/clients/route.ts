// /api/clients — operator client onboarding + config edit. (2nd-client onboarding, 2026-06-27)
//
// AUTH: both verbs require an operator session (requireOperator) — these create/modify tenant
// records + their login users. A client user can never reach this route (403).
//
// POST  { name, ...config, loginEmail?, loginPassword? } → create a NEW client with sane defaults,
//       set its per-client config (number, copy, opt-out keyword/instruction, window, rate, target),
//       and — when loginEmail+loginPassword are given — create its client login user (role='client',
//       client_id=<new id>) so the client can sign in to their portal. Returns the new client + user.
// PATCH { clientId, ...config } → update an existing client's config (only provided fields). The
//       client is resolved THROUGH the session (resolveClientIdForUser) so the access gate holds.
//
// This does NOT touch suppression / eligibility / the inbound path — it only writes the client
// config row (+ optionally a users row on create). The configured opt-out keyword is honored by the
// inbound webhook (lib/inbound.ts) and the matching visible line is rendered by lib/sms.ts.

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId } from "@/lib/request-client";
import {
  createClient,
  updateClientConfig,
  type CreateClientInput,
  type UpdateClientConfig,
} from "@/lib/clients";
import { upsertUser } from "@/lib/users";
import { hashPassword } from "@/lib/auth";

/** Trim a string; return null for null/undefined/blank. Used to map empty form fields → NULL. */
function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** A finite number, or undefined if not provided / not a number (so it falls back to the default). */
function numOrUndef(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function period(v: unknown): "week" | "month" | undefined {
  return v === "week" || v === "month" ? v : undefined;
}

/** A boolean from a JSON bool or "true"/"false" string; undefined otherwise (field omitted). */
function boolOrUndef(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** Map the request body to the shared client-config shape (nullable text → null, numbers coerced). */
function configFromBody(body: Record<string, unknown>) {
  return {
    biz_name: strOrNull(body.biz_name),
    from_number: strOrNull(body.from_number),
    messaging_service_sid: strOrNull(body.messaging_service_sid),
    message_template: strOrNull(body.message_template),
    forward_phone: strOrNull(body.forward_phone),
    optout_keyword: strOrNull(body.optout_keyword),
    optout_instruction: strOrNull(body.optout_instruction),
    optout_confirmation: strOrNull(body.optout_confirmation),
    send_window_start_hour: numOrUndef(body.send_window_start_hour),
    send_window_end_hour: numOrUndef(body.send_window_end_hour),
    send_timezone: strOrNull(body.send_timezone) ?? undefined,
    send_rate_per_hour: numOrUndef(body.send_rate_per_hour),
    lead_guarantee: numOrUndef(body.lead_guarantee),
    lead_target: body.lead_target === null ? null : numOrUndef(body.lead_target),
    target_period: period(body.target_period),
    plan_amount_cents: numOrUndef(body.plan_amount_cents),
    billing_day: body.billing_day === null ? null : numOrUndef(body.billing_day),
    // Conversational-AI config (surfaced by components/client-ai-settings.tsx). These only write the
    // client config row — they never weaken the deterministic STOP/keyword/suppression gate.
    ai_enabled: boolOrUndef(body.ai_enabled),
    ai_services: strOrNull(body.ai_services),
    ai_offer: strOrNull(body.ai_offer),
    ai_persona: strOrNull(body.ai_persona),
    ai_location: strOrNull(body.ai_location),
  };
}

export async function POST(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strOrNull(body.name);
    if (!name) {
      return NextResponse.json({ error: "name_required" }, { status: 400 });
    }

    // A login is optional but recommended: if either field is present, BOTH must be (and the
    // password must be long enough), so we never half-create an unusable login.
    const loginEmail = strOrNull(body.loginEmail);
    const loginPassword = typeof body.loginPassword === "string" ? body.loginPassword : "";
    if ((loginEmail || loginPassword) && !(loginEmail && loginPassword)) {
      return NextResponse.json(
        { error: "login_incomplete", message: "Provide both a login email and password, or neither." },
        { status: 400 }
      );
    }
    if (loginPassword && loginPassword.length < 8) {
      return NextResponse.json(
        { error: "weak_password", message: "Login password must be at least 8 characters." },
        { status: 400 }
      );
    }

    const input: CreateClientInput = { name, ...configFromBody(body) };
    const client = await createClient(input);

    let loginUser: { id: number; email: string } | null = null;
    if (loginEmail && loginPassword) {
      const u = await upsertUser({
        email: loginEmail,
        passwordHash: hashPassword(loginPassword),
        role: "client",
        clientId: client.id,
      });
      loginUser = { id: u.id, email: u.email };
    }

    return NextResponse.json({ ok: true, client, loginUser });
  } catch (err) {
    console.error("[clients] create failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "client_create_failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    // The client may come from ?clientId= or the body; either way it resolves THROUGH the session.
    const requested = requestedClientId(req) ?? numOrUndef(body.clientId);
    const clientId = resolveClientIdForUser(g.user, requested ?? null);
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    // Build the partial update from ONLY the fields the body actually carries (so an omitted field
    // is never reset). `name`/`status` are editable on PATCH; the rest come from configFromBody.
    const cfg = configFromBody(body);
    const fields: UpdateClientConfig = {};
    const set = <K extends keyof UpdateClientConfig>(k: K, v: UpdateClientConfig[K]) => {
      fields[k] = v;
    };
    if ("name" in body) {
      const nm = strOrNull(body.name);
      if (!nm) return NextResponse.json({ error: "name_required" }, { status: 400 });
      set("name", nm);
    }
    if ("status" in body) set("status", body.status === "paused" ? "paused" : "active");
    // Only forward config keys the body actually included.
    for (const key of Object.keys(cfg) as (keyof typeof cfg)[]) {
      if (key in body) set(key as keyof UpdateClientConfig, cfg[key] as never);
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: "no_fields" }, { status: 400 });
    }

    const client = await updateClientConfig(clientId, fields);
    if (!client) return NextResponse.json({ error: "client_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, client });
  } catch (err) {
    console.error("[clients] update failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "client_update_failed" }, { status: 500 });
  }
}
