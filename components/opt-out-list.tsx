import type { OptOutRow } from "@/lib/dashboard-db";
import { displayName, formatTime } from "./dashboard-utils";

/** Opt-out list — recent STOPs so suppression is visible at a glance. */
export default function OptOutList({
  optOuts,
  total,
}: {
  optOuts: OptOutRow[];
  total: number;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-surface">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium tracking-tight text-ink">Opt-outs ({total})</h2>
      </div>

      {optOuts.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-subtle">
          No opt-outs yet.
        </p>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto">
          {optOuts.map((o) => (
            <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span>
                <span className="font-medium text-ink">
                  {displayName(o.first_name, o.last_name, o.phone)}
                </span>
                {o.first_name || o.last_name ? (
                  <span className="ml-2 text-xs text-ink-subtle">{o.phone}</span>
                ) : null}
              </span>
              <span className="whitespace-nowrap text-xs text-ink-subtle">
                {formatTime(o.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
