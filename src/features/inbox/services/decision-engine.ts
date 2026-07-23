// F3-T4: Decision engine — orchestrates respond / handoff / abstain.
// Uses service-role client for DB state transitions.

import { createClient as createSbClient } from "@supabase/supabase-js";
import {
  aiShouldRespond,
  canTransition,
  detectsHandoffTrigger,
  type ConversationState,
} from "./state-machine";
import { checkRateLimits } from "./cost-tracker";
import { getEnabledTools } from "@/features/tools/services/tool-configs";
import type { Tool } from "@/features/tools/core/tool";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export type Decision = "respond" | "handoff" | "abstain" | "rate_limited";

/**
 * ¿El workspace usa el handoff automático por palabra clave? Default true (no
 * cambia el comportamiento de los que ya lo usan). Ante error de lectura, true.
 */
async function keywordHandoffEnabled(
  workspaceId: string,
  supabase: ReturnType<typeof svc>,
): Promise<boolean> {
  const { data } = await supabase
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .maybeSingle();
  const v = (data?.settings as { keyword_handoff_enabled?: boolean } | null)
    ?.keyword_handoff_enabled;
  return v !== false;
}

export interface DecisionResult {
  decision: Decision;
  reason: string;
  availableTools?: Tool[];
}

/**
 * Decides whether the AI should respond, trigger a handoff, or abstain.
 *
 * Flow:
 *   1. Load conversation state from DB
 *   2. If state !== 'ai_active' → abstain
 *   3. detectsHandoffTrigger → if true, transition to handoff_pending and log
 *   4. checkRateLimits → if exceeded, return rate_limited
 *   5. → respond
 */
export async function decide(opts: {
  workspaceId: string;
  conversationId: string;
  mergedText: string;
  contactId: string;
}): Promise<DecisionResult> {
  const { workspaceId, conversationId, mergedText, contactId } = opts;
  const supabase = svc();

  // 1. Load conversation state
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("state")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    console.error("[decision-engine] failed to load conversation:", convError);
    return { decision: "abstain", reason: "conversation_not_found" };
  }

  const currentState = conv.state as ConversationState;

  // 2. Check if AI should respond in current state
  if (!aiShouldRespond(currentState)) {
    return { decision: "abstain", reason: `state:${currentState}` };
  }

  // 3. Detect handoff trigger in message text — SOLO si el workspace lo tiene
  //    activado (workspaces.settings.keyword_handoff_enabled, default true).
  //    El matcher es un instrumento romo: frases como "hablar con un vendedor"
  //    son intención mayorista (no "quiero un humano"), y disparaban una pausa
  //    automática en la que el bot ni siquiera respondía. En clientes con
  //    derivación inteligente por tool (derivar_a_humano) conviene apagarlo y
  //    dejar que el agente decida.
  const keywordHandoff = await keywordHandoffEnabled(workspaceId, supabase);
  if (keywordHandoff && detectsHandoffTrigger(mergedText)) {
    // Validate the transition is legal before applying
    if (canTransition(currentState, "handoff_pending")) {
      const { error: updateError } = await supabase
        .from("conversations")
        .update({
          state: "handoff_pending",
          ai_enabled: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversationId);

      if (updateError) {
        console.error(
          "[decision-engine] failed to transition to handoff_pending:",
          updateError,
        );
      } else {
        // Log the state change to events
        await supabase.from("events").insert({
          type: "state_change",
          level: "info",
          workspace_id: workspaceId,
          conversation_id: conversationId,
          payload: {
            from: currentState,
            to: "handoff_pending",
            trigger: "keyword",
            actor: "system",
          },
        });
      }
    }

    return { decision: "handoff", reason: "handoff_trigger" };
  }

  // 4. Rate limit check
  const { allowed, reason: rateLimitReason } = await checkRateLimits(
    workspaceId,
    contactId,
  );

  if (!allowed) {
    return {
      decision: "rate_limited",
      reason: rateLimitReason ?? "rate_limited",
    };
  }

  // 5. All checks passed — load enabled tools and respond
  const availableTools = await getEnabledTools(workspaceId);
  return { decision: "respond", reason: "normal", availableTools };
}

/**
 * Applies a validated state transition to a conversation.
 * Logs the transition to the events table.
 * If transitioning to human_active and userId is provided, sets assigned_to.
 */
export async function applyTransition(
  conversationId: string,
  to: ConversationState,
  userId?: string,
): Promise<void> {
  const supabase = svc();

  // 1. Load current state
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("state, workspace_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) {
    throw new Error(
      `[decision-engine] conversation not found: ${convError?.message}`,
    );
  }

  const currentState = conv.state as ConversationState;

  // 2. Validate transition (throws TransitionError if invalid)
  if (!canTransition(currentState, to)) {
    const { TransitionError } = await import("./state-machine");
    throw new TransitionError(currentState, to);
  }

  // 3. Build the update payload
  const updatePayload: Record<string, unknown> = {
    state: to,
    ai_enabled: to === "ai_active",
    updated_at: new Date().toISOString(),
  };

  if (to === "human_active" && userId) {
    updatePayload.assigned_to = userId;
  }

  const { error: updateError } = await supabase
    .from("conversations")
    .update(updatePayload)
    .eq("id", conversationId);

  if (updateError) {
    throw new Error(
      `[decision-engine] failed to apply transition: ${updateError.message}`,
    );
  }

  // 4. Log the state change to events
  await supabase.from("events").insert({
    type: "state_change",
    level: "info",
    workspace_id: conv.workspace_id,
    conversation_id: conversationId,
    payload: {
      from: currentState,
      to,
      actor: userId ?? "system",
    },
  });
}
