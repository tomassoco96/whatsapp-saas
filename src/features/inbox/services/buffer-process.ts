// buffer-process.ts — drenado de batches: claim atómico, consolidación,
// decision engine, llamada a la IA, envío y dead-letter.
// Extraído de buffer.ts sin cambios de comportamiento.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { generateWithTools } from "./openrouter";
import { recordLlmUsage } from "./cost-tracker";
import { dispatchText } from "./dispatch";
import { decide } from "./decision-engine";
import type { ToolContext } from "@/features/tools/core/tool";
import { maybeAutoProcess } from "@/features/agents/services/auto-tagging";
import { runSetterEvaluation } from "./setter-evaluation";
import { formatInboundLine } from "./batch-formatter";
import { buildReplyContext } from "./buffer-context";
import {
  MAX_BATCH_RETRIES,
  type BatchMessage,
  type MessageBatch,
  type ProcessBatchResult,
} from "./buffer-types";

// NOTA: interfaz sin referencias, preservada tal cual estaba en buffer.ts
// (código muerto candidato — ver followups del refactor, no borrar acá).
interface Integration {
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

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
// consolidateBatch (private)
// Fetches all inbound messages for a batch and joins them into a single string.
// Audio transcripts / image captions use media->>'transcript' / media->>'caption'
// when present; otherwise falls back to body text. (Multi-modal extended in F8.)
// ──────────────────────────────────────────────────────────────────────────────
async function consolidateBatch(
  batchId: string,
  supabase: ReturnType<typeof svc>,
): Promise<string> {
  const { data: msgs, error } = await supabase
    .from("messages")
    .select("id, body, meta, type, created_at")
    .eq("batch_id", batchId)
    .eq("direction", "in")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`[buffer] consolidateBatch fetch error: ${error.message}`);
  }

  return (msgs as BatchMessage[]).map(formatInboundLine).join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// processNextBatch (exported)
