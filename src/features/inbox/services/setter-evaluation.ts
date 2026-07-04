// F1: Setter qualification — extraído de buffer.ts (refactor de la regla de
// 500 líneas del Forge). Comportamiento idéntico: scoring del lead con el
// setter engine y, al calificar, ejecución del post_action configurado.
// Dormant sin setter_config habilitado. NUNCA lanza hacia el batch path.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { dispatchTemplate } from "./dispatch";
import { applyTransition } from "./decision-engine";
import { getSetterConfig, evaluateLead } from "./setter";
import { syncContactToHL, createHLOpportunity } from "./highlevel-client";
import type { ConversationTurn } from "./conversation-history";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface SetterEvalParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  history: ConversationTurn[];
  mergedText: string;
}

export async function runSetterEvaluation(
  params: SetterEvalParams,
): Promise<void> {
  const { workspaceId, conversationId, contactId, history, mergedText } =
    params;
  const supabase = svc();

  try {
    const cfg = await getSetterConfig(workspaceId);
    if (!cfg) return; // no enabled setter config → dormant

    // Load contact for the idempotency guard + tag merge in one read.
    const { data: contactRow } = await supabase
      .from("contacts")
      .select("tags, custom_fields, stage")
      .eq("id", contactId)
      .maybeSingle();

    const customFields =
      (contactRow?.custom_fields as Record<string, unknown> | null) ?? {};

    // Idempotency: stop re-evaluating once the lead reached a terminal outcome.
    if (
      customFields.lead_qualified === true ||
      customFields.setter_knocked_out === true
    ) {
      return;
    }

    // Cost debounce: re-evaluate at most every 2 user turns (always the first
    // time). Bounds setter LLM spend on chatty leads that haven't qualified yet
    // — the setter path is not gated by the main reply's rate/cost limits.
    const userTurns = history.filter((t) => t.role === "user").length + 1;
    const lastEvalTurns =
      typeof customFields.setter_eval_turns === "number"
        ? customFields.setter_eval_turns
        : 0;
    if (lastEvalTurns > 0 && userTurns - lastEvalTurns < 2) return;

    // Build the transcript string from the already-loaded history + current turn.
    const transcript =
      history.map((t) => `${t.role}: ${t.content}`).join("\n") +
      `\nuser: ${mergedText}`;

    const evaluation = await evaluateLead(cfg, transcript);

    // Persist score/qualified/summary on the contact (no migration needed).
    const nextCustomFields = {
      ...customFields,
      lead_score: evaluation.score,
      lead_qualified: evaluation.qualified,
      lead_summary: evaluation.summary,
      setter_knocked_out: evaluation.knocked_out,
      setter_knockout_reason: evaluation.knockout_reason ?? null,
      setter_config_id: cfg.id,
      setter_evaluated_at: new Date().toISOString(),
      setter_eval_turns: userTurns,
    };

    const update: Record<string, unknown> = { custom_fields: nextCustomFields };
    // Move the CRM stage on a terminal outcome — but never downgrade a customer.
    const currentStage = contactRow?.stage as string | undefined;
    if (currentStage !== "customer") {
      if (evaluation.knocked_out) update.stage = "lost";
      else if (evaluation.qualified) update.stage = "qualified";
    }
    await supabase.from("contacts").update(update).eq("id", contactId);

    // Observability event (surfaces in the conversation timeline).
    await supabase.from("events").insert({
      type: "setter_evaluation",
      level: evaluation.knocked_out ? "warn" : "info",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      payload: {
        score: evaluation.score,
        qualified: evaluation.qualified,
        knocked_out: evaluation.knocked_out,
        knockout_reason: evaluation.knockout_reason ?? null,
        summary: evaluation.summary,
        config_id: cfg.id,
        contact_id: contactId,
        post_action_type: (cfg.post_action as { type?: string }).type ?? null,
      },
    });

    // Execute the post_action only for a qualified lead (the configured "win"
    // action). Knocked-out leads are marked 'lost' above; we do not fire the
    // qualify-action on them.
    if (evaluation.qualified) {
      await executeSetterPostAction({
        postAction: cfg.post_action,
        workspaceId,
        conversationId,
        contactId,
        existingTags: Array.isArray(contactRow?.tags)
          ? (contactRow.tags as string[])
          : [],
        supabase,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[setter] runSetterEvaluation error:", msg);
    await supabase
      .from("events")
      .insert({
        type: "setter_evaluation",
        level: "error",
        workspace_id: workspaceId,
        conversation_id: conversationId,
        payload: { error: msg, contact_id: contactId },
      })
      .then(
        () => {},
        () => {},
      );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// executeSetterPostAction (private)
// Runs the configured post_action for a qualified lead. Reuses existing
// executors; create_hl_opportunity is stubbed (logs a pending event) until HL
// pipeline/stage config exists.
// ──────────────────────────────────────────────────────────────────────────────

interface PostActionParams {
  postAction: Record<string, unknown>;
  workspaceId: string;
  conversationId: string;
  contactId: string;
  existingTags: string[];
  supabase: ReturnType<typeof svc>;
}

async function executeSetterPostAction(p: PostActionParams): Promise<void> {
  const type = typeof p.postAction.type === "string" ? p.postAction.type : null;
  if (!type) return;

  try {
    switch (type) {
      case "handoff": {
        // handoff_pending sets ai_enabled=false; only valid from ai_active.
        try {
          await applyTransition(p.conversationId, "handoff_pending");
        } catch (e) {
          console.warn(
            "[setter] handoff skipped:",
            e instanceof Error ? e.message : e,
          );
        }
        break;
      }

      case "add_tag": {
        const tag =
          typeof p.postAction.tag === "string" ? p.postAction.tag.trim() : "";
        if (!tag) break;
        const merged = Array.from(new Set([...p.existingTags, tag]));
        await p.supabase
          .from("contacts")
          .update({ tags: merged })
          .eq("id", p.contactId);
        // Best-effort push to HighLevel (no-op if HL not connected).
        void syncContactToHL(p.workspaceId, p.contactId);
        break;
      }

      case "send_template": {
        const templateName =
          typeof p.postAction.template_name === "string"
            ? p.postAction.template_name
            : "";
        if (!templateName) break;
        await dispatchTemplate({
          workspaceId: p.workspaceId,
          conversationId: p.conversationId,
          templateName,
          templateLanguage: "es",
        });
        break;
      }

      case "create_hl_opportunity": {
        // Creates the opportunity in the workspace's configured HL pipeline/stage.
        // Returns null when HL isn't connected or pipeline/stage is unconfigured.
        const result = await createHLOpportunity(p.workspaceId, p.contactId);
        await p.supabase.from("events").insert({
          type: result ? "setter_post_action" : "setter_post_action_failed",
          level: result ? "info" : "warn",
          workspace_id: p.workspaceId,
          conversation_id: p.conversationId,
          payload: {
            action: "create_hl_opportunity",
            contact_id: p.contactId,
            ...(result
              ? { opportunity_id: result.id }
              : {
                  reason:
                    "no se pudo crear la oportunidad (revisa PIT, pipeline y etapa de HighLevel)",
                }),
          },
        });
        break;
      }
    }
  } catch (err) {
    console.error(
      "[setter] post_action error:",
      err instanceof Error ? err.message : err,
    );
  }
}
