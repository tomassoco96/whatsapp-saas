// buffer-enqueue.ts — encolado de mensajes entrantes en batches (ráfagas).
// Extraído de buffer.ts sin cambios de comportamiento.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { DEFAULT_SILENCE_MS } from "./buffer-types";

// ──────────────────────────────────────────────────────────────────────────────
// Service-role Supabase client — only used inside services/, never in routes
// ──────────────────────────────────────────────────────────────────────────────
function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// upsertBatch
// Crea o extiende, de forma ATÓMICA, el batch abierto (buffering) de una
// conversación, vía el RPC upsert_batch. El RPC + el índice único parcial
// (uq_batches_one_buffering) garantizan a lo sumo UN batch buffering por
// conversación, incluso con webhooks concurrentes de una misma ráfaga — antes
// era un SELECT-then-INSERT que dejaba esa race abierta (dos batches → dos
// respuestas al mismo turno). Devuelve el batch ID.
// ──────────────────────────────────────────────────────────────────────────────
export async function upsertBatch(opts: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  silenceMs?: number;
}): Promise<string> {
  const {
    workspaceId,
    conversationId,
    messageId,
    silenceMs = DEFAULT_SILENCE_MS,
  } = opts;
  const supabase = svc();

  // 1. Crear/extender el batch de forma atómica.
  const { data: batchId, error } = await supabase.rpc("upsert_batch", {
    p_workspace_id: workspaceId,
    p_conversation_id: conversationId,
    p_silence_ms: silenceMs,
  });

  if (error || !batchId) {
    console.error("[buffer] upsert_batch RPC error:", error);
    throw new Error(`Failed to upsert batch: ${error?.message}`);
  }

  // 2. Linkear el mensaje al batch (no fatal si falla: se loguea y sigue).
  const { error: linkError } = await supabase
    .from("messages")
    .update({ batch_id: batchId as string })
    .eq("id", messageId);

  if (linkError) {
    console.warn("[buffer] failed to link message to batch:", linkError);
  }

  return batchId as string;
}
