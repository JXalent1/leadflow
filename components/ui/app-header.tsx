/**
 * components/ui/app-header.tsx — the shared top bar: LeadFlow wordmark (links home) on the left,
 * an optional `nav` slot, then the signed-in email + a Log out button on the right. Rendered by the
 * server pages; `logout` is a server action passed in. Directive-free.
 */
import type { ReactNode } from "react";
import { Wordmark } from "./wordmark";

export default function AppHeader({
  email,
  logout,
  homeHref = "/",
  nav,
}: {
  email?: string;
  logout: () => void | Promise<void>;
  homeHref?: string;
  nav?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
        <a href={homeHref} className="shrink-0 rounded-md">
          <Wordmark />
        </a>
        <div className="flex items-center gap-3">
          {nav}
          {email ? (
            <span className="hidden text-sm text-slate-500 sm:inline">{email}</span>
          ) : null}
          <form action={logout}>
            <button className="rounded-md px-2 py-1 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900">
              Log out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
