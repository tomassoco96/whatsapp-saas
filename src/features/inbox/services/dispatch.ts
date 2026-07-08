/**
 * dispatch.ts — SEC-04 single exit point for ALL outbound messages.
 *
 * ONLY dispatchText and dispatchTemplate should call sendText / sendTemplate.
 * No other module should invoke those functions directly for user-facing sends.
 */

import { createClient as createSbClient } from "@supabase/supabase-js";
import { sendText, sendTemplate } from "./ycloud-client";
import type { TemplateParams } from "./ycloud-client";
import { sendEvolutionText } from "./evolution-client";
import { formatWhatsAppMarkdown } from "./text-formatter";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Parameter interfaces
// ──────────────────────────────────────────────────────────────────────────────

export interface DispatchTextParams {
  workspaceId: string;
  conversationId: string;
  body: string;
  /** null = AI-generated, set = human agent */
  senderUserId?: string;
  /** Admin bypass for expired window — triggers a WINDOW_OVERRIDE DB log */
  overrideAdmin?: boolean;
}

export interface DispatchTemplateParams {
  workspaceId: string;
  conversationId: string;
  templateName: string;
  /** Defaults to 'es'. NEVER use 'es_PA' — Movinsa gotcha */
  templateLanguage?: string;
  components?: TemplateParams["components"];
  senderUserId?: string;
}

export interface DispatchResult {
  ok: boolean;
  wamid?: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

interface IntegrationRow {
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

interface ContactPhoneRow {
  phone: string;
}

interface ConversationWindowRow {
  window_expires_at: string | null;
  contact_id: string;
}

/**
 * Integración de canal resuelta por workspace. Si el workspace tiene YCloud y
 * Evolution habilitados a la vez, gana YCloud (canal oficial).
 */
type ChannelIntegration =
  | { provider: "ycloud"; apiKey: string; fromPhone: string }
  | {
      provider: "evolution";
      serverUrl: string;
      apiKey: string;
      instance: string;
    };

async function loadChannelIntegration(
  workspaceId: string,
  supabase: ReturnType<typeof svc>,
): Promise<ChannelIntegration> {
  const { data, error } = await supabase
    .from("integrations")
    .select("provider, credentials, config")
    .eq("workspace_id", workspaceId)
    .in("provider", ["ycloud", "evolution"])
    .eq("enabled", true);

  const rows = (data ?? []) as Array<IntegrationRow & { provider: string }>;
  const row =
    rows.find((r) => r.provider === "ycloud") ??
    rows.find((r) => r.provider === "evolution");

  if (error || !row) {
    throw new Error(
      `[dispatch] channel integration not found: ${error?.message ?? "no enabled ycloud/evolution integration"}`,
    );
  }

  if (row.provider === "evolution") {
    return {
      provider: "evolution",
      serverUrl: (row.config.server_url as string | undefined) ?? "",
      apiKey: (row.credentials.evolution_api_key as string | undefined) ?? "",
      instance: (row.config.instance_name as string | undefined) ?? "",
    };
  }

  return {
    provider: "ycloud",
    apiKey: (row.credentials.ycloud_api_key as string | undefined) ?? "",
    fromPhone: (row.config.phone_number as string | undefined) ?? "",
  };
}

async function loadConversationAndPhone(
  conversationId: string,
  supabase: ReturnType<typeof svc>,
): Promise<{ window_expires_at: string | null; toPhone: string }> {
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("window_expires_at, contact_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    throw new Error(`[dispatch] conversation not found: ${convError?.message}`);
  }

  const convRow = conv as ConversationWindowRow;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("phone")
    .eq("id", convRow.contact_id)
    .single();

  if (contactError || !contact) {
    throw new Error(`[dispatch] contact not found: ${contactError?.message}`);
  }

  return {
    window_expires_at: convRow.window_expires_at,
    toPhone: (contact as ContactPhoneRow).phone,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// dispatchText — sends a free-text outbound message
// ──────────────────────────────────────────────────────────────────────────────
export async function dispatchText(
  params: DispatchTextParams,
): Promise<DispatchResult> {
  const {
    workspaceId,
    conversationId,
    body: rawBody,
    senderUserId,
    overrideAdmin = false,
  } = params;

  // Normalise Markdown → WhatsApp formatting (e.g. **bold** → *bold*) once, so
  // both the YCloud send and the persisted message match what the user receives.
  const body = formatWhatsAppMarkdown(rawBody);

  const supabase = svc();

  // 1. Load conversation window + contact phone
  const { window_expires_at, toPhone } = await loadConversationAndPhone(
    conversationId,
    supabase,
  );

  // SEC-10: Block outbound to opted-out contacts
  const { data: convRow } = await supabase
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .single();

  if (convRow) {
    const { data: contactOptData } = await supabase
      .from("contacts")
      .select("opt_in")
      .eq("id", (convRow as { contact_id: string }).contact_id)
      .single();

    if (
      contactOptData &&
      (contactOptData as { opt_in: boolean }).opt_in === false
    ) {
      return {
        ok: false,
        error: "OPT_OUT: contact has opted out of WhatsApp messages",
      };
    }
  }

  // 2. App-level 24h window guard (DB trigger is the final enforcer)
  if (
    window_expires_at !== null &&
    new Date() > new Date(window_expires_at) &&
    !overrideAdmin
  ) {
    return { ok: false, error: "WINDOW_EXPIRED" };
  }

  // 3. Load channel credentials (YCloud or Evolution)
  const channel = await loadChannelIntegration(workspaceId, supabase);

  // 4. Send via the channel provider (skip if placeholder / dev mode)
  // YCloud returns its own `id` synchronously and assigns the WhatsApp `wamid`
  // asynchronously (delivered via a status webhook). A 2xx response means the
  // message was accepted for delivery, even when `wamid` is still empty.
  // Evolution returns the WhatsApp message id (key.id) synchronously.
  let wamid: string | undefined;
  let ycloudId: string | undefined;
  const realSend = Boolean(channel.apiKey && channel.apiKey !== "placeholder");

  if (realSend) {
    try {
      if (channel.provider === "evolution") {
        const sent = await sendEvolutionText({
          serverUrl: channel.serverUrl,
          apiKey: channel.apiKey,
          instance: channel.instance,
          to: toPhone,
          body,
        });
        wamid = sent.id || undefined;
      } else {
        const sent = await sendText({
          apiKey: channel.apiKey,
          from: channel.fromPhone,
          to: toPhone,
          body,
        });
        wamid = sent.wamid || undefined;
        ycloudId = sent.id || undefined;
      }
    } catch (sendErr) {
      const errMsg =
        sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error(`[dispatch] ${channel.provider} sendText error:`, errMsg);

      // Persist failed message for audit
      await supabase.from("messages").insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        direction: "out",
        type: "text",
        body,
        status: "failed",
        sender_user_id: senderUserId ?? null,
        meta: { error: errMsg, override_admin: overrideAdmin || undefined },
      });

      return { ok: false, error: errMsg };
    }
  }

  // 5. Persist outbound message
  // The DB trigger trg_messages_24h_window fires here — if override_admin is set
  // and window is expired, the trigger logs WINDOW_OVERRIDE and allows the insert.
  const { error: insertError } = await supabase.from("messages").insert({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "out",
    type: "text",
    body,
    wamid: wamid ?? null,
    // A real YCloud send is 'sent'; only a placeholder key stays a dev no-op.
    status: realSend ? "sent" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      dev_mode: realSend ? undefined : true,
      provider: channel.provider,
      ycloud_id: ycloudId,
      override_admin: overrideAdmin || undefined,
    },
  });

