import { redirect } from "next/navigation";
import { logout } from "@/app/actions";
import { getSessionUser } from "@/lib/session";
import { isOperator, resolveClientIdForUser } from "@/lib/access";
import { getInboxThreads } from "@/lib/inbox-db";
import { getClientById, clientWindow } from "@/lib/clients";
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
  try {
    const client = await getClientById(clientId);
    if (!client) throw new Error("client not found");
    window = clientWindow(client);
    threads = await getInboxThreads(clientId);
  } catch (err) {
    initialError = err instanceof Error ? err.message : "Unknown database error";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">LeadFlow — Inbox</h1>
          <p className="text-sm text-neutral-500">
            Reply to homeowners and track each lead. Talan Window Cleaning · Tallahassee pilot
          </p>
        </div>
        <div className="flex items-center gap-4">
          <a href="/dashboard" className="text-sm text-neutral-500 hover:text-neutral-900">
            ← Dashboard
          </a>
          <form action={logout}>
            <button className="text-sm text-neutral-500 hover:text-neutral-900">Log out</button>
          </form>
        </div>
      </header>

      {initialError || !threads || !window ? (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          Database error: {initialError ?? "could not load inbox"}
        </p>
      ) : (
        <InboxClient
          initialThreads={threads}
          initialContactId={initialContactId}
          offHours={!withinSendWindow(new Date(), window)}
          windowLabel={sendWindowLabel(window)}
        />
      )}
    </main>
  );
}
