import { redirect } from "next/navigation";
import { logout } from "@/app/actions";
import { getSessionUser } from "@/lib/session";
import { isOperator, resolveClientIdForUser } from "@/lib/access";
import { getInboxThreads } from "@/lib/inbox-db";
import { getClientById, clientWindow, listClients } from "@/lib/clients";
import { requestedClientIdFromSearchParams } from "@/lib/request-client";
import { withinSendWindow, sendWindowLabel } from "@/lib/twilio";
import InboxClient from "@/components/inbox/inbox-client";

// Always render fresh — threads change as replies come in / go out.
export const dynamic = "force-dynamic";

// Operator-only (V5): the inbox sends replies, so it is never exposed to a client user.
export default async function InboxPage({
  searchParams,
}: {
  searchParams: { contact?: string; clientId?: string };
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isOperator(user)) redirect("/client");

  const clientId = resolveClientIdForUser(user, requestedClientIdFromSearchParams(searchParams));
  if (clientId === null) redirect("/");

  const initialContactId = (() => {
    const n = Number(searchParams.contact);
    return Number.isInteger(n) && n > 0 ? n : null;
  })();

  let initialError: string | null = null;
  let threads = null;
  let window = null;
  let clientName = "";
  // Operator-only surface, so listing every client for the switcher is in-scope (mirrors the
  // cockpit). A client-role user never reaches here (redirected to /client above), and every
  // inbox read/write is still scoped to the RESOLVED clientId, never the bare list.
  let clientOptions: { id: number; name: string }[] = [];
  try {
    const client = await getClientById(clientId);
    if (!client) throw new Error("client not found");
    clientName = client.name;
    window = clientWindow(client);
    threads = await getInboxThreads(clientId);
    clientOptions = (await listClients()).map((c) => ({ id: c.id, name: c.name }));
  } catch (err) {
    initialError = err instanceof Error ? err.message : "Unknown database error";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-ink">LeadFlow — Inbox</h1>
          <p className="text-sm text-ink-subtle">
            Reply to homeowners and track each lead{clientName ? ` · ${clientName}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <a
            href={`/dashboard?clientId=${clientId}`}
            className="text-sm text-ink-subtle hover:text-ink"
          >
            ← Dashboard
          </a>
          <form action={logout}>
            <button className="text-sm text-ink-subtle hover:text-ink">Log out</button>
          </form>
        </div>
      </header>

      {initialError || !threads || !window ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Database error: {initialError ?? "could not load inbox"}
        </p>
      ) : (
        <InboxClient
          clientId={clientId}
          clients={clientOptions}
          initialThreads={threads}
          initialContactId={initialContactId}
          offHours={!withinSendWindow(new Date(), window)}
          windowLabel={sendWindowLabel(window)}
        />
      )}
    </main>
  );
}