  if (insertError) {
    // Surface DB trigger errors (WINDOW_EXPIRED raised by trigger)
    console.error("[dispatch] message insert error:", insertError.message);
    return { ok: false, error: insertError.message };
  }

  // 6. Refresh conversation last_message_at
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true, wamid };
}

// ──────────────────────────────────────────────────────────────────────────────
// dispatchTemplate — sends an approved template (bypasses 24h window)
// ──────────────────────────────────────────────────────────────────────────────
export async function dispatchTemplate(
  params: DispatchTemplateParams,
): Promise<DispatchResult> {
  const {
    workspaceId,
    conversationId,
    templateName,
    templateLanguage = "es",
    components,
    senderUserId,
  } = params;

  const supabase = svc();

  // 1. Load contact phone (templates bypass the window guard entirely)
  const { toPhone } = await loadConversationAndPhone(conversationId, supabase);

  // SEC-10: Block outbound to opted-out contacts
  const { data: tplConvRow } = await supabase
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .single();

  if (tplConvRow) {
    const { data: tplOptData } = await supabase
      .from("contacts")
      .select("opt_in")
      .eq("id", (tplConvRow as { contact_id: string }).contact_id)
      .single();

    if (tplOptData && (tplOptData as { opt_in: boolean }).opt_in === false) {
      return {
        ok: false,
        error: "OPT_OUT: contact has opted out of WhatsApp messages",
      };
    }
  }

  // 2. Load channel credentials
  const channel = await loadChannelIntegration(workspaceId, supabase);

  // Los templates son un concepto de la API oficial de Meta — Evolution
  // (Baileys) no los tiene. Error explícito para que el caller decida
  // (recovery y setter follow-up requieren canal oficial).
  if (channel.provider === "evolution") {
    return {
      ok: false,
      error: "TEMPLATES_NOT_SUPPORTED: el canal Evolution no soporta templates de Meta",
    };
  }

  // 3. Send template via YCloud
  let wamid: string | undefined;
  const { apiKey, fromPhone } = channel;

  if (apiKey && apiKey !== "placeholder") {
    try {
      const sent = await sendTemplate({
        apiKey,
        from: fromPhone,
        to: toPhone,
        templateName,
        language: templateLanguage,
        components,
      });
      wamid = sent.wamid;
    } catch (sendErr) {
      const errMsg =
        sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error("[dispatch] YCloud sendTemplate error:", errMsg);

      await supabase.from("messages").insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        direction: "out",
        type: "template",
        body: templateName,
        status: "failed",
        sender_user_id: senderUserId ?? null,
        meta: { error: errMsg, template_name: templateName },
      });

      return { ok: false, error: errMsg };
    }
  }

  // 4. Persist template message — type='template' bypasses DB trigger
  const { error: insertError } = await supabase.from("messages").insert({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "out",
    type: "template",
    body: templateName,
    wamid: wamid ?? null,
    status: wamid ? "queued" : "queued",
    sender_user_id: senderUserId ?? null,
    meta: {
      template_name: templateName,
      template_language: templateLanguage,
      dev_mode: !wamid || undefined,
    },
  });

  if (insertError) {
    console.error("[dispatch] template insert error:", insertError.message);
    return { ok: false, error: insertError.message };
  }

  // 5. Refresh conversation last_message_at
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true, wamid };
}
