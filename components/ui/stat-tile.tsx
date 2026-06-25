/**
 * components/ui/stat-tile.tsx — a single labeled metric in a tile. Optional `tone` tints the tile
 * to flag good/warn/lead values (used by the dashboard count grid). Directive-free.
 */
import type { ReactNode } from "react";

type StatTone = "default" | "good" | "warn" | "lead" | "danger";

const TONE: Record<StatTone, { box: string; value: string }> = {
  default: { box: "border-slate-200 bg-white", value: "text-slate-900" },
  good: { box: "border-indigo-200 bg-indigo-50/60", value: "text-indigo-700" },
  lead: { box: "border-emerald-200 bg-emerald-50/70", value: "text-emerald-700" },
  warn: { box: "border-amber-200 bg-amber-50/70", value: "text-amber-700" },
  danger: { box: "border-red-200 bg-red-50/70", value: "text-red-700" },
};

export default function StatTile({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: StatTone;
  hint?: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div className={`rounded-xl border p-3.5 ${t.box}`}>
      <div className={`text-2xl font-semibold tabular-nums ${t.value}`}>{value}</div>
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}
