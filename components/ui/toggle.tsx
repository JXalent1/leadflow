/**
 * components/ui/toggle.tsx — a segmented toggle (radio-group semantics) for picking one of a small
 * set of options, e.g. the campaign scrub mode. Each option can carry a `tone` so a "risky" choice
 * (no scrub) reads visually distinct when selected. Directive-free; the parent owns the value.
 */
import type { ReactNode } from "react";
import type { Tone } from "./badge";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tone applied when this option is the active one (defaults to indigo). */
  activeTone?: Extract<Tone, "indigo" | "warning" | "danger">;
}

const ACTIVE: Record<"indigo" | "warning" | "danger", string> = {
  indigo: "bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-200",
  warning: "bg-white text-amber-700 shadow-sm ring-1 ring-amber-200",
  danger: "bg-white text-red-700 shadow-sm ring-1 ring-red-200",
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
      className={`inline-flex rounded-lg bg-slate-100 p-1 ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const tone = opt.activeTone ?? "indigo";
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              active ? ACTIVE[tone] : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
