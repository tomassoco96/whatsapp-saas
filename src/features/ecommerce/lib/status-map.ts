import type { NormalizedStatus, StatusMessage } from "../types";

/**
 * Mapa de estados de pedido WooCommerce → lenguaje del cliente.
 * Portado del motor v1. Las claves son los slugs SIN el prefijo "wc-", en
 * minúscula. Incluye los slugs custom del flujo de comprobante de
 * transferencia (receipt-*) y de fábrica (exportado, en-produccion, demorado)
 * que usan los clientes v1; un workspace los pisa o agrega los suyos vía
 * `status_messages` en la config de la integración (gotcha G22: solo estados
 * CONFIRMADOS por el cliente van al prompt — este fallback del tool es seguro
 * porque deriva ante lo desconocido).
 */
const DEFAULT_STATUS_MAP: Record<string, StatusMessage> = {
  pending: {
    label: "Pendiente de pago",
    customerMsg:
      "todavía figura sin pagar. Si querés lo destrabamos juntos, decime con qué método ibas a pagar.",
  },
  // Flujo de comprobantes (plugin de pago por transferencia)
  "receipt-upload": {
    label: "Carga pendiente",
    customerMsg:
      "estamos esperando que subas el comprobante de la transferencia para avanzar.",
  },
  "receipt-approval": {
    label: "Revisando comprobante",
    customerMsg:
      "recibimos tu comprobante y lo estamos revisando para confirmar el pago.",
  },
  "receipt-rejected": {
    label: "Comprobante rechazado",
    customerMsg:
      "hubo un problema con el comprobante. Dejame que te derivo con alguien del equipo para resolverlo.",
  },
  "on-hold": {
    label: "En espera",
    customerMsg: "estamos esperando la confirmación del pago para arrancar.",
  },
  processing: {
    label: "Procesando",
    customerMsg: "el pago ya está confirmado y el pedido pasó a preparación.",
  },
  exportado: {
    label: "Exportado",
    customerMsg: "ya ingresó a producción y arrancamos a fabricarlo.",
  },
  "en-produccion": {
    label: "En producción",
    customerMsg: "ya lo estamos fabricando. Sale en 24 a 72 hs hábiles.",
  },
  demorado: {
    label: "Demorado",
    customerMsg:
      "se pasó un poco de los tiempos estimados — le damos prioridad y te avisamos por mail apenas esté.",
  },
  completed: {
    label: "Completado",
    customerMsg:
      "ya está terminado y despachado. El seguimiento te llega por mail.",
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
  failed: {
    label: "Pago fallido",
    customerMsg:
      "el pago no se pudo procesar. Probá de nuevo o decime y lo solucionamos.",
  },
  "checkout-draft": {
    label: "Borrador",
    customerMsg:
      "todavía no se finalizó la compra. Si querés la completamos juntos.",
  },
};

/**
 * Estados post-pago confirmados: el cliente YA pagó y el pedido avanza.
 * Se usa para la re-verificación de pago antes de recuperar un carrito: si el
 * cliente tiene una orden en alguno de estos estados, no se lo molesta.
 * Excluye los ambiguos (on-hold, receipt-*) y los pre/no-pago.
 */
const PAID_STATUSES = new Set([
  "processing",
  "exportado",
  "en-produccion",
  "demorado",
  "completed",
]);

function toKey(rawStatus: string): string {
  return rawStatus.toLowerCase().trim().replace(/^wc-/, "");
}

/** True si el slug de estado WC corresponde a un pedido ya pagado. */
export function isPaidStatus(rawStatus: string): boolean {
  return PAID_STATUSES.has(toKey(rawStatus));
}

/**
 * Normaliza un slug de estado de WooCommerce a label + mensaje al cliente.
 * `overrides` (config del workspace) pisa o extiende el mapa default.
 */
export function normalizeStatus(
  rawStatus: string,
  overrides?: Record<string, StatusMessage> | null,
): NormalizedStatus {
  const key = toKey(rawStatus);
  const hit = overrides?.[key] ?? DEFAULT_STATUS_MAP[key];
  if (hit) {
    return { label: hit.label, customerMsg: hit.customerMsg, known: true };
  }
  // Fallback seguro para estados no mapeados
  return {
    label: rawStatus,
    customerMsg:
      "tu pedido está en proceso. Si querés un detalle más fino te derivo con alguien del equipo.",
    known: false,
  };
}
