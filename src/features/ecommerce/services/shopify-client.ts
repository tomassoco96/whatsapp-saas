import type { WooOrder, WooProduct } from "../types";
import type { ShopifyWorkspaceConfig } from "./shopify-config";

/**
 * Cliente mínimo de Shopify sobre la Admin API GraphQL (los endpoints REST de
 * productos están deprecados desde 2024-04, y GraphQL cubre productos,
 * clientes y órdenes con un solo transporte). Mismo layout que wc-client.ts:
 * Raw* privados + normalizadores a los tipos del agente, timeouts de 6s,
 * error class propia.
 *
 * Auth: header X-Shopify-Access-Token (Admin API token de custom app).
 * Búsqueda de órdenes por teléfono: la query de orders NO filtra por phone —
 * se resuelve vía customers(query: "phone:...") → orders(query: "customer_id:...").
 */

export class ShopifyError extends Error {}

const API_VERSION = "2025-07";

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

async function shopifyGraphql(
  cfg: ShopifyWorkspaceConfig,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = 6000,
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://${cfg.shopDomain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": cfg.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
        cache: "no-store",
      },
    );
    if (!res.ok) throw new ShopifyError(`Shopify respondió ${res.status}`);
    const json = (await res.json()) as GraphqlResponse;
    if (json.errors?.length) {
      throw new ShopifyError(`Shopify GraphQL: ${json.errors[0].message}`);
    }
    return json.data ?? {};
  } finally {
    clearTimeout(t);
  }
}

interface Edges<T> {
  edges?: Array<{ node: T }>;
}

function nodes<T>(conn: unknown): T[] {
  return ((conn as Edges<T> | undefined)?.edges ?? []).map((e) => e.node);
}

/** Escapa comillas para interpolar valores en la search syntax de Shopify. */
function q(value: string): string {
  return `"${value.replace(/["\\]/g, " ").trim()}"`;
}

// ── Catálogo ─────────────────────────────────────────────────────────────────

interface RawShopifyProduct {
  legacyResourceId: string;
  title: string;
  handle: string;
  onlineStoreUrl?: string | null;
  description?: string;
  productType?: string;
  totalInventory?: number | null;
  tracksInventory?: boolean;
  priceRangeV2?: { minVariantPrice?: { amount?: string } };
}

const PRODUCTS_QUERY = `
query BuscarProductos($q: String!, $n: Int!) {
  products(first: $n, query: $q) {
    edges { node {
      legacyResourceId title handle onlineStoreUrl
      description(truncateAt: 300) productType
      totalInventory tracksInventory
      priceRangeV2 { minVariantPrice { amount } }
    } }
  }
}`;

function toProduct(
  raw: RawShopifyProduct,
  cfg: ShopifyWorkspaceConfig,
): WooProduct {
  const amount = raw.priceRangeV2?.minVariantPrice?.amount ?? "";
  // "1500.0" → "1500"; deja los decimales solo si son significativos.
  const price = amount ? String(Number(amount)) : "";
  const inStock = raw.tracksInventory === false || (raw.totalInventory ?? 0) > 0;
  return {
    id: Number(raw.legacyResourceId) || 0,
    name: raw.title,
    price,
    inStock,
    permalink:
      raw.onlineStoreUrl ?? `https://${cfg.shopDomain}/products/${raw.handle}`,
    shortDescription: raw.description ?? "",
    categories: raw.productType ? [raw.productType] : [],
  };
}

