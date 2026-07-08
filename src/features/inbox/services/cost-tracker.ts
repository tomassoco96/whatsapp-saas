import { createClient as createSbClient } from "@supabase/supabase-js";
import { performance } from "node:perf_hooks";

// Techos por defecto. Protegen contra un loop descontrolado, no contra el gasto
// normal (a precio blended, un turno ronda los centavos). Se pueden subir por
// workspace en `workspaces.settings.limits` — util en la etapa de pruebas con
// el cliente, donde se le pide explicitamente que "mate al bot".
const DEFAULT_TURNS_PER_CONTACT_PER_HOUR = 20;
const DEFAULT_DAILY_BUDGET_TOKENS = 1_000_000;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

interface RecordLlmUsageOpts {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Inserts an llm_usage event into the events table for observability and
 * rate-limit accounting.
 */
export async function recordLlmUsage(opts: RecordLlmUsageOpts): Promise<void> {
  const supabase = svc();

  const {
    workspaceId,
    conversationId,
    contactId,
    model,
    promptTokens,
    completionTokens,
  } = opts;

  const totalTokens = promptTokens + completionTokens;

  await supabase.from("events").insert({
    type: "llm_usage",
    level: "info",
    workspace_id: workspaceId,
    conversation_id: conversationId,
    payload: {
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      contact_id: contactId,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Limites por workspace
// ──────────────────────────────────────────────────────────────────────────────

export interface WorkspaceLimits {
  turnsPerContactPerHour: number;
  dailyBudgetTokens: number;
}

export const DEFAULT_LIMITS: WorkspaceLimits = {
  turnsPerContactPerHour: DEFAULT_TURNS_PER_CONTACT_PER_HOUR,
  dailyBudgetTokens: DEFAULT_DAILY_BUDGET_TOKENS,
};

/** Un override solo cuenta si es un entero positivo; cualquier basura cae al default. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/**
 * Lee los limites del workspace desde `workspaces.settings.limits`:
 *   { "llm_turns_per_contact_per_hour": 60, "llm_daily_budget_tokens": 5000000 }
 * Ante ausencia o error devuelve los defaults (fail-open: nunca endurece el
 * limite por un problema de lectura).
 */
export async function getWorkspaceLimits(
  workspaceId: string,
  supabase: ReturnType<typeof svc> = svc(),
): Promise<WorkspaceLimits> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error || !data) return DEFAULT_LIMITS;

  const limits = (data.settings as { limits?: Record<string, unknown> } | null)
    ?.limits;
  if (!limits) return DEFAULT_LIMITS;

  return {
    turnsPerContactPerHour: positiveInt(
      limits.llm_turns_per_contact_per_hour,
      DEFAULT_TURNS_PER_CONTACT_PER_HOUR,
    ),
    dailyBudgetTokens: positiveInt(
      limits.llm_daily_budget_tokens,
      DEFAULT_DAILY_BUDGET_TOKENS,
    ),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// checkRateLimits
// ──────────────────────────────────────────────────────────────────────────────

export type RateLimitReason =
  | "rate_limit_contact_hour"
  | "daily_token_budget_exceeded";

export interface RateLimitResult {
  allowed: boolean;
  reason?: RateLimitReason;
  /** Techo que se alcanzo (turnos u tokens, segun `reason`). Para el evento. */
  limit?: number;
}

/**
 * Checks per-contact hourly turn limit and workspace daily token budget.
 *
 * Returns { allowed: false, reason, limit } when either ceiling is breached,
 * { allowed: true } otherwise. Nunca lanza: ante error de DB deja pasar.
 */
export async function checkRateLimits(
  workspaceId: string,
  contactId: string,
): Promise<RateLimitResult> {
  const supabase = svc();

  const limits = await getWorkspaceLimits(workspaceId, supabase);
  const nowMs = performance.timeOrigin + performance.now();

  // ── 1. Per-contact hourly turn limit ──────────────────────────────────────
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();

  const { data: hourlyEvents, error: hourlyError } = await supabase
    .from("events")
    .select("id")
    .eq("type", "llm_usage")
    .eq("workspace_id", workspaceId)
    .filter("payload->>contact_id", "eq", contactId)
    .gte("created_at", hourAgo);

  if (hourlyError) {
    console.error("[cost-tracker] hourly check error:", hourlyError);
    // Fail open — don't block on DB errors
    return { allowed: true };
  }

  if ((hourlyEvents?.length ?? 0) >= limits.turnsPerContactPerHour) {
    return {
      allowed: false,
      reason: "rate_limit_contact_hour",
      limit: limits.turnsPerContactPerHour,
    };
  }

  // ── 2. Workspace daily token budget ───────────────────────────────────────
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);

  const { data: dailyEvents, error: dailyError } = await supabase
    .from("events")
    .select("payload")
    .eq("type", "llm_usage")
    .eq("workspace_id", workspaceId)
    .gte("created_at", dayStart.toISOString());

  if (dailyError) {
    console.error("[cost-tracker] daily check error:", dailyError);
    return { allowed: true };
  }

  const totalTokensToday = (dailyEvents ?? []).reduce((sum, row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const t = payload?.total_tokens;
    return sum + (typeof t === "number" ? t : 0);
  }, 0);

  if (totalTokensToday >= limits.dailyBudgetTokens) {
    return {
      allowed: false,
      reason: "daily_token_budget_exceeded",
      limit: limits.dailyBudgetTokens,
    };
  }

  return { allowed: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// Notificacion del bloqueo
//
// Sin esto el bot se calla en silencio: el webhook devuelve 200, no queda rastro
// en la base y el cliente lo lee como "se colgo". Dejamos SIEMPRE un evento
// (engancha con las alertas de salud) y le avisamos al contacto UNA sola vez por
// ventana, con texto fijo — no cuesta LLM.
// ──────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT_MESSAGES: Record<RateLimitReason, string> = {
  rate_limit_contact_hour:
    "Perdon, estoy con muchas consultas en este momento. Dame unos minutos y seguimos.",
  daily_token_budget_exceeded:
    "Perdon, tengo una demora tecnica. En un rato retomo la conversacion.",
};

/** Inicio de la ventana en la que no se repite el aviso al contacto. */
function windowStart(reason: RateLimitReason, nowMs: number): string {
  if (reason === "rate_limit_contact_hour") {
    return new Date(nowMs - 3_600_000).toISOString();
  }
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  return dayStart.toISOString();
}

export interface NotifyRateLimitedParams {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  reason: RateLimitReason;
  limit?: number;
}

/**
 * Registra el bloqueo y, si es el primero de la ventana, le avisa al contacto.
 * Best-effort: cualquier fallo se traga (nunca rompe el webhook).
 *
 * Devuelve true si se le envio el aviso al contacto.
 */
export async function notifyRateLimited(
  params: NotifyRateLimitedParams,
): Promise<boolean> {
  const { workspaceId, conversationId, contactId, reason, limit } = params;

  try {
    const supabase = svc();
    const nowMs = performance.timeOrigin + performance.now();

    // Observabilidad: siempre queda el evento, aunque no se avise al contacto.
    await supabase.from("events").insert({
      type: "rate_limited",
      level: "warn",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      payload: { reason, limit: limit ?? null, contact_id: contactId },
    });

    // Aviso al contacto: una sola vez por ventana.
    const { data: alreadyNotified } = await supabase
      .from("events")
      .select("id")
      .eq("type", "rate_limit_notified")
      .eq("workspace_id", workspaceId)
      .filter("payload->>contact_id", "eq", contactId)
      .gte("created_at", windowStart(reason, nowMs))
      .limit(1);

    if (alreadyNotified && alreadyNotified.length > 0) return false;

    // Import diferido: dispatch arrastra los clientes de canal, y este modulo
    // lo importa el webhook en el camino caliente.
    const { dispatchText } = await import("./dispatch");
    const sent = await dispatchText({
      workspaceId,
      conversationId,
      body: RATE_LIMIT_MESSAGES[reason],
    });
    if (!sent.ok) return false;

    await supabase.from("events").insert({
      type: "rate_limit_notified",
      level: "info",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      payload: { reason, contact_id: contactId },
    });
    return true;
  } catch (err) {
    console.error(
      "[cost-tracker] notifyRateLimited error:",
      err instanceof Error ? err.message : "unknown",
    );
    return false;
  }
}
