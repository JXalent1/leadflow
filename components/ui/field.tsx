/**
 * components/ui/field.tsx — form field primitives. `Field` wraps a control with a label, optional
 * help text, and an inline error (the label is tied to the control via htmlFor/id). `Input` and
 * `Select` are the styled controls. Directive-free so they work in server + client trees.
 */
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export const inputClasses =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-indigo-500 disabled:bg-slate-50 disabled:text-slate-400";

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
        <label htmlFor={htmlFor} className="text-sm font-medium text-slate-700">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : help ? (
        <p className="text-xs text-slate-500">{help}</p>
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
