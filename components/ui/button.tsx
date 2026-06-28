/**
 * components/ui/button.tsx — the one button in the LeadFlow kit ("Fresh").
 *
 * Variants: primary (teal/brand solid), secondary (outline), ghost (text), danger (red). Sizes sm/md.
 * The brand fill reads the --brand* CSS vars so it re-themes per client. Supports `loading`
 * (spinner + disabled) and `disabled`. Renders an <a> when `href` is set so links and buttons share
 * styling. Directive-free so it renders on the server AND inside client components.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { SpinnerIcon } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand text-brand-fg shadow-sm hover:bg-brand-strong",
  secondary:
    "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:text-stone-400",
  ghost: "text-stone-600 hover:bg-stone-100 hover:text-stone-900",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-500 disabled:bg-red-300",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

const BASE =
  "inline-flex items-center justify-center rounded-xl font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap";

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
