/**
 * components/ui/stat-tile.tsx — a single labeled metric in a tile ("Fresh"). Sentence-case label +
 * a calm number. Optional `tone` tints the tile to flag good/lead/warn/danger values; the `good`
 * tint reads the --brand* CSS vars so it re-themes per client. Directive-free.
 */
import type { ReactNode } from "react";

type StatTone = "default" | "good" | "warn" | "lead" | "danger";

const TONE: Record<StatTone, { box: string; value: string }> = {
  default: { box: "border-stone-200/80 bg-white", value: "text-stone-900" },
  good: { box: "border-brand-tint bg-brand-tint", value: "text-brand-tint-fg" },
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
    <div className={`rounded-2xl border p-3.5 ${t.box}`}>
      <div className={`text-2xl font-medium tabular-nums ${t.value}`}>{value}</div>
      <div className="mt-1 text-xs font-medium text-stone-500">{label}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-stone-400">{hint}</div> : null}
    </div>
  );
}
