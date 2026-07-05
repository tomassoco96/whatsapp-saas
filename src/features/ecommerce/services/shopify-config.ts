import { createClient as createSbClient } from "@supabase/supabase-js";
import type { StatusMessage } from "../types";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * Config de Shopify por workspace, leída de la tabla integrations
 * (provider = 'shopify'), mismo patrón que WooCommerce (wc-config.ts).
 *
 * credentials: { shopify_access_token }  → Admin API access token de una
 *              custom app (shpat_...), header X-Shopify-Access-Token.
 * config:      { shop_domain, search_stopwords?, status_messages? }
 */
export interface ShopifyWorkspaceConfig {
  /** Dominio myshopify de la tienda, ej "mitienda.myshopify.com" (sin https://). */
  shopDomain: string;
  accessToken: string;
  extraStopwords: string[];
  statusMessages: Record<string, StatusMessage> | null;
}

/** True cuando el token permite consultar pedidos (misma convención "PENDIENTE" que WC). */
export function canLookupOrdersShopify(cfg: ShopifyWorkspaceConfig): boolean {
  return Boolean(cfg.accessToken && !cfg.accessToken.includes("PENDIENTE"));
}

/** Normaliza el dominio: saca https://, barra final y valida *.myshopify.com. */
export function normalizeShopDomain(raw: string): string | null {
  const domain = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
}

/**
 * Devuelve la config de Shopify del workspace, o null si la integración no
 * existe, está deshabilitada o le faltan shop_domain / access token.
 */
export async function getShopifyConfig(
  workspaceId: string,
): Promise<ShopifyWorkspaceConfig | null> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "shopify")
    .eq("enabled", true)
    .maybeSingle();

  if (error || !data) return null;

  const credentials =
    (data.credentials as Record<string, unknown> | null) ?? {};
  const config = (data.config as Record<string, unknown> | null) ?? {};

  const shopDomain = normalizeShopDomain(
    typeof config.shop_domain === "string" ? config.shop_domain : "",
  );
  if (!shopDomain) return null;

  const accessToken =
    typeof credentials.shopify_access_token === "string"
      ? credentials.shopify_access_token.trim()
      : "";
  if (!accessToken) return null;

  const extraStopwords = Array.isArray(config.search_stopwords)
    ? (config.search_stopwords as unknown[]).filter(
        (w): w is string => typeof w === "string",
      )
    : [];

  const statusMessages =
    config.status_messages && typeof config.status_messages === "object"
      ? (config.status_messages as Record<string, StatusMessage>)
      : null;

  return { shopDomain, accessToken, extraStopwords, statusMessages };
}
