import { createClient as createSbClient } from "@supabase/supabase-js";
import { generateWithTools, getWorkspaceModel } from "./openrouter";
import { recordLlmUsage } from "./cost-tracker";
import { dispatchText } from "./dispatch";
import { decide } from "./decision-engine";
import type { ToolContext } from "@/features/tools/core/tool";
import { resolveSystemPrompt } from "./prompt-resolver";
import { buildSystemPrompt } from "./prompt-builder";
import { getActiveAgent } from "@/features/agents/services/active-agent";
import { maybeAutoProcess } from "@/features/agents/services/auto-tagging";
import {
  getBusinessInfo,
  buildBusinessInfoContext,
  buildNowContext,
} from "./business-info";
import {
  searchKb,
  formatKbContext,
  listKbSourceLinks,
  formatKbReferenceLinks,
} from "./kb-service";
import { enforceCostPolicy, buildCostAwareSystemPrompt } from "./cost-enforcer";
import { getConversationHistory } from "./conversation-history";
import { runSetterEvaluation } from "./setter-evaluation";
import { formatInboundLine } from "./batch-formatter";

const DEFAULT_SILENCE_MS = 30_000; // 30 seconds silence window
const MAX_BATCH_RETRIES = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────────────

interface MessageBatch {
  id: string;
  workspace_id: string;
  conversation_id: string;
  status: "buffering" | "flushed" | "processing" | "cancelled";
  silence_ms: number;
  flush_at: string;
  message_count: number;
  merged_text: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface BatchMessage {
  id: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  type: string;
  created_at: string;
}

interface Integration {
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface ProcessBatchResult {
  processed: boolean;
  conversationId?: string;
  error?: string;
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

    // ── 6b. Resolve conversational memory window (WS2: configurable) ─────────
    // The YCloud integration config carries message_history_window; clamp to
    // [5, 50] and default to 10 when unset or non-numeric.
    const { data: ycloudCfg } = await supabase
      .from("integrations")
      .select("config")
      .eq("workspace_id", batch.workspace_id)
      .eq("provider", "ycloud")
      .eq("enabled", true)
      .maybeSingle();
    const rawWindow = Number(
      (ycloudCfg?.config as { message_history_window?: number } | null)
        ?.message_history_window,
    );
    const historyWindow = Number.isFinite(rawWindow)
      ? Math.min(50, Math.max(5, rawWindow))
      : 10;

    // ── 6c. Load prior conversation turns (WS1: memory injection) ────────────
    const history = await getConversationHistory(batch.conversation_id, {
      limit: historyWindow,
      excludeBatchId: batch.id,
    });

    // ── 7. Build system prompt: KB > custom prompt > business info (F7) ──────
    // The active agent (if any) selects its mode-scoped published prompt; the
    // resolver falls back to the global prompt when there is no active agent.
    const activeAgent = await getActiveAgent(batch.workspace_id);
    const [resolvedPrompt, businessInfo, kbResults, kbLinks] =
      await Promise.all([
        resolveSystemPrompt(
          batch.workspace_id,
          activeAgent ? { mode: activeAgent.type } : {},
        ),
        getBusinessInfo(batch.workspace_id),
        searchKb(batch.workspace_id, mergedText, 3),
        listKbSourceLinks(batch.workspace_id),
      ]);

    const kbContext = [
      formatKbContext(kbResults),
      formatKbReferenceLinks(kbLinks),
    ]
      .filter(Boolean)
      .join("\n\n");
    const bizContext = buildBusinessInfoContext(businessInfo);
    const promptBase =
      resolvedPrompt?.body ??
      "Eres un asistente de WhatsApp. Responde de forma concisa y útil en español.";
    const structured = businessInfo?.structured as {
      timezone?: string;
      name?: string;
    } | null;
    const tz = structured?.timezone ?? "America/Mexico_City";
    // WS1: surface the rolling conversation summary so the model keeps long-term
    // context beyond the recent-message window.
    const summary =
      typeof conversation.summary === "string"
        ? conversation.summary.trim()
        : "";
    // Canonical assembly (shared with the test-chat playground) — includes the
    // response style, KB and the strict rules/restrictions guardrails.
    const fullSystemPrompt = buildSystemPrompt({
      nowContext: buildNowContext(tz),
      bizContext,
      promptBase,
      summary,
      kbContext,
      responseStyle: activeAgent?.config.responseStyle ?? null,
      guardrails: resolvedPrompt?.guardrails ?? null,
      vars: {
        agentName: activeAgent?.name ?? null,
        businessName: structured?.name ?? null,
        contactName: null,
      },
    });

    // ── 7b. SEC-06: enforce cost policy before calling LLM ───────────────────
    const costPolicy = await enforceCostPolicy(batch.workspace_id);
    const { systemPrompt: finalSystemPrompt, model: costModel } =
      await buildCostAwareSystemPrompt(
        batch.workspace_id,
        fullSystemPrompt,
        costPolicy.policy,
      );

    if (costPolicy.policy === "cut") {
      console.warn(
        "[buffer] SEC-06 cost cut — aborting AI for workspace",
        batch.workspace_id,
      );
      await markBatchProcessed(batch.id, mergedText, supabase);
      return { processed: true, conversationId: batch.conversation_id };
    }

    // ── 8. Generate AI reply with tool-calling support ───────────────────────
    // Resolve workspace model (falls back to env default or gpt-4o-mini).
    // costModel from SEC-06 takes priority when cost policy is degraded.
    const workspaceModel = await getWorkspaceModel(batch.workspace_id);
    const model = costModel ?? workspaceModel;

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

    // ── 9. Load YCloud integration credentials ──────────────────────────────
    const { data: integration, error: intError } = await supabase
      .from("integrations")
      .select("credentials, config")
      .eq("workspace_id", batch.workspace_id)
      .eq("provider", "ycloud")
      .eq("enabled", true)
      .single();

    if (intError || !integration) {
      throw new Error(`YCloud integration not found: ${intError?.message}`);
    }

    // ── 10a. Dispatch via single exit point (SEC-04) ────────────────────────
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
