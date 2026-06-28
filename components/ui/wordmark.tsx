/**
 * components/ui/wordmark.tsx — the LeadFlow brand mark ("Fresh"): a soft teal droplet/spark glyph
 * + the wordmark. Inline SVG, no external asset. The mark fills from the --brand* CSS vars, so it
 * re-themes with the rest of the kit (e.g. the R3 white-label portal). Used in the header + login.
 */

export function LeadFlowLogo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      {/* a rounded droplet — the "lead" forming */}
      <path
        d="M16 7c3.4 4 5.5 6.6 5.5 9.4A5.5 5.5 0 0 1 16 22a5.5 5.5 0 0 1-5.5-5.6C10.5 13.6 12.6 11 16 7z"
        fill="var(--brand-fg)"
      />
      <circle cx="16" cy="16.4" r="1.7" fill="var(--brand)" />
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
  const logo = size === "lg" ? "h-9 w-9" : size === "sm" ? "h-6 w-6" : "h-7 w-7";
  const text =
    size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-lg";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LeadFlowLogo className={logo} />
      <span className={`font-medium tracking-tight text-stone-900 ${text}`}>
        Lead<span className="text-brand-strong">Flow</span>
      </span>
    </span>
  );
}
