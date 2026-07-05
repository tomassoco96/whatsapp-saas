import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  searchProductsByTermShopify,
  getOrderByNumberShopify,
  searchOrderByPhoneShopify,
} from "./shopify-client";
import {
  canLookupOrdersShopify,
  type ShopifyWorkspaceConfig,
} from "./shopify-config";
import { buildSearchAttempts, type ProductSearchQuery } from "./search.service";
import { argentinePhoneSearchVariants } from "../lib/phone";
import { normalizeStatus } from "../lib/status-map";
import { sanitizeText } from "../lib/sanitize";
import type {
  WooProduct,
  ProductSearchResult,
  OrderLookupResult,
  StatusMessage,
} from "../types";
import type { OrderLookupQuery } from "./lookup.service";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const NAME_MAX = 120;
const DESC_MAX = 200;

const DERIVATION_MSG =
  "No puedo verificarlo en este momento, ya te derivo con alguien del equipo para que te ayude.";

/**
 * Estados de Shopify → lenguaje del cliente. Claves = slug que produce
 * shopifyStatusSlug() (fulfilled / paid / pending / refunded / ...). El
 * workspace los pisa o extiende vía `status_messages` en la config.
 */
const SHOPIFY_STATUS_MAP: Record<string, StatusMessage> = {
  pending: {
    label: "Pendiente de pago",
    customerMsg:
      "todavía figura sin pagar. Si querés lo destrabamos juntos, decime con qué método ibas a pagar.",
  },
  authorized: {
    label: "Pago autorizado",
    customerMsg:
      "el pago está autorizado y en proceso de confirmación. Apenas se acredite arrancamos con tu pedido.",
  },
  paid: {
    label: "Pago confirmado",
    customerMsg: "el pago ya está confirmado y el pedido está en preparación.",
  },
  partially_paid: {
    label: "Pago parcial",
    customerMsg:
      "figura un pago parcial. Decime y lo revisamos juntos para completarlo.",
  },
  fulfilled: {
    label: "Enviado",
    customerMsg:
      "ya fue despachado. El seguimiento del envío te llega por mail.",
  },
  refunded: {
    label: "Reembolsado",
    customerMsg: "se procesó un reembolso de este pedido.",
  },
  partially_refunded: {
    label: "Reembolso parcial",
    customerMsg: "se procesó un reembolso parcial de este pedido.",
  },
  voided: {
    label: "Pago anulado",
    customerMsg:
      "el pago figura anulado. Probá de nuevo o decime y lo solucionamos.",
  },
};

function sanitizeProduct(p: WooProduct): WooProduct {
  return {
    ...p,
    name: sanitizeText(p.name, NAME_MAX),
    shortDescription: sanitizeText(p.shortDescription, DESC_MAX),
    categories: p.categories.map((c) => sanitizeText(c, NAME_MAX)),
  };
}

function buildMessage(
  storeUrl: string,
  products: WooProduct[],
  truncated: boolean,
): string {
  if (products.length === 0) {
    return `No encontré ese producto en el catálogo. Podés ver todo en ${storeUrl}`;
  }
  const lines = products.map(
    (p) =>
      `${p.name} ($${p.price}${p.inStock ? "" : ", sin stock"})${p.permalink ? `: ${p.permalink}` : ""}`,
  );
  const extra = truncated
    ? "\nHay más opciones, mirá el catálogo completo en la web."
    : "";
  return lines.join("\n") + extra;
}

/** Deriva el término de búsqueda cuando el LLM pasó slug o link en vez de query. */
function termFromQuery(q: ProductSearchQuery): string | null {
  if (q.query) return q.query;
  const slug =
    q.productSlug ??
    q.categorySlug ??
    (q.productUrl
      ? (new URL(q.productUrl).pathname.split("/").filter(Boolean).pop() ?? "")
      : "");
  const term = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
  return term.length >= 3 ? term : null;
}

/**
 * Busca productos en Shopify con el mismo fallback de términos que WC.
 * Siempre resuelve sin tirar error: ante fallo devuelve `found:false`.
 */
