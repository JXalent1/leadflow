import { redirect } from "next/navigation";
import { logout } from "./actions";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";
import { getCockpitData } from "@/lib/cockpit";
import CockpitView from "@/components/cockpit-view";

export const dynamic = "force-dynamic";

// The operator cockpit — the OPERATOR landing (v2 Module V4). Access is now role-gated (V5):
// unauthenticated → /login; a client user → their own /client dashboard (never the cross-client
// cockpit). Only an operator sees every client's leads-this-cycle vs. guarantee.
export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isOperator(user)) redirect("/client");

  let data = null;
  let dbError: string | null = null;
  try {
    data = await getCockpitData();
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Unknown database error";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">LeadFlow — Operator Cockpit</h1>
          <p className="text-sm text-neutral-500">
            Leads this cycle vs. each client&apos;s lead guarantee.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-neutral-500">{user.email}</span>
          <form action={logout}>
            <button className="text-sm text-neutral-500 hover:text-neutral-900">
              Log out
            </button>
          </form>
        </div>
      </header>

      {dbError ? (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          Database error: {dbError}
        </p>
      ) : (
        <CockpitView data={data!} />
      )}
    </main>
  );
}
