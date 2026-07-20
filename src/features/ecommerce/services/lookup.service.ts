import { createClient as createSbClient } from "@supabase/supabase-js";
import { getOrderById, searchOrderByPhone } from "./wc-client";
import { canLookupOrders, type WcWorkspaceConfig } from "./wc-config";
import { argentinePhoneSearchVariants } from "../lib/phone";
import { normalizeStatus } from "../lib/status-map";
import type { OrderLookupResult } from "../types";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const DERIVATION_MSG =
  "No puedo verificarlo en este momento, ya te derivo con alguien del equipo para que te ayude.";

export interface OrderLookupQuery {
  orderId?: number;
  phone?: string;
  /** Email que el cliente aportó para verificar propiedad del pedido. */
  email?: string;
  /** Teléfono del contacto de ESTE chat (para verificar propiedad del pedido). */
  contactPhone?: string;
}

/**
 * ¿Dos teléfonos son de la misma persona? Compara los últimos 8 dígitos (ignora
 * prefijos país/área y el 9 de celular AR). Vacíos → no matchean.
 */
function phonesMatch(a?: string | null, b?: string | null): boolean {
  const norm = (p?: string | null) => (p ?? "").replace(/\D/g, "").slice(-8);
  const na = norm(a);
  const nb = norm(b);
  return na.length === 8 && na === nb;
}

/** Igualdad de emails, normalizada (trim + lowercase). Vacíos → no matchean. */
function emailsMatch(a?: string | null, b?: string | null): boolean {
  const na = (a ?? "").trim().toLowerCase();
  const nb = (b ?? "").trim().toLowerCase();
  return na.length > 0 && na === nb;
}

interface LookupLogContext {
  workspaceId: string;
  conversationId: string;
}

/** Registra la consulta en events para métricas (best-effort, no rompe si falla). */
async function logLookup(
  ctx: LookupLogContext,
  payload: {
    query_type: "order_id" | "phone";
    query_value: string;
    wc_order_id: number | null;
    resolved_status: string | null;
    found: boolean;
  },
): Promise<void> {
  try {
    const supabase = svc();
    await supabase.from("events").insert({
      type: "order_lookup",
      level: "info",
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      payload,
    });
  } catch (e) {
    console.warn(
      "[ecommerce] order lookup: no se pudo loguear:",
      (e as Error).message,
    );
  }
}

/**
 * Resuelve el estado de un pedido por ID o por teléfono. NUNCA lanza: ante
 * error de WooCommerce devuelve found:false con mensaje de derivación.
 */
export async function lookupOrder(
  cfg: WcWorkspaceConfig,
  query: OrderLookupQuery,
  ctx: LookupLogContext,
): Promise<OrderLookupResult> {
  if (!canLookupOrders(cfg)) {
    return { found: false, message: DERIVATION_MSG };
  }

  const byId = query.orderId !== undefined;
  const queryType = byId ? ("order_id" as const) : ("phone" as const);
  const queryValue = byId ? String(query.orderId) : String(query.phone);

  try {
    let order = null;
    if (byId) {
      order = await getOrderById(cfg, query.orderId!);
    } else {
      // WC guarda el teléfono en formato local; probamos variantes (nacional
      // 10 dígitos primero) hasta que alguna matchee.
      const variants = argentinePhoneSearchVariants(query.phone);
      for (const term of variants) {
        order = await searchOrderByPhone(cfg, term);
        if (order) break;
      }
    }

    if (!order) {
      await logLookup(ctx, {
        query_type: queryType,
        query_value: queryValue,
        wc_order_id: null,
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

    // GATE DE PROPIEDAD (solo búsqueda por número): los IDs de WooCommerce son
    // secuenciales, así que cualquiera podría pedir el estado de un pedido ajeno
    // con solo tirar números. Revelamos SOLO si el teléfono de facturación del
    // pedido coincide con el del chat, o con uno que el cliente aportó (el que
    // usó al comprar). Si no matchea, no revelamos: pedimos verificación. La
    // búsqueda por teléfono ya está acotada al dueño, no necesita este gate.
    if (byId) {
      const owns =
        phonesMatch(order.billingPhone, query.contactPhone) ||
        phonesMatch(order.billingPhone, query.phone) ||
        emailsMatch(order.billingEmail, query.email);
      if (!owns) {
        await logLookup(ctx, {
          query_type: queryType,
          query_value: queryValue,
          wc_order_id: order.id,
          resolved_status: null,
          found: false,
        });
        return {
          found: false,
          message:
            "Para cuidar los datos del pedido necesito confirmar que es tuyo. ¿Me pasás el teléfono o el mail con el que lo hiciste?",
        };
      }
    }

    const status = normalizeStatus(order.status, cfg.statusMessages);
    await logLookup(ctx, {
      query_type: queryType,
      query_value: queryValue,
      wc_order_id: order.id,
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
      "[ecommerce] order lookup: error de WooCommerce:",
      (e as Error).message,
    );
    await logLookup(ctx, {
      query_type: queryType,
      query_value: queryValue,
      wc_order_id: null,
      resolved_status: null,
      found: false,
    });
    return { found: false, message: DERIVATION_MSG };
  }
}
