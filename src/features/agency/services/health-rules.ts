// Reglas de salud por workspace — funciones PURAS (sin red ni DB), exportadas
// para test (mismo patrón que aggregateCartMetrics / aggregateAgencyRollup).
// El fetch y la persistencia viven en health-alerts.service.ts.

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type AlertType =
  | "buffer_trabado"
  | "silencio_anomalo"
  | "gasto_llm_anomalo"
  | "errores_tools"
  | "bot_limitado";

export type AlertSeverity = "warning" | "critical";

/** Alerta que una regla propone crear/mantener para un workspace. */
export interface AlertCandidate {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  payload: Record<string, unknown>;
}

/** Fila de alerta ABIERTA ya existente en workspace_alerts (para dedupe). */
export interface OpenAlertRow {
  id: string;
  workspace_id: string;
  type: string;
  severity: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Umbrales v1
// ---------------------------------------------------------------------------

/** Batch en buffer sin procesar hace más de esto → bot mudo (critical). */
export const BUFFER_STUCK_MINUTES = 10;
/** Piso absoluto de gasto diario para alertar (evita ruido en cuentas chicas). */
export const LLM_SPEND_FLOOR_USD = 2;
export const LLM_WARN_RATIO = 3;
export const LLM_CRIT_RATIO = 6;
/** Errores de tools en la última hora para alertar. */
export const TOOL_ERRORS_THRESHOLD = 3;
/** Estimación blended USD/token — mismo valor que dashboard/services/metrics.ts. */
export const USD_PER_TOKEN = 0.000_002;

// ---------------------------------------------------------------------------
// Agregadores puros sobre filas crudas
// ---------------------------------------------------------------------------

export interface StuckBatchStats {
  stuckCount: number;
  /** Minutos del batch más viejo trabado; null si no hay trabados. */
  oldestMinutes: number | null;
}

/**
 * Batches en 'buffering' cuyo flush_at ya pasó hace más de
 * BUFFER_STUCK_MINUTES (el cron de flush debió drenarlos hace rato).
 */
export function countStuckBatches(
  rows: Array<{ flush_at: string | null; created_at?: string | null }>,
  nowMs: number,
): StuckBatchStats {
  const thresholdMs = BUFFER_STUCK_MINUTES * 60_000;
  let stuckCount = 0;
  let oldestMs: number | null = null;

  for (const row of rows) {
    const ref = row.flush_at ?? row.created_at ?? null;
    if (!ref) continue;
    const t = Date.parse(ref);
    if (!Number.isFinite(t)) continue;
    const age = nowMs - t;
    if (age > thresholdMs) {
      stuckCount++;
      if (oldestMs === null || age > oldestMs) oldestMs = age;
    }
  }

  return {
    stuckCount,
    oldestMinutes: oldestMs === null ? null : Math.floor(oldestMs / 60_000),
  };
}

export interface InboundStats {
  last7d: number;
  last24h: number;
}

/** Cuenta mensajes entrantes de los últimos 7 días y de las últimas 24 h. */
export function countInbound(
  rows: Array<{ created_at: string | null }>,
  nowMs: number,
): InboundStats {
  const dayMs = 24 * 3_600_000;
  let last7d = 0;
  let last24h = 0;
  for (const row of rows) {
    if (!row.created_at) continue;
    const t = Date.parse(row.created_at);
    if (!Number.isFinite(t)) continue;
    const age = nowMs - t;
    if (age <= 7 * dayMs) {
      last7d++;
      if (age <= dayMs) last24h++;
    }
  }
  return { last7d, last24h };
}

export interface LlmSpendStats {
  todayUsd: number;
  /** Promedio diario (USD) de los 7 días previos a hoy. */
  prevDailyAvgUsd: number;
}

/**
 * Gasto LLM estimado de HOY (desde todayStart, UTC) vs promedio diario de los
 * 7 días previos. Misma estimación blended del dashboard (USD_PER_TOKEN sobre
 * payload.total_tokens de eventos llm_usage).
 */
export function computeLlmSpend(
  rows: Array<{
    created_at: string | null;
    payload: { total_tokens?: number | null } | null;
  }>,
  todayStartMs: number,
): LlmSpendStats {
  const prevStartMs = todayStartMs - 7 * 24 * 3_600_000;
  let todayTokens = 0;
  let prevTokens = 0;

  for (const row of rows) {
    if (!row.created_at) continue;
    const t = Date.parse(row.created_at);
    if (!Number.isFinite(t)) continue;
    const tokens = Number(row.payload?.total_tokens ?? 0);
    if (!Number.isFinite(tokens)) continue;
    if (t >= todayStartMs) todayTokens += tokens;
    else if (t >= prevStartMs) prevTokens += tokens;
  }

  return {
    todayUsd: todayTokens * USD_PER_TOKEN,
    prevDailyAvgUsd: (prevTokens * USD_PER_TOKEN) / 7,
  };
}

// ---------------------------------------------------------------------------
// Reglas (una función pura por regla; null = no dispara)
// ---------------------------------------------------------------------------

export function evaluateBufferStuck(
  stats: StuckBatchStats,
): AlertCandidate | null {
  if (stats.stuckCount === 0) return null;
  return {
    type: "buffer_trabado",
    severity: "critical",
    message: `${stats.stuckCount} mensaje(s) en el buffer sin procesar hace más de ${BUFFER_STUCK_MINUTES} minutos — el bot puede estar mudo`,
    payload: {
      stuck_count: stats.stuckCount,
      oldest_minutes: stats.oldestMinutes,
    },
  };
}

export function evaluateSilence(stats: InboundStats): AlertCandidate | null {
  if (stats.last7d === 0 || stats.last24h > 0) return null;
  return {
    type: "silencio_anomalo",
    severity: "warning",
    message: `Sin mensajes entrantes en las últimas 24 h (hubo ${stats.last7d} en los últimos 7 días) — webhook caído o número con problemas`,
    payload: { inbound_7d: stats.last7d, inbound_24h: 0 },
  };
}

export function evaluateLlmSpend(stats: LlmSpendStats): AlertCandidate | null {
  const { todayUsd, prevDailyAvgUsd } = stats;
  if (todayUsd <= LLM_SPEND_FLOOR_USD) return null;

  // Sin historial (promedio 0) el ratio es infinito: cualquier gasto por
  // encima del piso es anómalo por definición (evita división por cero).
  const ratio =
    prevDailyAvgUsd > 0 ? todayUsd / prevDailyAvgUsd : Number.POSITIVE_INFINITY;
  if (ratio <= LLM_WARN_RATIO) return null;

  const severity: AlertSeverity =
    ratio > LLM_CRIT_RATIO ? "critical" : "warning";
  const ratioLabel = Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "∞x";
  return {
    type: "gasto_llm_anomalo",
    severity,
    message: `Gasto LLM de hoy USD ${todayUsd.toFixed(2)} (${ratioLabel} el promedio diario de los 7 días previos, USD ${prevDailyAvgUsd.toFixed(2)})`,
    payload: {
      today_usd: Number(todayUsd.toFixed(4)),
      prev_daily_avg_usd: Number(prevDailyAvgUsd.toFixed(4)),
      ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
    },
  };
}

export function evaluateToolErrors(
  errorsLastHour: number,
): AlertCandidate | null {
  if (errorsLastHour < TOOL_ERRORS_THRESHOLD) return null;
  return {
    type: "errores_tools",
    severity: "warning",
    message: `${errorsLastHour} errores de tools en la última hora — revisar integración/credenciales`,
    payload: { errors_last_hour: errorsLastHour },
  };
}

export interface RateLimitStats {
  /** Bloqueos por techo de turnos de un mismo contacto. */
  contactHour: number;
  /** Bloqueos por presupuesto diario de tokens del workspace. */
  dailyBudget: number;
}

/** Cuenta los eventos `rate_limited` de la última hora por motivo. */
export function countRateLimited(
  rows: Array<{ payload: { reason?: string | null } | null }>,
): RateLimitStats {
  let contactHour = 0;
  let dailyBudget = 0;
  for (const row of rows) {
    const reason = row.payload?.reason;
    if (reason === "daily_token_budget_exceeded") dailyBudget++;
    else if (reason === "rate_limit_contact_hour") contactHour++;
  }
  return { contactHour, dailyBudget };
}

/**
 * El bot dejó de responder por un techo de costo. Agotar el presupuesto DIARIO
 * es critical: el workspace queda mudo hasta el reset. El techo por contacto es
 * warning: solo afecta a esa persona, y puede ser legítimo (alguien spameando).
 */
export function evaluateRateLimited(
  stats: RateLimitStats,
): AlertCandidate | null {
  if (stats.dailyBudget > 0) {
    return {
      type: "bot_limitado",
      severity: "critical",
      message: `El bot dejó de responder: se agotó el presupuesto diario de tokens (${stats.dailyBudget} mensaje(s) sin responder en la última hora). Subí el límite en la configuración del workspace.`,
      payload: {
        daily_budget_blocks: stats.dailyBudget,
        contact_hour_blocks: stats.contactHour,
      },
    };
  }
  if (stats.contactHour === 0) return null;
  return {
    type: "bot_limitado",
    severity: "warning",
    message: `${stats.contactHour} mensaje(s) sin responder en la última hora por el techo de turnos por contacto`,
    payload: { contact_hour_blocks: stats.contactHour, daily_budget_blocks: 0 },
  };
}

// ---------------------------------------------------------------------------
// Plan de cambios: dedupe + auto-resolución (puro, por workspace)
// ---------------------------------------------------------------------------

export interface AlertChangesPlan {
  /** Alertas nuevas (no había abierta del mismo type). */
  toInsert: AlertCandidate[];
  /** Alertas abiertas cuya condición sigue: refrescar detalle. */
  toUpdate: Array<{
    id: string;
    severity: AlertSeverity;
    message: string;
    payload: Record<string, unknown>;
  }>;
  /** IDs de alertas abiertas cuya condición ya no se cumple. */
  toResolve: string[];
}

/**
 * Cruza los candidatos de esta evaluación con las alertas ABIERTAS del
 * workspace: dedupe por type (no crear otra si ya hay una abierta),
 * refresco de payload/severity si sigue disparando, y auto-resolución
 * si dejó de disparar.
 */
export function planAlertChanges(
  candidates: AlertCandidate[],
  openAlerts: OpenAlertRow[],
): AlertChangesPlan {
  const openByType = new Map(openAlerts.map((a) => [a.type, a]));
  const firingTypes = new Set(candidates.map((c) => c.type));

  const plan: AlertChangesPlan = { toInsert: [], toUpdate: [], toResolve: [] };

  for (const candidate of candidates) {
    const open = openByType.get(candidate.type);
    if (open) {
      plan.toUpdate.push({
        id: open.id,
        severity: candidate.severity,
        message: candidate.message,
        payload: candidate.payload,
      });
    } else {
      plan.toInsert.push(candidate);
    }
  }

  for (const open of openAlerts) {
    if (!firingTypes.has(open.type as AlertType)) {
      plan.toResolve.push(open.id);
    }
  }

  return plan;
}
