// F7: Setter mode — knockout qualification + scoring via structured LLM evaluation.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function getModel() {
  const openai = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY!,
    headers: {
      "HTTP-Referer":
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-Title": "Agente WhatsApp",
    },
  });
  // Use haiku-class model for structured outputs — cost-efficient.
  // OpenRouter only supports Chat Completions; force .chat() (the provider's
  // default callable uses the OpenAI Responses API, which OpenRouter rejects).
  return openai.chat(
    process.env.OPENROUTER_SETTER_MODEL ?? "openai/gpt-4o-mini",
  );
}

export interface SetterQuestion {
  id: string;
  text: string;
  type: string;
  weight: number;
}

export interface KnockoutRule {
  question_id: string;
  condition: string;
  action: string;
}

export interface SetterConfig {
  id: string;
  name: string;
  enabled: boolean;
  questions: SetterQuestion[];
  knockout_rules: KnockoutRule[];
  scoring: { threshold: number; max_score: number };
  post_action: Record<string, unknown>;
}

const EvalSchema = z.object({
  score: z.number().min(0).max(100),
  qualified: z.boolean(),
  summary: z.string().describe("2-3 sentence summary of the lead"),
  knocked_out: z.boolean(),
  // Nullable (not optional): OpenAI strict structured-output requires every
  // property to be in `required`; an optional field is rejected by the provider
  // ("'required' ... must include every key"). Use null when not knocked out.
  knockout_reason: z
    .string()
    .nullable()
    .describe("Reason if knocked out, else null"),
});

export type SetterEvaluation = z.infer<typeof EvalSchema>;

/**
 * Loads the active setter config for a workspace.
 * Returns null when no enabled config exists.
 */
export async function getSetterConfig(
  workspaceId: string,
): Promise<SetterConfig | null> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("setter_configs")
    .select(
      "id, name, enabled, questions, knockout_rules, scoring, post_action",
    )
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[setter] getSetterConfig error:", error);
    return null;
  }

  if (!data) return null;

  return {
    id: data.id as string,
    name: data.name as string,
    enabled: data.enabled as boolean,
    questions: (data.questions as SetterQuestion[]) ?? [],
    knockout_rules: (data.knockout_rules as KnockoutRule[]) ?? [],
    scoring: (data.scoring as { threshold: number; max_score: number }) ?? {
      threshold: 50,
      max_score: 100,
    },
    post_action: (data.post_action as Record<string, unknown>) ?? {},
  };
}

/**
 * Evaluates a lead based on the setter config and conversation history.
 * Uses generateObject for structured, type-safe scoring — never parses raw text.
 */
export async function evaluateLead(
  config: SetterConfig,
  conversationHistory: string,
): Promise<SetterEvaluation> {
  const questionsBlock = config.questions
    .map((q) => `- [${q.id}] ${q.text} (weight: ${q.weight}, type: ${q.type})`)
    .join("\n");

  const knockoutBlock = config.knockout_rules
    .map((r) => `- Question ${r.question_id}: if ${r.condition} → ${r.action}`)
    .join("\n");

  const prompt = `You are a sales qualification evaluator.

## Qualification Questions
${questionsBlock}

## Knockout Rules
${knockoutBlock}

## Scoring
- Threshold to qualify: ${config.scoring.threshold} / ${config.scoring.max_score}

## Conversation to Evaluate
${conversationHistory}

Evaluate the conversation against the qualification questions and knockout rules.
Compute a weighted score (0-100).

CRITICAL — what a knockout is and is NOT:
A knockout means the lead is DISQUALIFIED FOREVER. Only set knocked_out=true when
the conversation shows POSITIVE EVIDENCE of disqualification: the lead explicitly
refuses to provide the information, says they do not have it, or gives an answer
that violates the rule.

Information that is simply MISSING — because the agent has not asked yet, or the
conversation is still early — is NOT a knockout. An empty answer to a question
nobody asked means "unknown", not "disqualified". In that case set
knocked_out=false and let the low score reflect the missing data.

Example: the whole conversation is "user: Hola" → knocked_out MUST be false.

Return a structured evaluation.`;

  const { object } = await generateObject({
    model: getModel(),
    schema: EvalSchema,
    prompt,
  });

  // Defensa determinista contra un knockout prematuro del evaluador: para
  // descalificar hace falta que el lead haya dicho algo descalificante, y con un
  // solo turno del usuario (tipico "Hola") no pudo hacerlo. El scoring bajo ya
  // refleja la falta de datos; marcar knocked_out es TERMINAL (stage='lost' y no
  // se vuelve a evaluar nunca), asi que nunca se decide con un turno.
  const userTurns = (conversationHistory.match(/^user:/gm) ?? []).length;
  const knockedOut = userTurns >= 2 ? object.knocked_out : false;

  // Reconcile: a knocked-out lead cannot be qualified
  return {
    ...object,
    knocked_out: knockedOut,
    knockout_reason: knockedOut ? object.knockout_reason : null,
    qualified: knockedOut ? false : object.score >= config.scoring.threshold,
  };
}
