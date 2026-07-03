import type { WooOrder, WooProduct, WooCategory, WooSize } from "../types";
import type { WcWorkspaceConfig } from "./wc-config";

/**
 * Cliente mínimo de WooCommerce, portado del motor v1 y parametrizado por
 * workspace (multi-tenant): recibe la config en vez de leer env vars.
 *
 * - PEDIDOS: REST API v3 autenticada (HTTP Basic con consumer key/secret).
 * - CATÁLOGO: Store API pública /wp-json/wc/store/v1 (sin auth) — es info
 *   pública; las keys solo se usan para pedidos.
 */

export class WooCommerceError extends Error {}

function basicAuth(cfg: WcWorkspaceConfig): string {
  if (!cfg.consumerKey || !cfg.consumerSecret) {
    throw new WooCommerceError(
      "WooCommerce no configurado (faltan consumer key/secret)",
    );
  }
  return Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString(
    "base64",
  );
}

async function wcFetch(
  cfg: WcWorkspaceConfig,
  path: string,
  timeoutMs = 6000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.storeUrl}/wp-json/wc/v3${path}`, {
      headers: {
        Authorization: `Basic ${basicAuth(cfg)}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new WooCommerceError(`WooCommerce respondió ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

interface RawWooOrder {
  id: number;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  payment_method_title?: string;
  line_items?: Array<{ name: string; quantity: number }>;
}

function toWooOrder(raw: RawWooOrder): WooOrder {
  return {
    id: raw.id,
    status: raw.status,
    total: raw.total,
    currency: raw.currency,
    dateCreated: raw.date_created,
    paymentMethodTitle: raw.payment_method_title,
    items: (raw.line_items ?? []).map((i) => ({
      name: i.name,
      qty: i.quantity,
    })),
  };
}

/** Busca una orden por su ID. Devuelve null si no existe. */
export async function getOrderById(
  cfg: WcWorkspaceConfig,
  id: number,
): Promise<WooOrder | null> {
  const raw = (await wcFetch(cfg, `/orders/${id}`)) as RawWooOrder | null;
  return raw ? toWooOrder(raw) : null;
}

/**
 * Busca órdenes por teléfono (parámetro `search` de WC) y devuelve la más
 * reciente. La búsqueda es imperfecta — si hay varias, prioriza la última.
 */
export async function searchOrderByPhone(
  cfg: WcWorkspaceConfig,
  phone: string,
): Promise<WooOrder | null> {
  const q = encodeURIComponent(phone);
  const raw = (await wcFetch(
    cfg,
    `/orders?search=${q}&per_page=5&orderby=date&order=desc`,
  )) as RawWooOrder[] | null;
  if (!raw || raw.length === 0) return null;
  return toWooOrder(raw[0]);
}

// ── Catálogo — vía Store API PÚBLICA (no requiere consumer keys) ─────────────

async function storeFetch(
  cfg: WcWorkspaceConfig,
  path: string,
  timeoutMs = 6000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.storeUrl}/wp-json/wc/store/v1${path}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new WooCommerceError(`Store API respondió ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

interface RawStoreProduct {
  id: number;
  name: string;
  permalink: string;
  short_description?: string;
  is_in_stock: boolean;
  prices?: { price?: string; currency_minor_unit?: number };
  categories?: Array<{ name: string }>;
  attributes?: Array<{ name?: string; terms?: Array<{ name: string }> }>;
}

/** Quita tags HTML y normaliza espacios (las descripciones de WC vienen en HTML). */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** La Store API da el precio en unidades menores (ej. "1400000" con minor_unit 2 = 14000). */
function formatStorePrice(prices?: RawStoreProduct["prices"]): string {
  if (!prices?.price) return "";
  const minor = prices.currency_minor_unit ?? 2;
  return String(Math.round(Number(prices.price) / 10 ** minor));
}

function toWooProductFromStore(raw: RawStoreProduct): WooProduct {
  const price = formatStorePrice(raw.prices);
  // talles: atributo cuyo nombre matchea talle/size + sus `terms`.
  const talleAttr = (raw.attributes ?? []).find(
    (a) => /tama|size|talle/i.test(a.name ?? "") && (a.terms?.length ?? 0) > 0,
  );
  const sizes: WooSize[] | undefined = talleAttr?.terms
    ? talleAttr.terms.map((term) => ({ label: term.name, price }))
    : undefined;
  return {
    id: raw.id,
    name: raw.name,
    price,
    inStock: raw.is_in_stock,
    permalink: raw.permalink,
    shortDescription: stripHtml(raw.short_description ?? ""),
    categories: (raw.categories ?? []).map((c) => c.name),
    ...(sizes && sizes.length ? { sizes } : {}),
  };
}

/** Busca productos por palabra clave (parámetro `search` de la Store API). */
export async function searchProductsByTerm(
  cfg: WcWorkspaceConfig,
  term: string,
  limit: number,
): Promise<WooProduct[]> {
  const q = encodeURIComponent(term);
  const raw = (await storeFetch(
    cfg,
    `/products?search=${q}&per_page=${limit}`,
  )) as RawStoreProduct[] | null;
  return (raw ?? []).map(toWooProductFromStore);
}

/** Busca un producto por su slug (el último segmento del link `/producto/<slug>/`). */
export async function getProductsBySlug(
  cfg: WcWorkspaceConfig,
  slug: string,
): Promise<WooProduct[]> {
  const q = encodeURIComponent(slug);
  const raw = (await storeFetch(cfg, `/products?slug=${q}`)) as
    | RawStoreProduct[]
    | null;
  return (raw ?? []).map(toWooProductFromStore);
}

interface RawStoreCategory {
  id: number;
  name: string;
  slug: string;
  count: number;
}

function toWooCategory(raw: RawStoreCategory): WooCategory {
  return { id: raw.id, name: raw.name, slug: raw.slug, count: raw.count };
}

/** Resuelve una categoría por su slug exacto. Devuelve null si no existe. */
export async function getCategoryBySlug(
  cfg: WcWorkspaceConfig,
  slug: string,
): Promise<WooCategory | null> {
  const q = encodeURIComponent(slug);
  const raw = (await storeFetch(cfg, `/products/categories?slug=${q}`)) as
    | RawStoreCategory[]
    | null;
  // Si el endpoint no filtra por slug, filtramos client-side.
  const found = (raw ?? []).find((c) => c.slug === slug) ?? null;
  return found ? toWooCategory(found) : null;
}

/**
 * Busca categorías por nombre. La Store API no tiene `search` en categorías,
 * así que traemos hasta 100 y filtramos por nombre; orden por count desc.
 */
export async function searchCategoriesByName(
  cfg: WcWorkspaceConfig,
  term: string,
): Promise<WooCategory[]> {
  const raw = (await storeFetch(cfg, `/products/categories?per_page=100`)) as
    | RawStoreCategory[]
    | null;
  const t = term.toLowerCase();
  return (raw ?? [])
    .filter((c) => c.name.toLowerCase().includes(t))
    .sort((a, b) => b.count - a.count)
    .map(toWooCategory);
}

/** Productos de una categoría por su id. */
export async function getProductsByCategoryId(
  cfg: WcWorkspaceConfig,
  id: number,
  limit: number,
): Promise<WooProduct[]> {
  const raw = (await storeFetch(
    cfg,
    `/products?category=${id}&per_page=${limit}`,
  )) as RawStoreProduct[] | null;
  return (raw ?? []).map(toWooProductFromStore);
}
