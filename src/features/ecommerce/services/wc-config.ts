import { createClient as createSbClient } from "@supabase/supabase-js";
import type { StatusMessage } from "../types";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * Config de WooCommerce por workspace, leída de la tabla integrations
 * (provider = 'woocommerce'), mismo patrón que YCloud/HighLevel.
 *
 * credentials: { wc_consumer_key, wc_consumer_secret }  → solo para PEDIDOS
 *              (REST v3 autenticada). El catálogo usa la Store API pública.
 * config:      { store_url, search_stopwords?, status_messages?,
 *                cart_webhook_secret? }
 */
export interface WcWorkspaceConfig {
  /** URL base de la tienda, sin barra final. Siempre https. */
  storeUrl: string;
  consumerKey: string | null;
  consumerSecret: string | null;
  /** Stopwords extra del rubro (se suman a las base del motor). */
  extraStopwords: string[];
  /** Mensajes de estado custom que pisan/extienden el mapa default. */
  statusMessages: Record<string, StatusMessage> | null;
  /** Secret del webhook de carritos abandonados (header X-Webhook-Secret). */
  cartWebhookSecret: string | null;
}

/** True cuando hay credenciales REST v3 para consultar pedidos. */
export function canLookupOrders(cfg: WcWorkspaceConfig): boolean {
  return Boolean(
    cfg.consumerKey &&
      cfg.consumerSecret &&
      !cfg.consumerKey.includes("PENDIENTE"),
  );
}

/**
 * Devuelve la config de WooCommerce del workspace, o null si la integración
 * no existe, está deshabilitada o la store_url es inválida (exige https).
 */
export async function getWcConfig(
  workspaceId: string,
): Promise<WcWorkspaceConfig | null> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "woocommerce")
    .eq("enabled", true)
    .maybeSingle();

  if (error || !data) return null;

  const credentials =
    (data.credentials as Record<string, unknown> | null) ?? {};
  const config = (data.config as Record<string, unknown> | null) ?? {};

  const rawUrl = typeof config.store_url === "string" ? config.store_url : "";
  const storeUrl = rawUrl.trim().replace(/\/$/, "");
  if (!/^https:\/\//i.test(storeUrl)) return null;

  const extraStopwords = Array.isArray(config.search_stopwords)
    ? (config.search_stopwords as unknown[]).filter(
        (w): w is string => typeof w === "string",
      )
    : [];

  const statusMessages =
    config.status_messages && typeof config.status_messages === "object"
      ? (config.status_messages as Record<string, StatusMessage>)
      : null;

  return {
    storeUrl,
    consumerKey:
      typeof credentials.wc_consumer_key === "string"
        ? credentials.wc_consumer_key
        : null,
    consumerSecret:
      typeof credentials.wc_consumer_secret === "string"
        ? credentials.wc_consumer_secret
        : null,
    extraStopwords,
    statusMessages,
    cartWebhookSecret:
      typeof config.cart_webhook_secret === "string" &&
      config.cart_webhook_secret.length > 0
        ? config.cart_webhook_secret
        : null,
  };
}
