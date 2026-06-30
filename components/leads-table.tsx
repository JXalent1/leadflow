import type { LeadRow } from "@/lib/dashboard-db";
import { displayName, formatTime } from "./dashboard-utils";

/**
 * Leads table — Talan's primary surface. Each row is an interested reply with the
 * homeowner's name + address, the reply text, when it came in, and whether the SMS
 * ping to Talan went through (forwarded / forwarded_at). Made the clearest block on
 * the page: a forwarded=false row is a lead whose ping failed and needs attention.
 */
export default function LeadsTable({
  leads,
  clientId,
}: {
  leads: LeadRow[];
  clientId: number;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-emerald-300 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-emerald-200 bg-emerald-50 px-4 py-3">
        <h2 className="text-base font-semibold text-emerald-900">
          Leads ({leads.length})
        </h2>
        <a
          href={`/inbox?clientId=${clientId}`}
          className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
        >
          Open inbox →
        </a>
      </div>

      {leads.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          No leads yet. Interested replies will appear here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Address</th>
                <th className="px-4 py-2 font-medium">Reply</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Received</th>
                <th className="px-4 py-2 font-medium">Ping to Talan</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {leads.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="px-4 py-3 font-medium">
                    {displayName(l.first_name, l.last_name, l.phone)}
                    {l.phone ? (
                      <div className="text-xs font-normal text-slate-400">{l.phone}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{l.address ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {l.reply_text ? `"${l.reply_text}"` : "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {l.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-500">
                    {formatTime(l.created_at)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {l.forwarded ? (
                      <span className="text-emerald-600">
                        ✓ sent{l.forwarded_at ? ` · ${formatTime(l.forwarded_at)}` : ""}
                      </span>
                    ) : (
                      <span className="font-medium text-amber-600">⚠ not sent</span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {l.contact_id ? (
                      <a
                        href={`/inbox?contact=${l.contact_id}&clientId=${clientId}`}
                        className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
                      >
                        Open →
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
