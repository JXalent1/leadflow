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
import AppHeader from "@/components/ui/app-header";
import Button from "@/components/ui/button";
import { ArrowLeftIcon, InboxIcon } from "@/components/ui/icons";

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
    <div className="min-h-screen bg-surface-sunken">
      <AppHeader
        email={user.email}
        logout={logout}
        nav={
          <>
            <a
              href="/"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-ink-subtle transition-colors hover:text-ink"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              <span className="hidden sm:inline">All clients</span>
            </a>
            <Button href="/inbox" variant="secondary" size="sm">
              <InboxIcon className="h-4 w-4" />
              Inbox
            </Button>
          </>
        }
      />

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-ink">
            {clientName || "Client"}
          </h1>
          <p className="mt-1 text-sm text-ink-subtle">
            Campaign dashboard{initial ? ` · ${initial.campaignName}` : ""}
          </p>
        </div>

        <CampaignBar
          clientId={clientId}
          campaigns={campaigns}
          selectedCampaignId={selectedCampaignId}
        />

        {initialError ? (
          <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Database error: {initialError}
          </p>
        ) : !initial ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
    </div>
  );
}