// Called by the cron job (/api/cron/buffer-flush) or the internal trigger.
//
// Flow:
//   1. claim_next_batch() RPC — atomic, uses FOR UPDATE SKIP LOCKED
//   2. No batch available → return { processed: false }
//   3. consolidateBatch → mergedText
//   4. Load conversation (ai_enabled, workspace_id, contact info)
//   5. checkRateLimits
//   6. generateReply with consolidated text
//   7. recordLlmUsage
//   8. sendText via ycloud-client (or insert dev_mode outbound)
//   9. Mark batch 'processed', persist merged_text
//  10. On error: increment retry counter; if > MAX_BATCH_RETRIES → cancel_batch()
// ──────────────────────────────────────────────────────────────────────────────
export async function processNextBatch(): Promise<ProcessBatchResult> {
  const supabase = svc();

  // ── 1. Claim one ready batch atomically ───────────────────────────────────
  const { data: claimedRows, error: claimError } =
    await supabase.rpc("claim_next_batch");

  if (claimError) {
    console.error("[buffer] claim_next_batch RPC error:", claimError);
    return { processed: false, error: claimError.message };
  }

  const batch = (claimedRows as MessageBatch[] | null)?.[0] ?? null;

  // ── 2. Nothing to process ─────────────────────────────────────────────────
  if (!batch) {
    return { processed: false };
  }

  const retryCount = (batch.meta?.retry_count as number | undefined) ?? 0;

  try {
    // ── 3. Consolidate messages into one string ──────────────────────────────
    const mergedText = await consolidateBatch(batch.id, supabase);

    // ── 4. Load conversation record ─────────────────────────────────────────
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, workspace_id, contact_id, ai_enabled, summary")
      .eq("id", batch.conversation_id)
      .single();

    if (convError || !conversation) {
      throw new Error(`Conversation not found: ${convError?.message}`);
    }

    // ── 5. Decision engine: state check + handoff trigger + rate limits ──────
    const decisionResult = await decide({
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      mergedText,
      contactId: conversation.contact_id as string,
    });

    const { decision, reason } = decisionResult;

    if (decision !== "respond") {
      console.info("[buffer] not responding:", decision, reason);
      await markBatchProcessed(batch.id, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 6. Build ToolContext (SEC-01: anchored server-side, never from client) ─
    const toolCtx: ToolContext = {
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      contactId: conversation.contact_id as string,
    };

    // ── 6b-8. Memory window + history + system prompt + cost policy + model ──
    const ctx = await buildReplyContext({
      batch,
      conversationSummary: conversation.summary,
      mergedText,
      supabase,
    });

    if (ctx.costCut) {
      console.warn(
        "[buffer] SEC-06 cost cut — aborting AI for workspace",
        batch.workspace_id,
      );
      await markBatchProcessed(batch.id, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    const { finalSystemPrompt, model, history, activeAgent } = ctx;

    // ── 8. Generate AI reply with tool-calling support ───────────────────────
    const reply = await generateWithTools({
      systemPrompt: finalSystemPrompt,
      model,
      userMessage: mergedText,
      workspaceId: batch.workspace_id,
      availableTools: decisionResult.availableTools,
      toolContext: toolCtx,
      history,
    });

    // ── 8. Record LLM usage ──────────────────────────────────────────────────
    await recordLlmUsage({
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      contactId: conversation.contact_id as string,
      model,
      promptTokens: reply.inputTokens,
      completionTokens: reply.outputTokens,
    });

    // ── 10a. Dispatch via single exit point (SEC-04) ────────────────────────
    // dispatch.ts resuelve la integración de canal (YCloud o Evolution) por
    // su cuenta — acá no se precargan credenciales.
    const dispatchResult = await dispatchText({
      workspaceId: batch.workspace_id,
      conversationId: batch.conversation_id,
      body: reply.text,
      // AI-generated: no senderUserId
    });

    if (!dispatchResult.ok) {
      console.error("[buffer] dispatchText failed:", dispatchResult.error);
    }

    // ── 10b. Mark batch as processed ────────────────────────────────────────
    await markBatchProcessed(batch.id, mergedText, supabase);

    // ── 10c. v1.5 opt-in: AI auto-tagging + summary (fire-and-forget) ────────
    if (
      activeAgent &&
      (activeAgent.config.autoTag || activeAgent.config.summarize)
    ) {
      void maybeAutoProcess({
        workspaceId: batch.workspace_id,
        conversationId: batch.conversation_id,
        contactId: conversation.contact_id as string,
        config: activeAgent.config,
      });
    }

    // ── 10d. F1: Setter qualification (only when the active agent is a setter) ─
    // The user-facing reply was already dispatched above, so this adds no latency
    // to the turn. We AWAIT it (not fire-and-forget) so the post_action reliably
    // runs even if the serverless function is frozen right after the batch. It is
    // fully try/catched internally and never throws into the batch path. Dormant
    // unless an enabled setter_config exists for the workspace.
    if (activeAgent?.type === "setter") {
      await runSetterEvaluation({
        workspaceId: batch.workspace_id,
        conversationId: batch.conversation_id,
        contactId: conversation.contact_id as string,
        history,
        mergedText,
      });
    }

    return { processed: true, conversationId: batch.conversation_id };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[buffer] processNextBatch error:", {
      batchId: batch.id,
      retryCount,
      error: errorMsg,
    });

    // ── 10. Dead-letter: increment retry or cancel ───────────────────────────
    const newRetryCount = retryCount + 1;

    if (newRetryCount > MAX_BATCH_RETRIES) {
      // Mark dead-letter via RPC
      await supabase.rpc("cancel_batch", { p_batch_id: batch.id });

      // Log to events table for observability
      await supabase.from("events").insert({
        type: "batch_dead_letter",
        level: "error",
        workspace_id: batch.workspace_id,
        conversation_id: batch.conversation_id,
        payload: {
          batch_id: batch.id,
          retry_count: newRetryCount,
          error: errorMsg,
        },
      });

      return {
        processed: false,
        conversationId: batch.conversation_id,
        error: `Batch cancelled after ${MAX_BATCH_RETRIES} retries: ${errorMsg}`,
      };
    }

    // Revert to 'buffering' with incremented retry count so it gets picked up again
    // Use a short backoff: flush_at = now + 30s * retry_count
    const backoffMs = 30_000 * newRetryCount;
    await supabase
      .from("message_batches")
      .update({
        status: "buffering",
        flush_at: new Date(Date.now() + backoffMs).toISOString(),
        updated_at: new Date().toISOString(),
        meta: {
          ...batch.meta,
          retry_count: newRetryCount,
          last_error: errorMsg,
        },
      })
      .eq("id", batch.id)
      .eq("status", "processing");

    return {
      processed: false,
      conversationId: batch.conversation_id,
      error: errorMsg,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// markBatchProcessed (private)
// Sets status = 'processed' and persists the merged_text for audit.
// ──────────────────────────────────────────────────────────────────────────────
async function markBatchProcessed(
  batchId: string,
  mergedText: string,
  supabase: ReturnType<typeof svc>,
): Promise<void> {
  const { error } = await supabase
    .from("message_batches")
    .update({
      status: "processed",
      merged_text: mergedText,
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  if (error) {
    console.error("[buffer] markBatchProcessed error:", error);
  }
}
