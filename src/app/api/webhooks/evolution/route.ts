import { type NextRequest, NextResponse, after } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  verifyEvolutionToken,
  parseEvolutionInbound,
  parseEvolutionStatusUpdate,
} from "@/features/inbox/services/evolution-webhook-handler";
import { processInbound } from "@/features/inbox/services/normalizer";
import { applyMessageStatusUpdate } from "@/features/inbox/services/message-status";
import {
  checkRateLimits,
  notifyRateLimited,
} from "@/features/inbox/services/cost-tracker";
import {
  upsertBatch,
  processNextBatch,
} from "@/features/inbox/services/buffer";
import {
  storeBase64Media,
  patchMessageMedia,
} from "@/features/inbox/services/media-handler";
import {
  transcribeAudio,
  describeImage,
} from "@/features/inbox/services/media-understanding";

// Webhook de Evolution API (WhatsApp no oficial via Baileys). Mismo pipeline
// que el webhook de YCloud: resolver workspace → autenticar → normalizar →
// processInbound → buffer → fast-path. Diferencias:
//   - Auth por token secreto (?token= o header x-webhook-token) en vez de HMAC.
//   - El media llega como base64 en el payload (webhookBase64: true), no como
//     link descargable.
//   - Routing SOLO por ?wsid (la instancia se configura con la URL completa).

export const maxDuration = 60;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await request.text();

    const wsidParam = request.nextUrl.searchParams.get("wsid");
    const tokenParam =
      request.nextUrl.searchParams.get("token") ??
      request.headers.get("x-webhook-token");

    if (!wsidParam) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const supabase = svc();

    const { data: ws } = await supabase
      .from("integrations")
      .select("workspace_id, credentials, config")
      .eq("workspace_id", wsidParam)
      .eq("provider", "evolution")
      .eq("enabled", true)
      .single();

    if (!ws) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const creds = ws.credentials as { webhook_token?: string };
    const webhookToken = creds.webhook_token;
    if (!webhookToken || !verifyEvolutionToken(tokenParam, webhookToken)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Status de mensajes salientes (ACKs de Baileys) — monotónico.
    const statusUpdate = parseEvolutionStatusUpdate(body);
    if (statusUpdate) {
      await applyMessageStatusUpdate(
        supabase,
        statusUpdate.providerMessageId,
        statusUpdate.status,
      );
      return NextResponse.json({ received: true });
    }

    const parsed = parseEvolutionInbound(body);
    if (!parsed) {
      // Evento no procesable (connection.update, fromMe, grupos, etc.)
      return NextResponse.json({ received: true });
    }

    const { normalized, mediaBase64 } = parsed;
    const workspaceId = ws.workspace_id as string;

    const { contact, conversation, message } = await processInbound(
      workspaceId,
      normalized,
    );

    // Id de mensaje duplicado — ya procesado
    if (!message) {
      return NextResponse.json({ received: true, dedup: true });
    }

    // Media por base64: guardar + entender (transcripción / descripción) antes
    // de que el batch se consolide, igual que el flujo YCloud.
    const messageId = message.id;
    const conversationId = conversation.id;
    const mediaJob =
      mediaBase64 && normalized.type !== "text"
        ? async () => {
            try {
              const mediaMeta = await storeBase64Media({
                base64: mediaBase64,
                workspaceId,
                conversationId,
                mimeType: normalized.mediaMime ?? undefined,
                filename: normalized.mediaFilename ?? undefined,
                caption:
                  normalized.text && normalized.text !== "[Multimedia]"
                    ? normalized.text
                    : undefined,
              });
              if (!mediaMeta) return;

              if (normalized.type === "audio") {
                const transcript = await transcribeAudio({
                  storagePath: mediaMeta.storage_path,
                  mimeType: mediaMeta.mime_type,
                  workspaceId,
                });
                if (transcript) mediaMeta.transcript = transcript;
              } else if (normalized.type === "image") {
                const description = await describeImage({
                  storagePath: mediaMeta.storage_path,
                  mimeType: mediaMeta.mime_type,
                  caption: mediaMeta.caption,
                  workspaceId,
                });
                if (description) mediaMeta.description = description;
              }

              await patchMessageMedia(workspaceId, messageId, mediaMeta);
            } catch (mediaErr) {
              console.error(
                "[webhook:evolution] media handling failed:",
                mediaErr instanceof Error ? mediaErr.message : "unknown",
              );
            }
          }
        : null;

    // IA apagada — igual guardamos el media para el agente humano.
    if (!conversation.ai_enabled) {
      if (mediaJob) after(mediaJob);
      return NextResponse.json({ received: true, ai: false });
    }

    const { allowed, reason, limit } = await checkRateLimits(
      workspaceId,
      contact.id,
    );
    if (!allowed) {
      // SEC-09: solo campos no sensibles en logs
      console.warn("[webhook:evolution] rate limited:", reason ?? "unknown");
      // Deja el evento y avisa al contacto una vez, en vez de callarse.
      after(async () => {
        if (mediaJob) await mediaJob();
        if (reason) {
          await notifyRateLimited({
            workspaceId,
            conversationId: conversation.id,
            contactId: contact.id,
            reason,
            limit,
          });
        }
      });
      return NextResponse.json({ received: true, rateLimited: true });
    }

    const bufferSeconds = Number(
      (ws.config as { buffer_silence_seconds?: number }).buffer_silence_seconds,
    );
    const silenceMs =
      Number.isFinite(bufferSeconds) && bufferSeconds >= 3
        ? Math.min(bufferSeconds, 120) * 1000
        : undefined;

    await upsertBatch({
      workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
      silenceMs,
    });

    // Fast-path best-effort (el cron cada minuto es el fallback).
    const effectiveSilenceMs = silenceMs ?? 30_000;
    after(async () => {
      if (mediaJob) await mediaJob();
      await new Promise((resolve) =>
        setTimeout(resolve, effectiveSilenceMs + 500),
      );
      try {
        await processNextBatch();
      } catch (e) {
        console.error(
          "[webhook:evolution] fast-path process error:",
          e instanceof Error ? e.message : "unknown",
        );
      }
    });

    return NextResponse.json({ received: true, buffered: true });
  } catch (err) {
    // SEC-09: nunca loguear el error completo (puede traer payloads crudos)
    console.error(
      "[webhook:evolution] unhandled error:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
