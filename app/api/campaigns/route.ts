// /api/campaigns — operator campaign list + CSV list uploader. (v2 Module V2)
//
// AUTH: both verbs require an operator session (requireOperator) — campaigns hold contact lists.
//
// GET   list the selected client's campaigns (+ contact counts) for the campaign selector.
// POST  multipart/form-data { name, file } → create a NEW campaign under the selected client and
//       import the CSV's contacts into it. This is the product path that replaces the
//       scripts/import-csv.ts flow. Returns an import summary { campaignId, read, imported, skipped }.
//
// Scoping: the campaign is created under the operator's resolved client (session + ?clientId=). Every
// inserted contact carries that client_id + the new campaign_id. Suppression is NOT touched here —
// it stays client-level by phone and is enforced at send time (getEligibleContacts).

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { requestedClientId } from "@/lib/request-client";
import { getClientById } from "@/lib/clients";
import {
  listCampaigns,
  createCampaign,
  setCampaignStatus,
  setCampaignScrubMode,
  getCampaignForClient,
  isScrubMode,
} from "@/lib/campaigns";
import { insertContact } from "@/lib/db";
import { parseContactsCsv } from "@/lib/csv-import";

// A large list import loops many inserts; allow the platform max.
export const maxDuration = 300;

// Upload bounds (review S1): cap the file size + row count so one oversized CSV can't read into
// memory + loop past the 300s ceiling and strand a half-imported campaign.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_UPLOAD_ROWS = 50_000;

export async function GET(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const campaigns = await listCampaigns(clientId);
    return NextResponse.json({ clientId, campaigns });
  } catch (err) {
    console.error("[campaigns] list failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "campaigns_list_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const client = await getClientById(clientId);
    if (!client) {
      return NextResponse.json({ error: "client_not_found" }, { status: 404 });
    }

    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: "expected_multipart_form" }, { status: 400 });
    }
    const name = String(form.get("name") ?? "").trim();
    const file = form.get("file");
    // Module N: optional per-campaign scrub mode. Default 'vendor' (Tracerfy scrub). 'none' = the
    // no-scrub passthrough. Reject anything else so a bad value can't land in the DB.
    const rawScrubMode = form.get("scrubMode");
    const scrubMode = rawScrubMode == null ? "vendor" : String(rawScrubMode);
    if (!isScrubMode(scrubMode)) {
      return NextResponse.json({ error: "invalid_scrub_mode" }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "campaign_name_required" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "csv_file_required" }, { status: 400 });
    }
    // Bound the work: a too-large file would read into memory + loop enough inserts to blow the
    // 300s function ceiling and leave a half-imported campaign (review S1). Operator-only, but a
    // single misfiled CSV shouldn't DoS the upload path.
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "csv_too_large", maxBytes: MAX_UPLOAD_BYTES }, { status: 413 });
    }

    const raw = await file.text();
    const parsed = parseContactsCsv(raw);
    if (parsed.error) {
      return NextResponse.json({ error: "csv_invalid", detail: parsed.error }, { status: 400 });
    }
    if (parsed.rows.length === 0) {
      return NextResponse.json(
        { error: "csv_no_valid_rows", read: parsed.read, skipped: parsed.skipped },
        { status: 400 }
      );
    }
    if (parsed.rows.length > MAX_UPLOAD_ROWS) {
      return NextResponse.json(
        { error: "csv_too_many_rows", max: MAX_UPLOAD_ROWS, rows: parsed.rows.length },
        { status: 400 }
      );
    }

    // Create the campaign FIRST so every contact gets a valid campaign_id (NOT NULL, no default).
    const campaignId = await createCampaign(clientId, name, null, scrubMode);
    for (const row of parsed.rows) {
      await insertContact(clientId, campaignId, row);
    }
    // A campaign with a loaded list is ready for the trace → scrub → send pipeline.
    await setCampaignStatus(clientId, campaignId, "ready");

    return NextResponse.json({
      ok: true,
      clientId,
      campaignId,
      name,
      scrubMode,
      read: parsed.read,
      imported: parsed.rows.length,
      skipped: parsed.skipped,
    });
  } catch (err) {
    console.error("[campaigns] upload failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "campaign_upload_failed" }, { status: 500 });
  }
}

// PATCH { campaignId, scrubMode } → flip an existing campaign's scrub mode (Module N). Operator-only,
// scoped to the resolved client: a campaign that doesn't belong to the client → 404.
export async function PATCH(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const campaignId = Number(body.campaignId);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return NextResponse.json({ error: "campaign_id_required" }, { status: 400 });
    }
    if (!isScrubMode(body.scrubMode)) {
      return NextResponse.json({ error: "invalid_scrub_mode" }, { status: 400 });
    }
    // Ownership check before the write so an operator can't flip another client's campaign.
    const campaign = await getCampaignForClient(clientId, campaignId);
    if (!campaign) {
      return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
    }
    await setCampaignScrubMode(clientId, campaignId, body.scrubMode);
    return NextResponse.json({ ok: true, campaignId, scrubMode: body.scrubMode });
  } catch (err) {
    console.error("[campaigns] patch failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "campaign_patch_failed" }, { status: 500 });
  }
}
