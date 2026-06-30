import { redirect } from "next/navigation";
import { logout } from "@/app/actions";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";
import { getClientById } from "@/lib/clients";
import { getPortalData } from "@/lib/portal";
import PortalClient from "@/components/client/portal-client";

export const dynamic = "force-dynamic";

// The CLIENT dashboard (v2 Module V5): a clean, read-mostly, branded view of the client's own leads
// + progress to their monthly guarantee. The client is taken STRICTLY from the session — never a
// param — so a client only ever sees their own data. Operators are sent to the cockpit.
export default async function ClientPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (isOperator(user)) redirect("/"); // operators use the cockpit, not the single-client portal
  if (user.client_id == null) redirect("/login"); // misconfigured client user

  let initial = null;
  let clientName = "";
  let error: string | null = null;
  try {
    const client = await getClientById(user.client_id);
    if (!client) throw new Error("client not found");
    clientName = client.name;
    initial = await getPortalData(client);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unknown error";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-ink">{initial?.bizName || clientName || "LeadFlow"}</h1>
          <p className="text-sm text-ink-subtle">Your leads — powered by LeadFlow</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-ink-subtle">{user.email}</span>
          <form action={logout}>
            <button className="text-sm text-ink-subtle hover:text-ink">Log out</button>
          </form>
        </div>
      </header>

      {error || !initial ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not load your dashboard{error ? `: ${error}` : ""}.
        </p>
      ) : (
        <PortalClient initial={initial} />
      )}
    </main>
  );
}
