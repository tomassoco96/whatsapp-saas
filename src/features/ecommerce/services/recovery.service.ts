import { createClient as createSbClient } from "@supabase/supabase-js";
import { dispatchTemplate } from "@/features/inbox/services/dispatch";
import { searchOrderByPhone } from "./wc-client";
import { canLookupOrders, type WcWorkspaceConfig } from "./wc-config";
import { isPaidStatus } from "../lib/status-map";
import { argentinePhoneSearchVariants } from "../lib/phone";
import {
  parseRecoveryConfig,
  isWithinQuietHours,
  nextTouchDue,
  isExpired,
  type RecoveryConfig,
} from "../lib/recovery-config";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Carritos procesados por workspace por corrida (protege el sweep). */
const MAX_CARTS_PER_WORKSPACE = 20;

interface CartRow {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  phone: string;
  customer_name: string | null;
  status: string;
  touches_sent: number;
  abandoned_at: string;
  last_touch_at: string | null;
}

export interface SweepResult {
  workspacesProcessed: number;
  touchesSent: number;
  recovered: number;
  optedOut: number;
  expired: number;
  errors: number;
}

async function logRecoveryEvent(
  workspaceId: string,
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const supabase = svc();
    await supabase.from("events").insert({
      type: "cart_recovery",
      level,
      workspace_id: workspaceId,
      payload,
    });
  } catch {
    // best-effort
  }
}

/**
 * Asegura contacto + conversación para el carrito y devuelve el
 * conversation_id (dispatchTemplate lo necesita). El checkout con teléfono
 * implica consentimiento para el toque de recuperación (opt-out disponible);
 * si el contacto ya existía, NO se le pisa el opt_in.
 */
async function ensureConversation(
  cart: CartRow,
): Promise<{ conversationId: string; contactId: string; optedOut: boolean }> {
  const supabase = svc();

  // 1. Contacto: usar el vinculado o buscar/crear por teléfono
  let contactId = cart.contact_id;
  let optIn = true;
  if (contactId) {
    const { data } = await supabase
      .from("contacts")
      .select("id, opt_in")
      .eq("id", contactId)
      .maybeSingle();
    optIn = (data as { opt_in?: boolean } | null)?.opt_in !== false;
  } else {
    const { data: existing } = await supabase
      .from("contacts")
      .select("id, opt_in")
      .eq("workspace_id", cart.workspace_id)
      .eq("phone", cart.phone)
      .maybeSingle();

    if (existing) {
      contactId = (existing as { id: string }).id;
      optIn = (existing as { opt_in?: boolean }).opt_in !== false;
    } else {
      const { data: created, error } = await supabase
        .from("contacts")
        .insert({
          workspace_id: cart.workspace_id,
          phone: cart.phone,
          name: cart.customer_name,
          opt_in: true,
          opt_in_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error || !created) {
        throw new Error(`contact create failed: ${error?.message}`);
      }
      contactId = (created as { id: string }).id;
    }

    // Vincular el contacto al carrito para las próximas corridas
    await supabase
      .from("abandoned_carts")
      .update({ contact_id: contactId })
      .eq("id", cart.id);
  }

  if (!optIn) {
    return { conversationId: "", contactId, optedOut: true };
  }

  // 2. Conversación: upsert por (workspace, contacto, canal)
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: cart.workspace_id,
        contact_id: contactId,
        channel: "whatsapp",
      },
      { onConflict: "workspace_id,contact_id,channel", ignoreDuplicates: false },
    )
    .select("id")
    .single();

  if (convError || !conv) {
    throw new Error(`conversation upsert failed: ${convError?.message}`);
  }

  return {
    conversationId: (conv as { id: string }).id,
    contactId,
    optedOut: false,
  };
}

/**
 * Re-verificación de pago (US-006 del v1): si el cliente ya tiene un pedido
 * PAGADO en WooCommerce, el carrito se marca recovered y no se lo molesta.
 * Best-effort: ante error de WC devuelve null (no bloquea el toque).
 */
async function checkAlreadyPaid(
  wcCfg: WcWorkspaceConfig,
  phone: string,
): Promise<number | null> {
  if (!canLookupOrders(wcCfg)) return null;
  try {
    for (const term of argentinePhoneSearchVariants(phone)) {
      const order = await searchOrderByPhone(wcCfg, term);
      if (order && isPaidStatus(order.status)) return order.id;
      if (order) return null; // hay orden pero no pagada: seguir con el toque
    }
  } catch {
    return null;
  }
  return null;
}

