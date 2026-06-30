/**
 * components/ui/toggle.tsx — a segmented toggle (radio-group semantics) for picking one of a small
 * set of options, e.g. the campaign scrub mode (minimal-premium). The active option lifts onto a
 * near-white surface with a hairline border; each option can carry a tone so a "risky" choice (no
 * scrub) reads visually distinct when selected. The default active tone is `brand` (re-themable);
 * `indigo` is kept as a legacy alias mapping to the brand styling. Directive-free; the parent owns
 * the value.
 */
import type { ReactNode } from "react";

/** Active-state tones. `indigo` is a legacy alias for `brand` (both render the accent). */
type ActiveTone = "brand" | "indigo" | "warning" | "danger";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tone applied when this option is the active one (defaults to brand). */
  activeTone?: ActiveTone;
}

const ACTIVE: Record<ActiveTone, string> = {
  brand: "bg-surface text-brand-strong ring-1 ring-hairline-strong",
  indigo: "bg-surface text-brand-strong ring-1 ring-hairline-strong",
  warning: "bg-surface text-amber-700 ring-1 ring-amber-200",
  danger: "bg-surface text-red-700 ring-1 ring-red-200",
};

export default function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  name,
  disabled,
  className = "",
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  name?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={`inline-flex rounded-lg bg-surface-muted p-1 ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const tone = opt.activeTone ?? "brand";
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              active ? ACTIVE[tone] : "text-ink-muted hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
