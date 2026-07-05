import type { WooOrder, WooProduct } from "../types";
import type { TnWorkspaceConfig } from "./tn-config";

/**
 * Cliente mínimo de Tiendanube, mismo layout que wc-client.ts (Raw* privados
 * + normalizadores a los tipos del agente, timeouts de 6s, error class propia).
 *
 * Particularidades de la API (verificadas contra la doc oficial):
 *  - Base: https://api.tiendanube.com/v1/{store_id}
 *  - Auth: header "Authentication: bearer {token}" — así, literal (no el
 *    estándar Authorization). Se manda igual Authorization por compatibilidad
 *    con las versiones nuevas de la API.
 *  - User-Agent es OBLIGATORIO (400 si falta).
 *  - products soporta ?q= (busca en nombre, tags y SKU); orders soporta ?q=
 *    (número de orden, nombre o email del cliente — NO busca por teléfono,
 *    por eso el matching por teléfono se hace client-side sobre las últimas
 *    órdenes).
 */

export class TiendanubeError extends Error {}

const USER_AGENT = "motor-agente (soporte@agentics-ia.com)";

async function tnFetch(
  cfg: TnWorkspaceConfig,
  path: string,
  timeoutMs = 6000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://api.tiendanube.com/v1/${cfg.storeId}${path}`,
      {
        headers: {
          Authentication: `bearer ${cfg.accessToken}`,
          Authorization: `bearer ${cfg.accessToken}`,
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: ctrl.signal,
        cache: "no-store",
      },
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new TiendanubeError(`Tiendanube respondió ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── Catálogo ─────────────────────────────────────────────────────────────────

interface RawTnProduct {
  id: number;
  name: Record<string, string> | string;
  description?: Record<string, string> | string;
  handle?: Record<string, string> | string;
  canonical_url?: string;
  published?: boolean;
  variants?: Array<{
    price?: string | null;
    stock?: number | null;
    stock_management?: boolean;
  }>;
  categories?: Array<{ name: Record<string, string> | string }>;
}

/** Los campos multi-idioma de TN vienen como { es: "...", pt: "..." } o string. */
function pickLang(value: Record<string, string> | string | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.es ?? Object.values(value)[0] ?? "";
}

/** Quita tags HTML y normaliza espacios (las descripciones de TN vienen en HTML). */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toProduct(raw: RawTnProduct, cfg: TnWorkspaceConfig): WooProduct {
  const variants = raw.variants ?? [];
  const prices = variants
    .map((v) => Number(v.price))
    .filter((p) => Number.isFinite(p) && p > 0);
  const price = prices.length ? String(Math.min(...prices)) : "";
  // stock null = infinito; stock_management false = no se controla stock.
  const inStock =
    variants.length === 0 ||
    variants.some(
      (v) =>
        v.stock_management === false || v.stock === null || (v.stock ?? 0) > 0,
    );
  const handle = pickLang(raw.handle);
  const permalink =
    raw.canonical_url ??
    (cfg.storeUrl && handle ? `${cfg.storeUrl}/productos/${handle}/` : "");
  return {
    id: raw.id,
    name: pickLang(raw.name),
    price,
    inStock,
    permalink,
    shortDescription: stripHtml(pickLang(raw.description)).slice(0, 300),
    categories: (raw.categories ?? []).map((c) => pickLang(c.name)),
  };
}

/** Busca productos publicados por término (?q= busca en nombre, tags y SKU). */
export async function searchProductsByTermTn(
  cfg: TnWorkspaceConfig,
  term: string,
  limit: number,
): Promise<WooProduct[]> {
  const q = encodeURIComponent(term);
  const raw = (await tnFetch(
    cfg,
    `/products?q=${q}&published=true&per_page=${limit}`,
  )) as RawTnProduct[] | null;
  return (raw ?? []).map((p) => toProduct(p, cfg));
}

// ── Pedidos ──────────────────────────────────────────────────────────────────

interface RawTnOrder {
  id: number;
  number: number;
  status: string; // open | closed | cancelled
  payment_status?: string; // pending | authorized | paid | abandoned | refunded | voided
  shipping_status?: string; // unpacked | unfulfilled | fulfilled
  total?: string;
  currency?: string;
  created_at?: string;
  gateway_name?: string;
  customer?: { phone?: string | null; email?: string | null };
  products?: Array<{ name: string; quantity: number | string }>;
}

/** Orden de TN normalizada: WooOrder + teléfono del cliente para el matching. */
export interface TnOrder extends WooOrder {
  customerPhone: string | null;
}

function toOrder(raw: RawTnOrder): TnOrder {
  return {
    // id visible para el cliente = número de orden (el id interno no lo conoce).
    id: raw.number,
    // slug compuesto: el mapeo de estados de TN usa payment/shipping/status.
    status: tnStatusSlug(raw),
    total: raw.total ?? "0",
    currency: raw.currency ?? "ARS",
    dateCreated: raw.created_at ?? "",
    paymentMethodTitle: raw.gateway_name,
    items: (raw.products ?? []).map((p) => ({
      name: p.name,
      qty: Number(p.quantity) || 0,
    })),
    customerPhone: raw.customer?.phone ?? null,
  };
}

/**
 * Reduce el triplete status/payment_status/shipping_status de TN a un slug
 * único, en orden de relevancia para el cliente final.
 */
export function tnStatusSlug(raw: {
  status: string;
  payment_status?: string;
  shipping_status?: string;
}): string {
  if (raw.status === "cancelled") return "cancelled";
  if (raw.shipping_status === "fulfilled") return "fulfilled";
  if (raw.payment_status === "paid") return "paid";
  return raw.payment_status || raw.status || "open";
}

/** Busca una orden por su número (?q= matchea el número de orden exacto). */
export async function getOrderByNumberTn(
  cfg: TnWorkspaceConfig,
  orderNumber: number,
): Promise<TnOrder | null> {
  const raw = (await tnFetch(
    cfg,
    `/orders?q=${orderNumber}&per_page=5`,
  )) as RawTnOrder[] | null;
  const hit = (raw ?? []).find((o) => o.number === orderNumber);
  return hit ? toOrder(hit) : null;
}

/**
 * Matching por teléfono: la API de TN no busca órdenes por teléfono, así que
 * se traen las últimas órdenes y se comparan los dígitos del customer.phone
 * contra las variantes AR (nacional 10 dígitos, E.164, etc). Devuelve la más
 * reciente que matchee alguna variante.
 */
export async function findOrderByPhoneTn(
  cfg: TnWorkspaceConfig,
  phoneVariants: string[],
): Promise<TnOrder | null> {
  if (phoneVariants.length === 0) return null;
  const raw = (await tnFetch(
    cfg,
    `/orders?per_page=50&sort_by=created-at-descending`,
  )) as RawTnOrder[] | null;
  const variants = phoneVariants
    .map((v) => v.replace(/\D/g, ""))
    .filter((v) => v.length >= 8);
  for (const order of raw ?? []) {
    const digits = (order.customer?.phone ?? "").replace(/\D/g, "");
    if (digits.length < 8) continue;
    const match = variants.some(
      (v) => digits === v || digits.endsWith(v) || v.endsWith(digits),
    );
    if (match) return toOrder(order);
  }
  return null;
}

// ── Health check ─────────────────────────────────────────────────────────────

/**
 * Chequeo de salud, mismo contrato que pingWooCommerce: 1 producto (catálogo)
 * y 1 orden (pedidos). En TN ambos usan el mismo token, pero se prueban por
 * separado porque los scopes pueden diferir (read_products vs read_orders).
 */
export async function pingTiendanube(cfg: TnWorkspaceConfig): Promise<{
  ok: boolean;
  storeOk: boolean;
  ordersOk: boolean | null;
  latencyMs: number | null;
  error?: string;
}> {
  const start = Date.now();
  let storeOk = false;
  let ordersOk: boolean | null = null;
  let error: string | undefined;

  try {
    await tnFetch(cfg, `/products?per_page=1`, 5000);
    storeOk = true;
  } catch (e) {
    error = e instanceof Error ? e.message : "error desconocido (productos)";
  }

  try {
    await tnFetch(cfg, `/orders?per_page=1`, 5000);
    ordersOk = true;
  } catch (e) {
    ordersOk = false;
    error =
      error ?? (e instanceof Error ? e.message : "error desconocido (pedidos)");
  }

  const ok = storeOk && ordersOk !== false;
  return {
    ok,
    storeOk,
    ordersOk,
    latencyMs: ok ? Date.now() - start : null,
    ...(error && !ok ? { error } : {}),
  };
}