/** Procesa un carrito: guardas → claim idempotente → envío del template. */
async function processCart(
  cart: CartRow,
  cfg: RecoveryConfig,
  wcCfg: WcWorkspaceConfig,
  now: Date,
  result: SweepResult,
): Promise<void> {
  const supabase = svc();

  const touchState = {
    touchesSent: cart.touches_sent,
    abandonedAt: cart.abandoned_at,
    lastTouchAt: cart.last_touch_at,
  };

  // Secuencia agotada → expirar cuando corresponda
  if (isExpired(touchState, cfg, now)) {
    await supabase
      .from("abandoned_carts")
      .update({ status: "expired" })
      .eq("id", cart.id)
      .eq("status", "contacted");
    result.expired++;
    return;
  }

  const touchIdx = nextTouchDue(touchState, cfg, now);
  if (touchIdx === null) return;

  // Re-verificación de pago antes de molestar
  const paidOrderId = await checkAlreadyPaid(wcCfg, cart.phone);
  if (paidOrderId !== null) {
    await supabase
      .from("abandoned_carts")
      .update({ status: "recovered", recovered_order_id: paidOrderId })
      .eq("id", cart.id);
    await logRecoveryEvent(cart.workspace_id, "info", {
      action: "recovered_before_touch",
      cart_id: cart.id,
      order_id: paidOrderId,
    });
    result.recovered++;
    return;
  }

  // Contacto + conversación (y chequeo de opt-out)
  const ensured = await ensureConversation(cart);
  if (ensured.optedOut) {
    await supabase
      .from("abandoned_carts")
      .update({ status: "opted_out" })
      .eq("id", cart.id);
    result.optedOut++;
    return;
  }

  // Claim idempotente: solo un worker avanza touches_sent de N a N+1.
  // Si otro sweep ya lo tomó (0 filas), no se envía nada — no hay duplicados.
  const { data: claimed } = await supabase
    .from("abandoned_carts")
    .update({
      touches_sent: cart.touches_sent + 1,
      last_touch_at: now.toISOString(),
      status: "contacted",
    })
    .eq("id", cart.id)
    .eq("touches_sent", cart.touches_sent)
    .select("id");

  if (!claimed || (claimed as unknown[]).length === 0) return;

  // Envío del template (bypasea la ventana de 24h; dispatch re-chequea opt-out)
  const touch = cfg.touches[touchIdx];
  const sent = await dispatchTemplate({
    workspaceId: cart.workspace_id,
    conversationId: ensured.conversationId,
    templateName: touch.templateName,
    templateLanguage: touch.templateLanguage,
  });

  if (sent.ok) {
    result.touchesSent++;
    await logRecoveryEvent(cart.workspace_id, "info", {
      action: "touch_sent",
      cart_id: cart.id,
      touch_index: touchIdx,
      template: touch.templateName,
    });
  } else {
    // El claim NO se revierte: preferimos perder un toque a duplicarlo.
    result.errors++;
    await logRecoveryEvent(cart.workspace_id, "error", {
      action: "touch_failed",
      cart_id: cart.id,
      touch_index: touchIdx,
      template: touch.templateName,
      error: sent.error ?? "unknown",
    });
  }
}

/**
 * Corrida completa de recuperación (la llama el cron cada 15').
 * Recorre los workspaces con recovery habilitado y procesa sus carritos
 * contactables. Cada guarda del v1 está acá: activación explícita por
 * workspace, quiet hours, opt-out, re-verificación de pago e idempotencia.
 */
export async function runRecoverySweep(
  now: Date = new Date(),
): Promise<SweepResult> {
  const supabase = svc();
  const result: SweepResult = {
    workspacesProcessed: 0,
    touchesSent: 0,
    recovered: 0,
    optedOut: 0,
    expired: 0,
    errors: 0,
  };

  const { data: integrations, error } = await supabase
    .from("integrations")
    .select("workspace_id, credentials, config")
    .eq("provider", "woocommerce")
    .eq("enabled", true);

  if (error || !integrations) return result;

  for (const row of integrations as Array<{
    workspace_id: string;
    credentials: Record<string, unknown> | null;
    config: Record<string, unknown> | null;
  }>) {
    const cfg = parseRecoveryConfig(row.config);
    if (!cfg) continue; // recovery no habilitado para este workspace
    if (isWithinQuietHours(now, cfg)) continue;

    const credentials = row.credentials ?? {};
    const config = row.config ?? {};
    const wcCfg: WcWorkspaceConfig = {
      storeUrl:
        typeof config.store_url === "string"
          ? config.store_url.trim().replace(/\/$/, "")
          : "",
      consumerKey:
        typeof credentials.wc_consumer_key === "string"
          ? credentials.wc_consumer_key
          : null,
      consumerSecret:
        typeof credentials.wc_consumer_secret === "string"
          ? credentials.wc_consumer_secret
          : null,
      extraStopwords: [],
      statusMessages: null,
      cartWebhookSecret: null,
    };

    result.workspacesProcessed++;

    const { data: carts } = await supabase
      .from("abandoned_carts")
      .select(
        "id, workspace_id, contact_id, phone, customer_name, status, touches_sent, abandoned_at, last_touch_at",
      )
      .eq("workspace_id", row.workspace_id)
      .in("status", ["pending", "contacted"])
      .not("phone", "is", null)
      .order("abandoned_at", { ascending: true })
      .limit(MAX_CARTS_PER_WORKSPACE);

    for (const cart of (carts as CartRow[] | null) ?? []) {
      try {
        await processCart(cart, cfg, wcCfg, now, result);
      } catch (e) {
        result.errors++;
        await logRecoveryEvent(cart.workspace_id, "error", {
          action: "cart_processing_failed",
          cart_id: cart.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return result;
}
