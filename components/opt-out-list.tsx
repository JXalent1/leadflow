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
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Opt-outs ({total})</h2>
      </div>

      {optOuts.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          No opt-outs yet.
        </p>
      ) : (
        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
          {optOuts.map((o) => (
            <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span>
                <span className="font-medium">
                  {displayName(o.first_name, o.last_name, o.phone)}
                </span>
                {o.first_name || o.last_name ? (
                  <span className="ml-2 text-xs text-slate-400">{o.phone}</span>
                ) : null}
              </span>
              <span className="whitespace-nowrap text-xs text-slate-400">
                {formatTime(o.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
