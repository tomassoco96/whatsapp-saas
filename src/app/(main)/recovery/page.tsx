import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/features/workspace/services/active-workspace";
import {
  getRecoveryMetrics,
  getRecentCarts,
} from "@/features/ecommerce/services/recovery-metrics";
import { RecoveryDashboard } from "@/features/ecommerce/components/recovery-dashboard";

export const dynamic = "force-dynamic";

export default async function RecoveryPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const membership = await getActiveWorkspace(supabase, user.id);

  if (!membership) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground text-sm">
          No tienes un workspace activo.
        </p>
      </div>
    );
  }

  const [metrics, recentCarts] = await Promise.all([
    getRecoveryMetrics(membership.workspace_id),
    getRecentCarts(membership.workspace_id, 8),
  ]);

  return <RecoveryDashboard metrics={metrics} recentCarts={recentCarts} />;
}
