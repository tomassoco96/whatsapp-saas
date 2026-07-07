"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { PRIMARY_NAV, isNavItemActive } from "../nav-items";

/**
 * Nav principal (desktop). Solo las 4 secciones operativas, con estado activo
 * para que siempre se sepa en qué parte de la app estás. Oculto en mobile: ahí
 * navega la barra inferior (mobile-nav.tsx).
 */
export function MainNav() {
  const pathname = usePathname();

  return (
    <nav
      className="hidden items-center gap-0.5 md:flex"
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
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-muted/60 text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
