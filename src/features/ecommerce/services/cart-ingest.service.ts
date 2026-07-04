import { createClient as createSbClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import {
  normalizeArgentinePhone,
  normalizeInternationalPhone,
} from "../lib/phone";
import { sanitizeCartItems } from "../lib/sanitize";
import type { AbandonedCartWebhook } from "../schemas/cart";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Ventana del dedupe blando por teléfono (sin external_id). */
const SOFT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Compara el secret del webhook en tiempo constante.
 * Devuelve false ante secret no configurado o header ausente.
 */
export function verifyCartWebhookSecret(
  configured: string | null,
  received: string | null,
): boolean {
  if (!configured || !received) return false;
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface IngestCartResult {
  cartId: string;
  deduped: boolean;
  contactable: boolean;
}

/**
 * Ingiere un carrito abandonado del plugin (Flujo A del motor v1).
 *
 * - Normaliza el teléfono a E.164 AR; sin teléfono → status not_contactable.
 * - Dedupe fuerte por (workspace, external_id); blando por teléfono con un
 *   carrito pending del mismo workspace en las últimas 24 h.
 * - Vincula el contacto existente del workspace si el teléfono matchea.
 * - Loguea el evento cart_abandoned para observabilidad.
 *
 * La secuencia de toques NO se dispara acá: los carritos nacen 'pending' y
 * el flujo de recuperación (cron/automation) decide cuándo y si contactar
 * (opt-out, quiet hours y re-verificación de pago se resuelven ahí).
 */
export async function ingestAbandonedCart(
  workspaceId: string,
  input: AbandonedCartWebhook,
): Promise<IngestCartResult> {
  const supabase = svc();
  // AR primero (heurística de nacionales de 10 dígitos), fallback
  // internacional para números que ya traen código de país (+52, +55, etc.)
  const phone =
    normalizeArgentinePhone(input.phone) ??
    normalizeInternationalPhone(input.phone);
  const items = sanitizeCartItems(input.items);

  // ── Dedupe fuerte por external_id ─────────────────────────────────────────
  if (input.external_id) {
    const { data: existing } = await supabase
      .from("abandoned_carts")
      .select("id, status")
      .eq("workspace_id", workspaceId)
      .eq("external_id", input.external_id)
      .maybeSingle();

    if (existing) {
      const ex = existing as { id: string; status: string };
      // Los plugins re-postean el mismo carrito cuando cambia (más ítems,
      // otro total): refrescamos el contenido mientras nadie fue contactado.
      if (ex.status === "pending" || ex.status === "not_contactable") {
        await supabase
          .from("abandoned_carts")
          .update({
            items,
            total: input.total,
            checkout_url: input.checkout_url ?? null,
            abandoned_at: new Date(input.abandoned_at).toISOString(),
          })
          .eq("id", ex.id);
      }
      return {
        cartId: ex.id,
        deduped: true,
        contactable: phone !== null,
      };
    }
  }

  // ── Dedupe blando: mismo teléfono con un pending reciente ────────────────
  if (!input.external_id && phone) {
    const windowStart = new Date(
      Date.now() - SOFT_DEDUPE_WINDOW_MS,
    ).toISOString();
    const { data: recent } = await supabase
      .from("abandoned_carts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("phone", phone)
      .eq("status", "pending")
      .gte("abandoned_at", windowStart)
      .limit(1)
      .maybeSingle();

    if (recent) {
      return {
        cartId: (recent as { id: string }).id,
        deduped: true,
        contactable: true,
      };
    }
  }

  // ── Vincular contacto existente del workspace por teléfono ───────────────
  let contactId: string | null = null;
  if (phone) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("phone", phone)
      .maybeSingle();
    contactId = (contact as { id: string } | null)?.id ?? null;
  }

  // ── Insertar ──────────────────────────────────────────────────────────────
  const { data: created, error: insertError } = await supabase
    .from("abandoned_carts")
    .insert({
      workspace_id: workspaceId,
      contact_id: contactId,
      external_id: input.external_id ?? null,
      phone,
      email: input.email ?? null,
      customer_name: input.name ?? null,
      items,
      total: input.total,
      currency: input.currency ?? null,
      checkout_url: input.checkout_url ?? null,
      abandoned_at: new Date(input.abandoned_at).toISOString(),
      status: phone ? "pending" : "not_contactable",
    })
    .select("id")
    .single();

  if (insertError || !created) {
    // Carrera con el índice único (dos webhooks simultáneos): resolver como dedupe
    if (insertError?.code === "23505" && input.external_id) {
      const { data: raced } = await supabase
        .from("abandoned_carts")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("external_id", input.external_id)
        .maybeSingle();
      if (raced) {
        return {
          cartId: (raced as { id: string }).id,
          deduped: true,
          contactable: phone !== null,
        };
      }
    }
    throw new Error(
      `[ecommerce] cart insert failed: ${insertError?.message ?? "sin fila"}`,
    );
  }

  const cartId = (created as { id: string }).id;

  // ── Evento de observabilidad (best-effort) ───────────────────────────────
  try {
    await supabase.from("events").insert({
      type: "cart_abandoned",
      level: "info",
      workspace_id: workspaceId,
      payload: {
        cart_id: cartId,
        external_id: input.external_id ?? null,
        total: input.total,
        items_count: items.length,
        contactable: phone !== null,
        contact_id: contactId,
      },
    });
  } catch (e) {
    console.warn(
      "[ecommerce] cart event log failed:",
      (e as Error).message,
    );
  }

  return { cartId, deduped: false, contactable: phone !== null };
}
