import { redirect } from "next/navigation";
import { logout } from "./actions";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";
import { getCockpitData } from "@/lib/cockpit";
import { listClients } from "@/lib/clients";
import CockpitView from "@/components/cockpit-view";
import AppHeader from "@/components/ui/app-header";

export const dynamic = "force-dynamic";

// The operator cockpit — the OPERATOR landing (v2 Module V4). Access is now role-gated (V5):
// unauthenticated → /login; a client user → their own /client dashboard (never the cross-client
// cockpit). Only an operator sees every client's leads-this-cycle vs. guarantee.
export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isOperator(user)) redirect("/client");

  let data = null;
  let clients = null;
  let dbError: string | null = null;
  try {
    [data, clients] = await Promise.all([getCockpitData(), listClients()]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Unknown database error";
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <AppHeader email={user.email} logout={logout} />

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-stone-900">Operator cockpit</h1>
          <p className="mt-1 text-sm text-stone-500">
            Every client at a glance — leads this cycle against their guarantee.
          </p>
        </div>

        {dbError ? (
          <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Database error: {dbError}
          </p>
        ) : (
          <CockpitView data={data!} clients={clients!} />
        )}
      </main>
    </div>
  );
}
