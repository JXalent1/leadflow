"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Badge from "./ui/badge";
import type { Tone } from "./ui/badge";
import Button from "./ui/button";

/**
 * components/cockpit-billing.tsx — the per-client billing control on the operator cockpit. (V6.)
 *
 * Track-only: shows the current cycle's invoice status + next bill date and lets the operator mark
 * it invoiced / paid. NO payment processing — it POSTs to /api/billing which only records status;
 * collection happens outside the app. After a successful mark it refreshes the server-rendered
 * cockpit so the new status shows. The links above are <a> navigations, so this control stops click
 * propagation to avoid triggering the card's drill-through.
 */

type Status = "due" | "invoiced" | "paid";

const STATUS_PILL: Record<Status, { text: string; tone: Tone }> = {
  due: { text: "Due", tone: "warning" },
  invoiced: { text: "Invoiced", tone: "info" },
  paid: { text: "Paid ✓", tone: "success" },
};

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function fmtAmount(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function CockpitBilling({
  clientId,
  status,
  amountCents,
  nextBillDate,
}: {
  clientId: number;
  status: Status;
  amountCents: number;
  nextBillDate: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pill = STATUS_PILL[status];

  async function mark(action: "invoiced" | "paid", e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/billing?clientId=${clientId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch {
      setErr("network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-slate-500">
        {fmtAmount(amountCents)}/mo · next bill {fmtDate(nextBillDate)}
      </span>
      <Badge tone={pill.tone}>{pill.text}</Badge>
      <div className="ml-auto flex items-center gap-2">
        {status !== "paid" ? (
          <Button variant="secondary" size="sm" onClick={(e) => mark("invoiced", e)} disabled={busy}>
            Mark invoiced
          </Button>
        ) : null}
        {status !== "paid" ? (
          <Button variant="secondary" size="sm" onClick={(e) => mark("paid", e)} disabled={busy}>
            Mark paid
          </Button>
        ) : null}
        {err ? <span className="text-red-600">{err}</span> : null}
      </div>
    </div>
  );
}
