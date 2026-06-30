/**
 * components/ui/badge.tsx — a small, quiet status pill (minimal-premium). One `tone` maps to a
 * consistent color across the app (mode, invoice status, etc.). Flat tint + hairline ring, no shadow.
 * The `brand` tone reads the --brand* CSS vars so it re-themes per client. Directive-free.
 *
 * For inline list/table status prefer StatusDot (a dot + muted label) — badges are for chips.
 */
import type { ReactNode } from "react";

export type Tone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-muted text-ink-muted ring-hairline-strong",
  brand: "bg-brand-tint text-brand-tint-fg ring-brand-tint",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
  info: "bg-sky-50 text-sky-700 ring-sky-200",
};

export default function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
