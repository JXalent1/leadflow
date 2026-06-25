// PATCH /api/client — update live per-client send settings. (v2 Module V3; V6 adds the lead target.)
//
// AUTH: operator session (requireOperator) — 401/403 otherwise. Scoped to the operator's selected
// client (?clientId=, default 1) resolved through the session. Fields (all optional, applied if
// present): sendRatePerHour (sends/hour), and the V6 deliver-then-stop target — leadTarget (int, or
// null to fall back to the lead guarantee) + targetPeriod ('week'|'month'). Persisting makes the
// change take effect on the NEXT send batch with no redeploy, because the send route reads the
// client record fresh on every batch (rate AND the auto-pause target).
//
// Body: { sendRatePerHour?, leadTarget?, targetPeriod? }   Returns the resulting values.

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId } from "@/lib/request-client";
import { getClientById, setClientSendRate, setClientLeadTarget } from "@/lib/clients";

export async function PATCH(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const client = await getClientById(clientId);
    if (!client) {
      return NextResponse.json({ error: "client_not_found" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const result: Record<string, unknown> = {};

    // Send rate (optional). When present it must be a number >= 1.
    if (body.sendRatePerHour !== undefined) {
      const rate = body.sendRatePerHour;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 1) {
        return NextResponse.json(
          { error: "invalid_rate", message: "sendRatePerHour must be a number >= 1." },
          { status: 400 }
        );
      }
      result.sendRatePerHour = await setClientSendRate(client.id, rate);
    }

    // V6 deliver-then-stop target (optional). leadTarget: a non-negative int, or null to fall back
    // to the lead guarantee. targetPeriod: 'week' | 'month' (defaults to the client's current value).
    if (body.leadTarget !== undefined || body.targetPeriod !== undefined) {
      const lt = body.leadTarget;
      if (lt !== null && (typeof lt !== "number" || !Number.isFinite(lt) || lt < 0)) {
        return NextResponse.json(
          { error: "invalid_lead_target", message: "leadTarget must be a non-negative number or null." },
          { status: 400 }
        );
      }
      const tp = body.targetPeriod ?? client.target_period;
      if (tp !== "week" && tp !== "month") {
        return NextResponse.json(
          { error: "invalid_target_period", message: "targetPeriod must be 'week' or 'month'." },
          { status: 400 }
        );
      }
      const leadTarget = lt === undefined ? client.lead_target : lt;
      await setClientLeadTarget(client.id, leadTarget, tp);
      result.leadTarget = leadTarget;
      result.targetPeriod = tp;
    }

    if (Object.keys(result).length === 0) {
      return NextResponse.json(
        { error: "no_fields", message: "Provide sendRatePerHour, leadTarget, and/or targetPeriod." },
        { status: 400 }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[client] update failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "client_update_failed" }, { status: 500 });
  }
}
