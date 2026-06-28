/**
 * components/ui/icons.tsx — tiny inline SVG icons for the LeadFlow UI kit. No icon dependency.
 * Each takes className (size/color via Tailwind text, h-, w- utilities) and inherits currentColor.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SpinnerIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" {...p}>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function ArrowRightIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function ArrowLeftIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  );
}

export function ChevronDownIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function CheckIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function ShieldIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
    </svg>
  );
}

export function PauseIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

export function InboxIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5.5L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.5-6.5A2 2 0 0016.8 4H7.2a2 2 0 00-1.7 1.5z" />
    </svg>
  );
}

// A friendly "service" glyph (a clean spark) used as the leading icon on cockpit client cards.
export function SparkleIcon({ className = "h-4 w-4", ...p }: IconProps) {
  return (
    <svg className={className} {...base} {...p}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    </svg>
  );
}
