/**
 * components/ui/button.tsx — the one button in the LeadFlow kit (minimal-premium).
 *
 * Variants: primary (brand solid), secondary (hairline outline), ghost (text), danger (red). Sizes
 * sm/md. Flat — no shadows, crisp 8px radius, only a focus ring. The brand fill reads the --brand*
 * CSS vars so it re-themes per client. Supports `loading` (spinner + disabled) and `disabled`.
 * Renders an <a> when `href` is set so links and buttons share styling. Directive-free so it renders
 * on the server AND inside client components.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { SpinnerIcon } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand text-brand-fg hover:bg-brand-strong",
  secondary:
    "border border-hairline-strong bg-surface text-ink-muted hover:bg-surface-muted hover:text-ink disabled:text-ink-subtle",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
};

const BASE =
  "inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap";

export function buttonClasses(opts?: {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  className?: string;
}): string {
  const { variant = "primary", size = "md", fullWidth, className = "" } = opts ?? {};
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${fullWidth ? "w-full" : ""} ${className}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
  href?: string;
  children: ReactNode;
}

export default function Button({
  variant = "primary",
  size = "md",
  fullWidth,
  loading,
  href,
  children,
  className = "",
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const cls = buttonClasses({ variant, size, fullWidth, className });

  if (href) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }

  return (
    <button
      type={type ?? "button"}
      disabled={disabled || loading}
      className={cls}
      {...rest}
    >
      {loading ? <SpinnerIcon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}
