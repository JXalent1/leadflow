/**
 * components/ui/wordmark.tsx — the LeadFlow brand mark (minimal-premium): a restrained neutral glyph
 * (a rounded square with a simple "flow" stroke) + the wordmark, all in ink. Inline SVG, no external
 * asset. Deliberately NOT brand-colored — the mark stays neutral so it reads premium and never fights
 * the per-client accent in the white-label portal. Used in the header + login.
 */

export function LeadFlowLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--text-primary)" />
      {/* a simple upward "flow" stroke */}
      <path
        d="M9 21l5-6 4 3 5-7"
        stroke="var(--surface-2)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({
  size = "md",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const logo = size === "lg" ? "h-8 w-8" : size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const text =
    size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-lg";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LeadFlowLogo className={logo} />
      <span className={`font-medium tracking-tight text-ink ${text}`}>
        Lead<span className="text-ink-muted">Flow</span>
      </span>
    </span>
  );
}
