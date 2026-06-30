/**
 * components/ui/status-dot.tsx — the minimal-premium status indicator: a small colored dot + a quiet
 * muted label. Used in dense lists/tables (cockpit pace, send window) where a loud pill would shout.
 * Directive-free; the `brand` tone reads the --brand* CSS vars so it re-themes per client.
 */
import type { ReactNode } from "react";

export type DotTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const DOT: Record<DotTone, string> = {
  neutral: "bg-ink-subtle",
  brand: "bg-brand",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  info: "bg-sky-500",
};

export default function StatusDot({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: DotTone;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs text-ink-muted ${className}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
      {children}
    </span>
  );
}
