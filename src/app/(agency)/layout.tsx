import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { Building2, LayoutDashboard, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { logout } from "@/features/auth/services/actions";
import { Badge } from "@/components/ui/badge";

export default async function AgencyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className={cn(
          "glass-strong sticky top-0 z-50 h-14 shrink-0",
          "flex items-center justify-between px-3 sm:px-6",
          "border-b border-border/50",
        )}
      >
        <div className="flex items-center gap-2.5">
          <span className="font-display text-base font-semibold text-primary tracking-tight">
            Agente WA
          </span>
          <Badge
            variant="outline"
            className="border-primary/30 bg-primary/10 text-primary text-xs font-mono px-1.5 py-0"
          >
            Agency
          </Badge>
        </div>

        <div className="flex items-center gap-1">
          <Link href="/inbox">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-2">App</span>
            </Button>
          </Link>

          <form action={logout}>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-2">Salir</span>
            </Button>
          </form>
        </div>
      </header>

      {/* Agency sub-nav */}
      <nav
        className="border-b border-border/50 bg-background/60 px-3 sm:px-6"
        aria-label="Navegación de agencia"
      >
        <div className="flex items-center gap-0.5 h-10">
          <Link
            href="/panel"
            className={cn(
              "flex items-center gap-1.5 px-3 h-full",
              "text-sm text-muted-foreground hover:text-foreground",
              "border-b-2 border-transparent hover:border-border",
              "transition-colors duration-150",
            )}
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
            Panel
          </Link>
          <Link
            href="/workspaces"
            className={cn(
              "flex items-center gap-1.5 px-3 h-full",
              "text-sm text-muted-foreground hover:text-foreground",
              "border-b-2 border-transparent hover:border-border",
              "transition-colors duration-150",
            )}
          >
            <Building2 className="h-4 w-4" aria-hidden="true" />
            Workspaces
          </Link>
        </div>
      </nav>

      <main className="flex-1 px-3 sm:px-6 py-6">{children}</main>
    </div>
  );
}
