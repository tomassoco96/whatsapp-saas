// buffer-context.ts — armado del contexto de respuesta de la IA para un batch:
// ventana de memoria, historial, prompt de sistema (KB > prompt custom >
// business info), política de costos (SEC-06) y modelo efectivo.
// Extraído de buffer.ts sin cambios de comportamiento ni de orden de queries.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getWorkspaceModel } from "./openrouter";
import { resolveSystemPrompt } from "./prompt-resolver";
import { buildSystemPrompt } from "./prompt-builder";
import { getActiveAgent } from "@/features/agents/services/active-agent";
import type { ActiveAgent } from "@/features/agents/types";
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
import {
  getConversationHistory,
  type ConversationTurn,
} from "./conversation-history";
import type { MessageBatch } from "./buffer-types";

export type ReplyContextResult =
  | { costCut: true }
  | {
      costCut: false;
      finalSystemPrompt: string;
      model: string;
      history: ConversationTurn[];
      activeAgent: ActiveAgent | null;
    };

export async function buildReplyContext(opts: {
  batch: Pick<MessageBatch, "id" | "workspace_id" | "conversation_id">;
  /** conversations.summary — rolling long-term summary (WS1) */
  conversationSummary: unknown;
  mergedText: string;
  /** Client del proceso — reutilizado para la query de config (mismo orden que antes). */
  supabase: SupabaseClient;
}): Promise<ReplyContextResult> {
  const { batch, mergedText, supabase } = opts;

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
  const [resolvedPrompt, businessInfo, kbResults, kbLinks] = await Promise.all([
    resolveSystemPrompt(
      batch.workspace_id,
      activeAgent ? { mode: activeAgent.type } : {},
    ),
    getBusinessInfo(batch.workspace_id),
    searchKb(batch.workspace_id, mergedText, 3),
    listKbSourceLinks(batch.workspace_id),
  ]);

  const kbContext = [formatKbContext(kbResults), formatKbReferenceLinks(kbLinks)]
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
    typeof opts.conversationSummary === "string"
      ? opts.conversationSummary.trim()
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
    return { costCut: true };
  }

  // ── 8. Resolve workspace model (falls back to env default or gpt-4o-mini).
  // costModel from SEC-06 takes priority when cost policy is degraded.
  const workspaceModel = await getWorkspaceModel(batch.workspace_id);
  const model = costModel ?? workspaceModel;

  return { costCut: false, finalSystemPrompt, model, history, activeAgent };
}
