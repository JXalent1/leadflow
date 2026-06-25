"use client";

import { useState } from "react";
import type { CampaignSummary } from "@/lib/campaigns";

/**
 * Campaign selector + CSV list uploader (v2 Module V2). Switching campaigns reloads the dashboard
 * scoped to the chosen campaign (?campaignId=). Uploading a CSV POSTs multipart to /api/campaigns,
 * which creates a NEW campaign for the current client and imports the list, then navigates to it.
 *
 * No pipeline logic here — it only selects/creates campaigns. Suppression stays client-level and
 * is enforced server-side at send time.
 */

interface Props {
  clientId: number;
  campaigns: CampaignSummary[];
  selectedCampaignId: number | null;
}

function dashboardUrl(clientId: number, campaignId: number): string {
  return `/dashboard?clientId=${clientId}&campaignId=${campaignId}`;
}

export default function CampaignBar({ clientId, campaigns, selectedCampaignId }: Props) {
  const [showUpload, setShowUpload] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function switchCampaign(id: number) {
    if (id !== selectedCampaignId) window.location.assign(dashboardUrl(clientId, id));
  }

  async function upload() {
    if (!name.trim()) {
      setMsg({ kind: "err", text: "Give the campaign a name." });
      return;
    }
    if (!file) {
      setMsg({ kind: "err", text: "Choose a CSV file." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.append("name", name.trim());
      form.append("file", file);
      const res = await fetch(`/api/campaigns?clientId=${clientId}`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data.detail ? `: ${data.detail}` : "";
        setMsg({ kind: "err", text: `Upload failed (${data.error ?? res.status})${detail}.` });
        return;
      }
      setMsg({
        kind: "ok",
        text: `Created "${data.name}" — imported ${data.imported} of ${data.read} (skipped ${data.skipped}). Loading…`,
      });
      window.location.assign(dashboardUrl(clientId, data.campaignId));
    } catch (err) {
      setMsg({ kind: "err", text: `Upload failed: ${err instanceof Error ? err.message : "network error"}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-neutral-700">Campaign</label>
        {campaigns.length > 0 ? (
          <select
            value={selectedCampaignId ?? ""}
            onChange={(e) => switchCampaign(Number(e.target.value))}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.contact_count} contacts · {c.status}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-neutral-400">No campaigns yet.</span>
        )}

        <button
          onClick={() => setShowUpload((v) => !v)}
          className="ml-auto rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
        >
          {showUpload ? "Close" : "Upload new list →"}
        </button>
      </div>

      {showUpload ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-neutral-100 pt-4">
          <p className="text-xs text-neutral-500">
            CSV columns: <span className="font-mono">FirstName, LastName, Address, City, State, Zip</span>{" "}
            (Address required). Creates a new campaign for this client and imports the list.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Campaign name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-56 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm"
            />
            <button
              disabled={busy}
              onClick={upload}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
            >
              {busy ? "Uploading…" : "Create campaign + import"}
            </button>
          </div>
        </div>
      ) : null}

      {msg ? (
        <p
          className={`mt-3 rounded-md px-3 py-2 text-sm ${
            msg.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
