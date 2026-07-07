import {
  FileText,
  LayoutDashboard,
  MessageCircle,
  ShoppingCart,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

/**
 * Navegación principal: solo lo operativo del día a día.
 * Lo ocasional (Onboarding, Settings, Agency, tema, salir) vive en el
 * menú de cuenta (ver account-menu.tsx).
 */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/inbox", label: "Inbox", icon: MessageCircle },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/recovery", label: "Carritos", icon: ShoppingCart },
  { href: "/reportes", label: "Reportes", icon: FileText },
];

/** Devuelve true si la ruta actual pertenece a la sección del item. */
export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
