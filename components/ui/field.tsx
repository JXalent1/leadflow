/**
 * components/ui/field.tsx — form field primitives (minimal-premium). `Field` wraps a control with a
 * label, optional help text, and an inline error (label tied to the control via htmlFor/id). `Input`
 * and `Select` are the styled controls — crisp 8px radius, hairline border, brand focus border.
 * Directive-free so they work in server + client trees.
 */
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export const inputClasses =
  "w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle transition-colors focus:border-brand disabled:bg-surface-muted disabled:text-ink-subtle";

export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
  className = "",
}: {
  label?: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink-muted">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : help ? (
        <p className="text-xs text-ink-subtle">{help}</p>
      ) : null}
    </div>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputClasses} ${className}`} {...props} />;
}

export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${inputClasses} ${className}`} {...props}>
      {children}
    </select>
  );
}
