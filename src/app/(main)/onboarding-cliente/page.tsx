// Onboarding del cliente — página del workspace activo.
// Server component: guard de sesión + fetch (seed lazy) y render del
// client component de presentación (patrón de (main)/reportes/page.tsx).

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getActiveWorkspace,
  listMemberships,
} from "@/features/workspace/services/active-workspace";
import { getOrSeedItems } from "@/features/onboarding-cliente/services/onboarding.service";
import { OnboardingClienteView } from "@/features/onboarding-cliente/components/onboarding-cliente-view";

export const dynamic = "force-dynamic";

export default async function OnboardingClientePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [membership, memberships] = await Promise.all([
    getActiveWorkspace(supabase, user.id),
    listMemberships(supabase, user.id),
  ]);

  if (!membership) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground text-sm">
          No tienes un workspace activo.
        </p>
      </div>
    );
  }

  const workspaceName =
    memberships.find((m) => m.workspace_id === membership.workspace_id)?.name ??
    "Workspace";

  const items = await getOrSeedItems(membership.workspace_id);

  return (
    <OnboardingClienteView
      workspaceId={membership.workspace_id}
      workspaceName={workspaceName}
      initialItems={items}
    />
  );
}