export async function searchProductsShopify(
  cfg: ShopifyWorkspaceConfig,
  q: ProductSearchQuery,
): Promise<ProductSearchResult> {
  const storeUrl = `https://${cfg.shopDomain}`;
  try {
    const term = termFromQuery(q);
    let products: WooProduct[] = [];
    if (term) {
      for (const attempt of buildSearchAttempts(term, cfg.extraStopwords)) {
        products = await searchProductsByTermShopify(cfg, attempt, q.limit);
        if (products.length > 0) break;
      }
    }
    const truncated = products.length >= q.limit;
    const limited = products.slice(0, q.limit).map(sanitizeProduct);
    return {
      found: limited.length > 0,
      count: limited.length,
      products: limited,
      message: buildMessage(storeUrl, limited, truncated),
    };
  } catch (e) {
    console.error(
      "[ecommerce] product search: error de Shopify:",
      (e as Error).message,
    );
    return {
      found: false,
      count: 0,
      products: [],
      message: `No pude consultar el catálogo en este momento. Podés ver los productos en ${storeUrl}`,
    };
  }
}

/** Registra la consulta en events para métricas (best-effort, no rompe si falla). */
async function logLookup(
  ctx: { workspaceId: string; conversationId: string },
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const supabase = svc();
    await supabase.from("events").insert({
      type: "order_lookup",
      level: "info",
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      payload: { provider: "shopify", ...payload },
    });
  } catch (e) {
    console.warn(
      "[ecommerce] order lookup: no se pudo loguear:",
      (e as Error).message,
    );
  }
}

/**
 * Estado de un pedido de Shopify por número de orden o teléfono. NUNCA lanza:
 * ante error devuelve found:false con mensaje de derivación.
 */
export async function lookupOrderShopify(
  cfg: ShopifyWorkspaceConfig,
  query: OrderLookupQuery,
  ctx: { workspaceId: string; conversationId: string },
): Promise<OrderLookupResult> {
  if (!canLookupOrdersShopify(cfg)) {
    return { found: false, message: DERIVATION_MSG };
  }

  const byId = query.orderId !== undefined;
  const queryType = byId ? ("order_id" as const) : ("phone" as const);
  const queryValue = byId ? String(query.orderId) : String(query.phone);

  try {
    let order = null;
    if (byId) {
      order = await getOrderByNumberShopify(cfg, query.orderId!);
    } else {
      // Shopify suele guardar el teléfono en E.164; probamos variantes AR
      // (nacional 10 dígitos, +549..., 549...) hasta que alguna matchee.
      for (const term of argentinePhoneSearchVariants(query.phone)) {
        order = await searchOrderByPhoneShopify(cfg, term);
        if (order) break;
      }
    }

    if (!order) {
      await logLookup(ctx, {
        query_type: queryType,
        query_value: queryValue,
        order_id: null,
        resolved_status: null,
        found: false,
      });
      return {
        found: false,
        message: byId
          ? `No encuentro la orden ${query.orderId}. ¿Me pasás de nuevo el número, o querés que te derive con alguien?`
          : "No encuentro pedidos con ese dato. ¿Me pasás el número de orden así lo ubico?",
      };
    }

    const status = normalizeStatus(order.status, {
      ...SHOPIFY_STATUS_MAP,
      ...cfg.statusMessages,
    });
    await logLookup(ctx, {
      query_type: queryType,
      query_value: queryValue,
      order_id: order.id,
      resolved_status: status.label,
      found: true,
    });

    return {
      found: true,
      order: {
        id: order.id,
        statusRaw: order.status,
        statusLabel: status.label,
        statusCustomerMsg: status.customerMsg,
        total: Number(order.total),
        currency: order.currency,
        createdAt: order.dateCreated,
        items: order.items,
        paymentMethod: order.paymentMethodTitle,
      },
      message: `Tu pedido #${order.id} está en estado "${status.label}": ${status.customerMsg}`,
    };
  } catch (e) {
    console.error(
      "[ecommerce] order lookup: error de Shopify:",
      (e as Error).message,
    );
    await logLookup(ctx, {
      query_type: queryType,
      query_value: queryValue,
      order_id: null,
      resolved_status: null,
      found: false,
    });
    return { found: false, message: DERIVATION_MSG };
  }
}
