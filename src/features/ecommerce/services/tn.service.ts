import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  searchProductsByTermTn,
  getOrderByNumberTn,
  findOrderByPhoneTn,
} from "./tn-client";
import { canLookupOrdersTn, type TnWorkspaceConfig } from "./tn-config";
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
 * Estados de Tiendanube → lenguaje del cliente. Claves = slug que produce
 * tnStatusSlug() (cancelled / fulfilled / paid / pending / authorized / ...).
 * El workspace los pisa o extiende vía `status_messages` en la config.
 */
const TN_STATUS_MAP: Record<string, StatusMessage> = {
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
  fulfilled: {
    label: "Enviado",
    customerMsg:
      "ya fue despachado. El seguimiento del envío te llega por mail.",
  },
  cancelled: {
    label: "Cancelado",
    customerMsg:
      "el pedido figura cancelado. Si fue un error, avisame y lo vemos.",
  },
  refunded: {
    label: "Reembolsado",
    customerMsg: "se procesó un reembolso de este pedido.",
  },
  voided: {
    label: "Pago anulado",
    customerMsg:
      "el pago figura anulado. Probá de nuevo o decime y lo solucionamos.",
  },
  abandoned: {
    label: "Compra sin finalizar",
    customerMsg:
      "todavía no se finalizó la compra. Si querés la completamos juntos.",
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
  storeUrl: string | null,
  products: WooProduct[],
  truncated: boolean,
): string {
  if (products.length === 0) {
    return storeUrl
      ? `No encontré ese producto en el catálogo. Podés ver todo en ${storeUrl}`
      : "No encontré ese producto en el catálogo.";
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
export function termFromQuery(q: ProductSearchQuery): string | null {
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
 * Busca productos en Tiendanube con el mismo fallback de términos que WC.
 * Siempre resuelve sin tirar error: ante fallo devuelve `found:false`.
 */
export async function searchProductsTn(
  cfg: TnWorkspaceConfig,
  q: ProductSearchQuery,
): Promise<ProductSearchResult> {
  try {
    const term = termFromQuery(q);
    let products: WooProduct[] = [];
    if (term) {
      for (const attempt of buildSearchAttempts(term, cfg.extraStopwords)) {
        products = await searchProductsByTermTn(cfg, attempt, q.limit);
        if (products.length > 0) break;
      }
    }
    const truncated = products.length >= q.limit;
    const limited = products.slice(0, q.limit).map(sanitizeProduct);
    return {
      found: limited.length > 0,
      count: limited.length,
      products: limited,
      message: buildMessage(cfg.storeUrl, limited, truncated),
    };
  } catch (e) {
    console.error(
      "[ecommerce] product search: error de Tiendanube:",
      (e as Error).message,
    );
    return {
      found: false,
      count: 0,
      products: [],
      message: cfg.storeUrl
        ? `No pude consultar el catálogo en este momento. Podés ver los productos en ${cfg.storeUrl}`
        : "No pude consultar el catálogo en este momento.",
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
      payload: { provider: "tiendanube", ...payload },
    });
  } catch (e) {
    console.warn(
      "[ecommerce] order lookup: no se pudo loguear:",
      (e as Error).message,
    );
  }
}

/**
 * Estado de un pedido de Tiendanube por número de orden o teléfono. NUNCA
 * lanza: ante error devuelve found:false con mensaje de derivación.
 */
export async function lookupOrderTn(
  cfg: TnWorkspaceConfig,
  query: OrderLookupQuery,
  ctx: { workspaceId: string; conversationId: string },
): Promise<OrderLookupResult> {
  if (!canLookupOrdersTn(cfg)) {
    return { found: false, message: DERIVATION_MSG };
  }

  const byId = query.orderId !== undefined;
  const queryType = byId ? ("order_id" as const) : ("phone" as const);
  const queryValue = byId ? String(query.orderId) : String(query.phone);

  try {
    const order = byId
      ? await getOrderByNumberTn(cfg, query.orderId!)
      : await findOrderByPhoneTn(
          cfg,
          argentinePhoneSearchVariants(query.phone),
        );

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
      ...TN_STATUS_MAP,
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
      "[ecommerce] order lookup: error de Tiendanube:",
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
