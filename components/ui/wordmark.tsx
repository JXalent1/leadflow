/**
 * components/ui/wordmark.tsx — the LeadFlow brand mark: a small flow glyph + the wordmark.
 * Tailwind-only, inline SVG. Used in the app header and the login card.
 */

export function LeadFlowLogo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#4f46e5" />
      <path
        d="M8 20.5c3-1 4.5-3.2 5.5-5.5C14.7 12 16.4 9.5 20 9.5"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="9.5" r="2.4" fill="white" />
      <circle cx="9" cy="22.5" r="2" fill="#a5b4fc" />
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
      <span className={`font-semibold tracking-tight text-slate-900 ${text}`}>
        Lead<span className="text-indigo-600">Flow</span>
      </span>
    </span>
  );
}
