/**
 * components/ui/progress-bar.tsx — a rounded track + fill ("Fresh"). `tone` colors the fill
 * consistently (pace/send); the default `brand` fill reads the --brand* CSS vars so it re-themes per
 * client. Clamps value to [0,100]. Directive-free.
 */

type BarTone = "brand" | "success" | "warning" | "danger";

const FILL: Record<BarTone, string> = {
  brand: "bg-brand",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

export default function ProgressBar({
  value,
  tone = "brand",
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
      className={`w-full overflow-hidden rounded-full bg-stone-100 ${height} ${className}`}
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
