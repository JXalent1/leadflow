/**
 * components/ui/field.tsx — form field primitives ("Fresh"). `Field` wraps a control with a label,
 * optional help text, and an inline error (the label is tied to the control via htmlFor/id). `Input`
 * and `Select` are the styled controls — rounded, warm border, teal/brand focus ring. Directive-free
 * so they work in server + client trees.
 */
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export const inputClasses =
  "w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 transition-colors focus:border-brand disabled:bg-stone-50 disabled:text-stone-400";

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
        <label htmlFor={htmlFor} className="text-sm font-medium text-stone-700">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : help ? (
        <p className="text-xs text-stone-500">{help}</p>
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
