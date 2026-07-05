import { createClient as createSbClient } from "@supabase/supabase-js";
import type { StatusMessage } from "../types";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * Config de Tiendanube por workspace, leída de la tabla integrations
 * (provider = 'tiendanube'), mismo patrón que WooCommerce (wc-config.ts).
 *
 * credentials: { tn_access_token }  → token manual del operador (custom app;
 *              el OAuth de app pública queda para más adelante).
 * config:      { store_id, store_url?, search_stopwords?, status_messages? }
 *
 * A diferencia de WooCommerce, TODA la API de Tiendanube requiere token
 * (no hay catálogo público), así que sin token la integración no sirve.
 */
export interface TnWorkspaceConfig {
  /** ID numérico de la tienda (va en la URL base de la API). */
  storeId: string;
  accessToken: string;
  /** URL pública de la tienda (para armar links si el producto no trae canonical_url). */
  storeUrl: string | null;
  extraStopwords: string[];
  statusMessages: Record<string, StatusMessage> | null;
}

/** True cuando el token permite consultar pedidos (misma convención "PENDIENTE" que WC). */
export function canLookupOrdersTn(cfg: TnWorkspaceConfig): boolean {
  return Boolean(cfg.accessToken && !cfg.accessToken.includes("PENDIENTE"));
}

/**
 * Devuelve la config de Tiendanube del workspace, o null si la integración
 * no existe, está deshabilitada o le faltan store_id / access token.
 */
export async function getTnConfig(
  workspaceId: string,
): Promise<TnWorkspaceConfig | null> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "tiendanube")
    .eq("enabled", true)
    .maybeSingle();

  if (error || !data) return null;

  const credentials =
    (data.credentials as Record<string, unknown> | null) ?? {};
  const config = (data.config as Record<string, unknown> | null) ?? {};

  const storeId =
    typeof config.store_id === "string" || typeof config.store_id === "number"
      ? String(config.store_id).trim()
      : "";
  if (!/^\d+$/.test(storeId)) return null;

  const accessToken =
    typeof credentials.tn_access_token === "string"
      ? credentials.tn_access_token.trim()
      : "";
  if (!accessToken) return null;

  const rawUrl = typeof config.store_url === "string" ? config.store_url : "";
  const storeUrl = rawUrl.trim().replace(/\/$/, "");

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
    storeId,
    accessToken,
    storeUrl: /^https:\/\//i.test(storeUrl) ? storeUrl : null,
    extraStopwords,
    statusMessages,
  };
}
