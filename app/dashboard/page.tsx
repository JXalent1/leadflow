import { redirect } from "next/navigation";
import { logout } from "@/app/actions";
import { getSessionUser } from "@/lib/session";
import { isOperator, resolveClientIdForUser } from "@/lib/access";
import { getDashboardData } from "@/lib/dashboard";
import { getClientById } from "@/lib/clients";
import { resolveCampaignForClient, listCampaigns } from "@/lib/campaigns";
import { requestedClientIdFromSearchParams, campaignIdFromSearchParams } from "@/lib/request-client";
import DashboardClient from "@/components/dashboard-client";
import CampaignBar from "@/components/campaign-bar";

// Always render fresh — counts/leads/replies change as the campaign runs.
export const dynamic = "force-dynamic";

// Operator-only (V5). Unauthenticated → /login; a client user → their own /client dashboard. The
// operator may view any client via ?clientId= (resolved through the session, not the bare param).
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { clientId?: string; campaignId?: string };
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isOperator(user)) redirect("/client");

  const clientId = resolveClientIdForUser(user, requestedClientIdFromSearchParams(searchParams));
  if (clientId === null) redirect("/");
  let initialError: string | null = null;
  let initial = null;
  let clientName = "";
  let campaigns: Awaited<ReturnType<typeof listCampaigns>> = [];
  let selectedCampaignId: number | null = null;
  try {
    const client = await getClientById(clientId);
    if (!client) throw new Error("client not found");
    clientName = client.name;
    campaigns = await listCampaigns(clientId);
    const campaign = await resolveCampaignForClient(clientId, campaignIdFromSearchParams(searchParams));
    if (campaign) {
      selectedCampaignId = campaign.id;
      initial = await getDashboardData(client, campaign);
    }
  } catch (err) {
    initialError = err instanceof Error ? err.message : "Unknown database error";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">LeadFlow — Campaign Dashboard</h1>
          <p className="text-sm text-neutral-500">
            {clientName || "Client"}
            {initial ? ` · ${initial.campaignName}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <a href="/" className="text-sm text-neutral-500 hover:text-neutral-900">
            ← All clients
          </a>
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

      <CampaignBar
        clientId={clientId}
        campaigns={campaigns}
        selectedCampaignId={selectedCampaignId}
      />

      {initialError ? (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          Database error: {initialError}
        </p>
      ) : !initial ? (
        <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No campaign yet. Upload a CSV list above to create one and start the pipeline.
        </p>
      ) : (
        <DashboardClient
          initial={initial}
          clientId={clientId}
          campaignId={initial.campaignId}
        />
      )}
    </main>
  );
}
