/**
 * components/ui/card.tsx — the surface primitive ("Fresh"). White, soft warm border, subtle shadow,
 * 16px radius (rounded-2xl). `as`/`href` lets a card be an <a> (the cockpit drill-through) while
 * keeping the look. Directive-free.
 */
import type { ReactNode } from "react";

export default function Card({
  children,
  className = "",
  padded = true,
  interactive = false,
  href,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  interactive?: boolean;
  href?: string;
}) {
  const cls = `rounded-2xl border border-stone-200/80 bg-white shadow-sm ${
    padded ? "p-5" : ""
  } ${
    interactive
      ? "transition hover:border-brand hover:shadow-md focus-within:border-brand"
      : ""
  } ${className}`;

  if (href) {
    return (
      <a href={href} className={`block ${cls}`}>
        {children}
      </a>
    );
  }
  return <div className={cls}>{children}</div>;
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-stone-900">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-stone-500">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}
