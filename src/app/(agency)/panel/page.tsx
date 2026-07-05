import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAgencyRollup,
  resolvePeriod,
} from "@/features/agency/services/agency-metrics";
import { AgencyPanel } from "@/features/agency/components/agency-panel";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ periodo?: string }>;
}

export default async function AgencyPanelPage({ searchParams }: PageProps) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: userRow } = await supabase
    .from("users")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  if (!userRow?.is_super_admin) redirect("/inbox");

  const { periodo } = await searchParams;
  const period = resolvePeriod(periodo);
  const result = await getAgencyRollup(period);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground tracking-tight">
          Panel de agencia
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Todos tus clientes en una pantalla: uso, resultados y gasto del
          período.
        </p>
      </div>

      {/* Error banner */}
      {result.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
          <p className="text-sm text-destructive">
            Error al cargar las métricas: {result.error}
          </p>
        </div>
      )}

      <AgencyPanel
        rollup={
          result.rollup ?? {
            totals: {
              workspaces: 0,
              activeWorkspaces: 0,
              conversations: 0,
              recoveredValue: 0,
              llmCostUsd: 0,
            },
            rows: [],
          }
        }
        period={period}
      />
    </div>
  );
}