/** Busca productos activos por término (title con wildcard de la search syntax). */
export async function searchProductsByTermShopify(
  cfg: ShopifyWorkspaceConfig,
  term: string,
  limit: number,
): Promise<WooProduct[]> {
  const clean = term.replace(/["\\*]/g, " ").trim();
  const data = await shopifyGraphql(cfg, PRODUCTS_QUERY, {
    q: `title:*${clean}* AND status:active`,
    n: limit,
  });
  return nodes<RawShopifyProduct>(data.products).map((p) => toProduct(p, cfg));
}

// ── Pedidos ──────────────────────────────────────────────────────────────────

interface RawShopifyOrder {
  legacyResourceId: string;
  name: string; // "#1001"
  createdAt: string;
  displayFinancialStatus?: string | null; // PENDING | PAID | REFUNDED | ...
  displayFulfillmentStatus?: string | null; // UNFULFILLED | FULFILLED | ...
  totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
  lineItems?: Edges<{ title: string; quantity: number }>;
}

const ORDER_FIELDS = `
  legacyResourceId name createdAt
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 10) { edges { node { title quantity } } }
`;

const ORDERS_QUERY = `
query BuscarOrdenes($q: String!) {
  orders(first: 1, query: $q, sortKey: CREATED_AT, reverse: true) {
    edges { node { ${ORDER_FIELDS} } }
  }
}`;

/**
 * Reduce financial/fulfillment status a un slug único (minúscula), en orden
 * de relevancia para el cliente final. Exportado para el mapa de estados.
 */
export function shopifyStatusSlug(raw: {
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
}): string {
  const fulfillment = (raw.displayFulfillmentStatus ?? "").toLowerCase();
  const financial = (raw.displayFinancialStatus ?? "").toLowerCase();
  if (fulfillment === "fulfilled") return "fulfilled";
  if (financial) return financial;
  return fulfillment || "pending";
}

function toOrder(raw: RawShopifyOrder): WooOrder {
  // El cliente conoce el número de orden ("#1001"), no el id interno.
  const num = Number(raw.name.replace(/\D/g, ""));
  return {
    id: num || Number(raw.legacyResourceId) || 0,
    status: shopifyStatusSlug(raw),
    total: raw.totalPriceSet?.shopMoney?.amount ?? "0",
    currency: raw.totalPriceSet?.shopMoney?.currencyCode ?? "ARS",
    dateCreated: raw.createdAt,
    items: nodes<{ title: string; quantity: number }>(raw.lineItems).map(
      (i) => ({ name: i.title, qty: i.quantity }),
    ),
  };
}

/** Busca una orden por su número visible (name "#1001"). */
export async function getOrderByNumberShopify(
  cfg: ShopifyWorkspaceConfig,
  orderNumber: number,
): Promise<WooOrder | null> {
  const data = await shopifyGraphql(cfg, ORDERS_QUERY, {
    q: `name:${q(`#${orderNumber}`)}`,
  });
  const raw = nodes<RawShopifyOrder>(data.orders)[0];
  return raw ? toOrder(raw) : null;
}

const CUSTOMERS_QUERY = `
query BuscarClientes($q: String!) {
  customers(first: 3, query: $q) {
    edges { node { legacyResourceId } }
  }
}`;

/**
 * Busca la orden más reciente de un cliente por teléfono: la search syntax de
 * orders no soporta phone, así que va customers(phone:...) → orders(customer_id:...).
 */
export async function searchOrderByPhoneShopify(
  cfg: ShopifyWorkspaceConfig,
  phone: string,
): Promise<WooOrder | null> {
  const customersData = await shopifyGraphql(cfg, CUSTOMERS_QUERY, {
    q: `phone:${q(phone)}`,
  });
  const customers = nodes<{ legacyResourceId: string }>(
    customersData.customers,
  );
  for (const customer of customers) {
    const data = await shopifyGraphql(cfg, ORDERS_QUERY, {
      q: `customer_id:${customer.legacyResourceId} AND status:any`,
    });
    const raw = nodes<RawShopifyOrder>(data.orders)[0];
    if (raw) return toOrder(raw);
  }
  return null;
}

// ── Health check ─────────────────────────────────────────────────────────────

/**
 * Chequeo de salud, mismo contrato que pingWooCommerce: 1 producto (catálogo)
 * y 1 orden (pedidos). Los scopes read_products y read_orders se prueban por
 * separado — un token puede tener uno solo.
 */
export async function pingShopify(cfg: ShopifyWorkspaceConfig): Promise<{
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
    await shopifyGraphql(
      cfg,
      `query Ping($n: Int!) { products(first: $n) { edges { node { handle } } } }`,
      { n: 1 },
      5000,
    );
    storeOk = true;
  } catch (e) {
    error = e instanceof Error ? e.message : "error desconocido (productos)";
  }

  try {
    await shopifyGraphql(
      cfg,
      `query Ping($n: Int!) { orders(first: $n) { edges { node { name } } } }`,
      { n: 1 },
      5000,
    );
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
