import type { LeadRow } from "@/lib/dashboard-db";
import { displayName, formatTime } from "./dashboard-utils";
import StatusDot from "./ui/status-dot";

/**
 * Leads table — Talan's primary surface. Each row is an interested reply with the
 * homeowner's name + address, the reply text, when it came in, and whether the SMS
 * ping to Talan went through (forwarded / forwarded_at). Made the clearest block on
 * the page: a forwarded=false row is a lead whose ping failed and needs attention.
 */
export default function LeadsTable({ leads }: { leads: LeadRow[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-surface">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-medium tracking-tight text-brand-strong">
          <StatusDot tone="success" />
          Leads ({leads.length})
        </h2>
        <a href="/inbox" className="text-xs font-medium text-brand-strong hover:text-brand">
          Open inbox →
        </a>
      </div>

      {leads.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-subtle">
          No leads yet. Interested replies will appear here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-muted text-xs text-ink-subtle">
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
            <tbody className="divide-y">
              {leads.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="px-4 py-3 font-medium text-ink">
                    {displayName(l.first_name, l.last_name, l.phone)}
                    {l.phone ? (
                      <div className="text-xs font-normal text-ink-subtle">{l.phone}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">{l.address ?? "—"}</td>
                  <td className="px-4 py-3 text-ink-muted">
                    {l.reply_text ? `"${l.reply_text}"` : "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusDot tone="neutral">{l.status}</StatusDot>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink-subtle">
                    {formatTime(l.created_at)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {l.forwarded ? (
                      <StatusDot tone="success">
                        sent{l.forwarded_at ? ` · ${formatTime(l.forwarded_at)}` : ""}
                      </StatusDot>
                    ) : (
                      <StatusDot tone="warning">not sent</StatusDot>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {l.contact_id ? (
                      <a
                        href={`/inbox?contact=${l.contact_id}`}
                        className="text-xs font-medium text-brand-strong hover:text-brand"
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
