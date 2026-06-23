import { redirect } from "next/navigation";
import { isAuthed, logout } from "@/app/actions";
import { getDashboardData } from "@/lib/dashboard";
import DashboardClient from "@/components/dashboard-client";

// Always render fresh — counts/leads/replies change as the campaign runs.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Reuse the Session 1 admin gate. Unauthed → back to the / login.
  if (!(await isAuthed())) {
    redirect("/");
  }

  let initialError: string | null = null;
  let initial = null;
  try {
    initial = await getDashboardData();
  } catch (err) {
    initialError = err instanceof Error ? err.message : "Unknown database error";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">LeadFlow — Campaign Dashboard</h1>
          <p className="text-sm text-neutral-500">
            Talan Window Cleaning · Tallahassee pilot
          </p>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="/inbox"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Inbox →
          </a>
          <form action={logout}>
            <button className="text-sm text-neutral-500 hover:text-neutral-900">
              Log out
            </button>
          </form>
        </div>
      </header>

      {initialError || !initial ? (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          Database error: {initialError ?? "could not load dashboard data"}
        </p>
      ) : (
        <DashboardClient initial={initial} />
      )}
    </main>
  );
}
