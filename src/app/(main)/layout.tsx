import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getActiveWorkspace,
  listMemberships,
} from "@/features/workspace/services/active-workspace";
import { WorkspaceSwitcher } from "@/features/workspace/components/workspace-switcher";
import { MainNav } from "@/features/navigation/components/main-nav";
import { MobileNav } from "@/features/navigation/components/mobile-nav";
import { AccountMenu } from "@/features/navigation/components/account-menu";
import { cn } from "@/lib/utils";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Super admin flag + active workspace context + membership list (for switcher)
  const [{ data: userRow }, active, memberships] = await Promise.all([
    supabase
      .from("users")
      .select("is_super_admin")
      .eq("id", user.id)
      .maybeSingle(),
    getActiveWorkspace(supabase, user.id),
    listMemberships(supabase, user.id),
  ]);

  const isSuperAdmin = userRow?.is_super_admin ?? false;
  const activeId = active?.workspace_id ?? null;
  const workspaceName =
    memberships.find((m) => m.workspace_id === activeId)?.name ?? null;

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className={cn(
          "glass-strong sticky top-0 z-50 h-14 shrink-0",
          "flex items-center justify-between gap-4 px-3 sm:px-6",
          "border-b border-border/50",
        )}
      >
        {/* Izquierda: marca + workspace */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-display text-base font-semibold text-primary tracking-tight shrink-0">
            Agente WA
          </span>
          {workspaceName && (
            <>
              <span
                className="text-border/70 select-none shrink-0"
                aria-hidden="true"
              >
                /
              </span>
              {memberships.length > 1 && activeId ? (
                <WorkspaceSwitcher
                  workspaces={memberships.map((m) => ({
                    workspace_id: m.workspace_id,
                    name: m.name,
                  }))}
                  activeId={activeId}
                />
              ) : (
                <span
                  className="font-mono text-xs text-muted-foreground truncate max-w-[120px] sm:max-w-[200px]"
                  title={workspaceName}
                >
                  {workspaceName}
                </span>
              )}
            </>
          )}
        </div>

        {/* Centro: navegación operativa del día a día (desktop) */}
        <MainNav />

        {/* Derecha: menú de cuenta (todo lo ocasional agrupado) */}
        <div className="flex items-center shrink-0">
          <AccountMenu email={user.email ?? ""} isSuperAdmin={isSuperAdmin} />
        </div>
      </header>

      <div className="flex-1 pb-14 md:pb-0">{children}</div>

      {/* Navegación inferior (solo mobile) */}
      <MobileNav />
    </div>
  );
}
