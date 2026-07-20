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
  billing?: { phone?: string; email?: string };
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
    // Solo para el chequeo de propiedad (nunca se muestran al cliente).
    billingPhone: raw.billing?.phone,
    billingEmail: raw.billing?.email,
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

// ── REST v3 fallback para catálogo (cuando Store API está rota por plugins) ──
// Incluye `price` (el precio de venta al público, minorista) y `type`, pero NO
// `sale_price` ni `on_sale`: esos dos son los únicos que crashean el plugin de
// pricing dinámico de la tienda (verificado campo por campo). El precio que
// devuelve REST v3 ya viene en pesos enteros como string ("154599"), a
// diferencia de la Store API que lo da en unidades menores.
const REST_V3_SAFE_FIELDS =
  "id,name,slug,permalink,price,stock_status,short_description,categories,type,attributes";

interface RawRestProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  price?: string;
  short_description?: string;
  stock_status: "instock" | "outofstock" | "onbackorder";
  categories?: Array<{ id: number; name: string; slug: string }>;
  /** "simple" | "variable" | "grouped" | "external". */
  type?: string;
  /** REST v3: cada atributo trae sus valores en `options`. */
  attributes?: Array<{ name?: string; options?: string[] }>;
}

/** Marca del producto desde el atributo "Marca" (REST v3: options[0]). */
function brandFromRestAttrs(
  attrs?: Array<{ name?: string; options?: string[] }>,
): string | undefined {
  const marca = (attrs ?? []).find((a) => /marca/i.test(a.name ?? ""));
  return marca?.options?.[0];
}

function toWooProductFromRest(raw: RawRestProduct): WooProduct {
  const brand = brandFromRestAttrs(raw.attributes);
  return {
    id: raw.id,
    name: stripHtml(raw.name),
    // Para un producto variable, `price` es el precio de la variante más barata
    // → se muestra como "desde $X" (ver priceFrom).
    price: raw.price ?? "",
    priceFrom: raw.type === "variable",
    inStock: raw.stock_status === "instock",
    permalink: raw.permalink,
    shortDescription: stripHtml(raw.short_description ?? ""),
    categories: (raw.categories ?? []).map((c) => c.name),
    ...(brand ? { brand } : {}),
  };
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
  // marca: atributo "Marca" (Store API expone los valores en `terms`).
  const marcaAttr = (raw.attributes ?? []).find((a) =>
    /marca/i.test(a.name ?? ""),
  );
  const brand = marcaAttr?.terms?.[0]?.name;
  return {
    id: raw.id,
    name: raw.name,
    price,
    inStock: raw.is_in_stock,
    permalink: raw.permalink,
    shortDescription: stripHtml(raw.short_description ?? ""),
    categories: (raw.categories ?? []).map((c) => c.name),
    ...(brand ? { brand } : {}),
    ...(sizes && sizes.length ? { sizes } : {}),
  };
}

/** Busca productos por palabra clave. Store API primero; si falla, REST v3 (con precio). */
export async function searchProductsByTerm(
  cfg: WcWorkspaceConfig,
  term: string,
  limit: number,
): Promise<WooProduct[]> {
  const q = encodeURIComponent(term);
  try {
    const raw = (await storeFetch(
      cfg,
      `/products?search=${q}&per_page=${limit}`,
    )) as RawStoreProduct[] | null;
    return (raw ?? []).map(toWooProductFromStore);
  } catch {
    if (cfg.consumerKey && cfg.consumerSecret) {
      const raw = (await wcFetch(
        cfg,
        `/products?search=${q}&per_page=${limit}&_fields=${REST_V3_SAFE_FIELDS}`,
      )) as RawRestProduct[] | null;
      return (raw ?? []).map(toWooProductFromRest);
    }
    throw new WooCommerceError("Store API no disponible y sin credenciales REST v3");
  }
}

/** Busca un producto por su slug. Store API primero; si falla, REST v3 (con precio). */
export async function getProductsBySlug(
  cfg: WcWorkspaceConfig,
  slug: string,
): Promise<WooProduct[]> {
  const q = encodeURIComponent(slug);
  try {
    const raw = (await storeFetch(cfg, `/products?slug=${q}`)) as
      | RawStoreProduct[]
      | null;
    return (raw ?? []).map(toWooProductFromStore);
  } catch {
    if (cfg.consumerKey && cfg.consumerSecret) {
      const raw = (await wcFetch(
        cfg,
        `/products?slug=${q}&_fields=${REST_V3_SAFE_FIELDS}`,
      )) as RawRestProduct[] | null;
      return (raw ?? []).map(toWooProductFromRest);
    }
    throw new WooCommerceError("Store API no disponible y sin credenciales REST v3");
  }
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

/**
 * Chequeo de salud (portado del v1): pide 1 producto a la Store API pública
 * y, si hay credenciales REST, 1 orden a la API autenticada. No lanza:
 * cualquier fallo se reporta como ok:false con el detalle.
 */
export async function pingWooCommerce(cfg: WcWorkspaceConfig): Promise<{
  ok: boolean;
  storeOk: boolean;
  ordersOk: boolean | null; // null = sin credenciales para probar
  latencyMs: number | null;
  error?: string;
}> {
  const start = Date.now();
  let storeOk = false;
  let ordersOk: boolean | null = null;
  let error: string | undefined;

  try {
    await storeFetch(cfg, `/products?per_page=1`, 5000);
    storeOk = true;
  } catch {
    // Store API broken (e.g. pricing plugin crash) — try REST v3 products
    if (cfg.consumerKey && cfg.consumerSecret) {
      try {
        await wcFetch(cfg, `/products?per_page=1&_fields=${REST_V3_SAFE_FIELDS}`, 5000);
        storeOk = true; // REST v3 fallback works
      } catch (e2) {
        error = e2 instanceof Error ? e2.message : "error desconocido (catálogo)";
      }
    } else {
      error = "Store API no disponible y sin credenciales REST v3";
    }
  }

  if (cfg.consumerKey && cfg.consumerSecret) {
    try {
      await wcFetch(cfg, `/orders?per_page=1`, 5000);
      ordersOk = true;
    } catch (e) {
      ordersOk = false;
      error =
        error ??
        (e instanceof Error ? e.message : "error desconocido (REST v3)");
    }
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

/** Productos de una categoría por su id. Store API primero; si falla, REST v3 (con precio). */
export async function getProductsByCategoryId(
  cfg: WcWorkspaceConfig,
  id: number,
  limit: number,
): Promise<WooProduct[]> {
  try {
    const raw = (await storeFetch(
      cfg,
      `/products?category=${id}&per_page=${limit}`,
    )) as RawStoreProduct[] | null;
    return (raw ?? []).map(toWooProductFromStore);
  } catch {
    if (cfg.consumerKey && cfg.consumerSecret) {
      const raw = (await wcFetch(
        cfg,
        `/products?category=${id}&per_page=${limit}&_fields=${REST_V3_SAFE_FIELDS}`,
      )) as RawRestProduct[] | null;
      return (raw ?? []).map(toWooProductFromRest);
    }
    throw new WooCommerceError("Store API no disponible y sin credenciales REST v3");
  }
}
