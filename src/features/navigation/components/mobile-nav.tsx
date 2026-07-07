"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { PRIMARY_NAV, isNavItemActive } from "../nav-items";

/**
 * Barra inferior de navegación (solo mobile). Mismas 4 secciones operativas que
 * el nav de desktop, con estado activo. El resto (Onboarding, Settings, tema,
 * salir) está en el menú de cuenta del header.
 */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        "md:hidden fixed bottom-0 inset-x-0 z-50 h-14",
        "glass-strong border-t border-border/50",
        "flex items-center justify-around px-2",
      )}
      aria-label="Navegación principal"
    >
      {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
        const active = isNavItemActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-0.5 text-xs transition-colors",
              active
                ? "text-primary"
                : "text-muted-foreground hover:text-primary",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
