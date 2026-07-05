import { createClient as createSbClient } from "@supabase/supabase-js";
import type { WcWorkspaceConfig } from "./wc-config";
import type { TnWorkspaceConfig } from "./tn-config";
import type { ShopifyWorkspaceConfig } from "./shopify-config";
import type { ProductSearchQuery } from "./search.service";
import type { OrderLookupQuery } from "./lookup.service";
import type { ProductSearchResult, OrderLookupResult } from "../types";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * Resolución del proveedor de e-commerce conectado a un workspace, para que
 * las tools buscar_producto / estado_pedido funcionen igual con WooCommerce,
 * Tiendanube o Shopify sin que el LLM sepa cuál hay detrás.
 *
 * Un workspace conecta UNA tienda: si hubiera más de una integración enabled,
 * gana la primera según PROVIDER_PRIORITY (WooCommerce por compatibilidad).
 */

export type EcommerceProviderName = "woocommerce" | "tiendanube" | "shopify";

const PROVIDER_PRIORITY: EcommerceProviderName[] = [
  "woocommerce",
  "tiendanube",
  "shopify",
];

export type EcommerceConnection =
  | { provider: "woocommerce"; cfg: WcWorkspaceConfig }
  | { provider: "tiendanube"; cfg: TnWorkspaceConfig }
  | { provider: "shopify"; cfg: ShopifyWorkspaceConfig };

/**
 * Devuelve la conexión de e-commerce activa del workspace, o null si ninguna
 * integración está habilitada con config válida. Los imports son dinámicos
 * (mismo patrón que las tools) para no cargar los tres clientes siempre.
 */
export async function getEcommerceConnection(
  workspaceId: string,
): Promise<EcommerceConnection | null> {
  const supabase = svc();
  const { data, error } = await supabase
    .from("integrations")
    .select("provider")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .in("provider", PROVIDER_PRIORITY);

  if (error || !data) return null;
  const enabled = new Set(
    (data as Array<{ provider: string }>).map((r) => r.provider),
  );

  for (const provider of PROVIDER_PRIORITY) {
    if (!enabled.has(provider)) continue;
    if (provider === "woocommerce") {
      const { getWcConfig } = await import("./wc-config");
      const cfg = await getWcConfig(workspaceId);
      if (cfg) return { provider, cfg };
    } else if (provider === "tiendanube") {
      const { getTnConfig } = await import("./tn-config");
      const cfg = await getTnConfig(workspaceId);
      if (cfg) return { provider, cfg };
    } else {
      const { getShopifyConfig } = await import("./shopify-config");
      const cfg = await getShopifyConfig(workspaceId);
      if (cfg) return { provider, cfg };
    }
  }
  return null;
}

/** True cuando la conexión tiene credenciales para consultar pedidos. */
export async function connectionCanLookupOrders(
  conn: EcommerceConnection,
): Promise<boolean> {
  switch (conn.provider) {
    case "woocommerce": {
      const { canLookupOrders } = await import("./wc-config");
      return canLookupOrders(conn.cfg);
    }
    case "tiendanube": {
      const { canLookupOrdersTn } = await import("./tn-config");
      return canLookupOrdersTn(conn.cfg);
    }
    case "shopify": {
      const { canLookupOrdersShopify } = await import("./shopify-config");
      return canLookupOrdersShopify(conn.cfg);
    }
  }
}

/** Busca productos en la tienda conectada, sea cual sea el proveedor. */
export async function searchProductsFor(
  conn: EcommerceConnection,
  query: ProductSearchQuery,
): Promise<ProductSearchResult> {
  switch (conn.provider) {
    case "woocommerce": {
      const { searchProducts } = await import("./search.service");
      return searchProducts(conn.cfg, query);
    }
    case "tiendanube": {
      const { searchProductsTn } = await import("./tn.service");
      return searchProductsTn(conn.cfg, query);
    }
    case "shopify": {
      const { searchProductsShopify } = await import("./shopify.service");
      return searchProductsShopify(conn.cfg, query);
    }
  }
}

/** Consulta el estado de un pedido en la tienda conectada. */
export async function lookupOrderFor(
  conn: EcommerceConnection,
  query: OrderLookupQuery,
  ctx: { workspaceId: string; conversationId: string },
): Promise<OrderLookupResult> {
  switch (conn.provider) {
    case "woocommerce": {
      const { lookupOrder } = await import("./lookup.service");
      return lookupOrder(conn.cfg, query, ctx);
    }
    case "tiendanube": {
      const { lookupOrderTn } = await import("./tn.service");
      return lookupOrderTn(conn.cfg, query, ctx);
    }
    case "shopify": {
      const { lookupOrderShopify } = await import("./shopify.service");
      return lookupOrderShopify(conn.cfg, query, ctx);
    }
  }
}
