/**
 * components/ui/progress-bar.tsx — a rounded track + fill. `tone` colors the fill consistently
 * (pace/send). Clamps value to [0,100]. Directive-free.
 */

type BarTone = "indigo" | "success" | "warning" | "danger";

const FILL: Record<BarTone, string> = {
  indigo: "bg-indigo-600",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

export default function ProgressBar({
  value,
  tone = "indigo",
  className = "",
  height = "h-2",
}: {
  value: number;
  tone?: BarTone;
  className?: string;
  height?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-slate-100 ${height} ${className}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-all ${FILL[tone]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
