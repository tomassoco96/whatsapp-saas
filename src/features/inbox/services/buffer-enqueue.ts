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
// Creates a new buffering batch for a conversation, or extends an existing one.
// On extend: push flush_at forward by silence_ms, increment message_count, link msg.
// On create: insert batch, then link message.
// Returns the batch ID.
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

  // 1. Look for an active buffering batch for this conversation
  const { data: existing } = await supabase
    .from("message_batches")
    .select("id, message_count, flush_at")
    .eq("workspace_id", workspaceId)
    .eq("conversation_id", conversationId)
    .eq("status", "buffering")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let batchId: string;

  if (existing) {
    // Extend: push flush_at forward and increment count
    const newFlushAt = new Date(Date.now() + silenceMs).toISOString();
    const { error: updateError } = await supabase
      .from("message_batches")
      .update({
        flush_at: newFlushAt,
        message_count: existing.message_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("status", "buffering"); // Guard: only extend if still buffering

    if (updateError) {
      console.error("[buffer] extend batch error:", updateError);
      throw new Error(`Failed to extend batch: ${updateError.message}`);
    }

    batchId = existing.id as string;
  } else {
    // Create a new buffering batch
    const flushAt = new Date(Date.now() + silenceMs).toISOString();
    const { data: created, error: insertError } = await supabase
      .from("message_batches")
      .insert({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        status: "buffering",
        silence_ms: silenceMs,
        flush_at: flushAt,
        message_count: 1,
        meta: {},
      })
      .select("id")
      .single();

    if (insertError || !created) {
      console.error("[buffer] create batch error:", insertError);
      throw new Error(`Failed to create batch: ${insertError?.message}`);
    }

    batchId = created.id as string;
  }

  // 2. Link the message to the batch
  const { error: linkError } = await supabase
    .from("messages")
    .update({ batch_id: batchId })
    .eq("id", messageId);

  if (linkError) {
    // Non-fatal: batch still works; log and continue
    console.warn("[buffer] failed to link message to batch:", linkError);
  }

  return batchId;
}
