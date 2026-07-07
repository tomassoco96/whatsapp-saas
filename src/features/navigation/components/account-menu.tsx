"use client";

import * as React from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  Building2,
  ChevronDown,
  ClipboardCheck,
  LogOut,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { logout } from "@/features/auth/services/actions";
import { cn } from "@/lib/utils";

interface AccountMenuProps {
  email: string;
  isSuperAdmin: boolean;
}

/**
 * Menú de cuenta: agrupa todo lo que NO es del día a día (Onboarding, Settings,
 * el panel de Agencia para super admins, el tema y el cierre de sesión) detrás
 * de un único disparador, para despejar la barra superior.
 */
export function AccountMenu({ email, isSuperAdmin }: AccountMenuProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [, startTransition] = React.useTransition();

  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";
  const initial = email.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1.5 transition-colors",
            "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
          )}
          aria-label="Menú de cuenta"
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
          {email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem asChild className="gap-2">
          <Link href="/onboarding-cliente">
            <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
            Onboarding
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild className="gap-2">
          <Link href="/settings">
            <Settings className="h-4 w-4" aria-hidden="true" />
            Settings
          </Link>
        </DropdownMenuItem>

        {isSuperAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Agencia
            </DropdownMenuLabel>
            <DropdownMenuItem asChild className="gap-2">
              <Link href="/panel">
                <Building2 className="h-4 w-4" aria-hidden="true" />
                Panel de agencia
              </Link>
            </DropdownMenuItem>
          </>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="gap-2"
          onSelect={(e) => {
            // Mantener el menú abierto para ver el cambio de tema.
            e.preventDefault();
            setTheme(isDark ? "light" : "dark");
          }}
        >
          {isDark ? (
            <Sun className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Moon className="h-4 w-4" aria-hidden="true" />
          )}
          {isDark ? "Tema claro" : "Tema oscuro"}
        </DropdownMenuItem>

        <DropdownMenuItem
          className="gap-2 text-destructive focus:text-destructive"
          onSelect={() => startTransition(() => logout())}
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Salir
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
