// Reporte mensual por workspace — el artefacto de retención de la agencia.
// Mismo patrón que dashboard/services/metrics.ts y ecommerce/services/recovery-metrics.ts:
// service role para agregados (el filtro por workspace_id es OBLIGATORIO en cada query),
// funciones puras exportadas para test.

import { createClient as createSbClient } from "@supabase/supabase-js";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// Misma estimación blended que dashboard/services/metrics.ts.
const USD_PER_TOKEN = 0.000_002;

// ── Rango del mes calendario (UTC) ──────────────────────────────────────────

export interface MonthRange {
  /** Inicio del mes, inclusivo (ISO). */
  startIso: string;
  /** Inicio del mes siguiente, exclusivo (ISO). */
  endIso: string;
}

/**
 * Devuelve el rango [inicio de mes, inicio del mes siguiente) en UTC.
 * `month` es 1-12. Lanza si el mes/año no son válidos.
 */
export function monthRangeUtc(year: number, month: number): MonthRange {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    year < 2020 ||
    year > 2100 ||
    month < 1 ||
    month > 12
  ) {
    throw new Error(`Mes inválido: ${year}-${month}`);
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// ── Carritos (recovery) ─────────────────────────────────────────────────────

export interface MonthlyCartRow {
  status: string;
  total: number | string | null;
  touches_sent: number | null;
}

export interface MonthlyCartStats {
  /** Carritos abandonados ingresados en el mes. */
  total: number;
  /** Carritos que recibieron al menos un toque de WhatsApp. */
  contacted: number;
  /** Carritos con status recovered (atribución directa). */
  recovered: number;
  /** $ de los carritos recuperados. */
  recoveredValue: number;
  /** recovered / contacted, null si no hubo contactados. */
  conversionRate: number | null;
  touchesSent: number;
}

/** Agrega los carritos abandonados del mes. Función pura, exportada para test. */
export function aggregateMonthlyCarts(rows: MonthlyCartRow[]): MonthlyCartStats {
  const s: MonthlyCartStats = {
    total: rows.length,
    contacted: 0,
    recovered: 0,
    recoveredValue: 0,
    conversionRate: null,
    touchesSent: 0,
  };

  for (const row of rows) {
    const touches = row.touches_sent ?? 0;
    s.touchesSent += touches;
    if (touches > 0) s.contacted++;
    if (row.status === "recovered") {
      s.recovered++;
      const total = Number(row.total ?? 0);
      s.recoveredValue += Number.isFinite(total) ? total : 0;
    }
  }

  s.conversionRate = s.contacted > 0 ? s.recovered / s.contacted : null;
  return s;
}

// ── Conversaciones (IA vs humano) ───────────────────────────────────────────

export interface MonthlyMessageRow {
  conversation_id: string | null;
  direction: string;
  type: string | null;
}

export interface MonthlyConversationStats {
  /** Conversaciones con actividad en el mes. */
  total: number;
  /** Conversaciones que la IA resolvió sola (sin handoff en el mes). */
  aiResolved: number;
  /** Conversaciones derivadas a humano (handoff) en el mes. */
  handedOff: number;
  /** aiResolved / total, null si no hubo conversaciones. */
  aiResolvedRate: number | null;
  messagesIn: number;
  messagesOut: number;
  /** Templates Meta enviados en el mes (mensajes type='template'). */
  templatesSent: number;
}

/**
 * Agrega mensajes del mes + conversaciones con handoff en el mes.
 * `handoffConversationIds` sale de events type='state_change' → handoff_pending.
 * Función pura, exportada para test.
 */
export function aggregateConversationStats(
  messages: MonthlyMessageRow[],
  handoffConversationIds: Array<string | null>,
): MonthlyConversationStats {
  const conversationIds = new Set<string>();
  let messagesIn = 0;
  let messagesOut = 0;
  let templatesSent = 0;

  for (const msg of messages) {
    if (msg.conversation_id) conversationIds.add(msg.conversation_id);
    if (msg.direction === "in") messagesIn++;
    else if (msg.direction === "out") messagesOut++;
    if (msg.type === "template") templatesSent++;
  }

  const handedOffIds = new Set<string>();
  for (const id of handoffConversationIds) {
    if (id) {
      handedOffIds.add(id);
      conversationIds.add(id); // handoff sin mensaje en el mes cuenta igual
    }
  }

  const total = conversationIds.size;
  const handedOff = handedOffIds.size;
  const aiResolved = total - handedOff;

  return {
    total,
    aiResolved,
    handedOff,
    aiResolvedRate: total > 0 ? aiResolved / total : null,
    messagesIn,
    messagesOut,
    templatesSent,
  };
}

// ── Gasto LLM ───────────────────────────────────────────────────────────────

export interface LlmUsageRow {
  payload: Record<string, unknown> | null;
}

export interface MonthlyLlmStats {
  totalTokens: number;
  /** Cantidad de llamadas al LLM registradas. */
  calls: number;
  /** Estimación blended (misma constante que el dashboard). */
  estimatedCostUsd: number;
}

/** Suma tokens de eventos llm_usage. Función pura, exportada para test. */
export function aggregateLlmUsage(rows: LlmUsageRow[]): MonthlyLlmStats {
  let totalTokens = 0;
  for (const row of rows) {
    const t = row.payload?.total_tokens;
    if (typeof t === "number" && Number.isFinite(t)) totalTokens += t;
  }
  return {
    totalTokens,
    calls: rows.length,
    estimatedCostUsd: totalTokens * USD_PER_TOKEN,
  };
}

// ── Reporte completo ────────────────────────────────────────────────────────

export interface MonthlyReport {
  workspaceId: string;
  year: number;
  /** 1-12. */
  month: number;
  carts: MonthlyCartStats;
  conversations: MonthlyConversationStats;
  llm: MonthlyLlmStats;
}

/**
 * Arma el reporte mensual de un workspace para un mes calendario (UTC).
 * Lanza si year/month no son válidos (validar antes en el borde HTTP).
 */
export async function getMonthlyReport(
  workspaceId: string,
  year: number,
  month: number,
): Promise<MonthlyReport> {
  const { startIso, endIso } = monthRangeUtc(year, month);
  const supabase = svc();

  const [cartsResult, messagesResult, handoffResult, llmResult] =
    await Promise.all([
      // Carritos abandonados ingresados en el mes
      supabase
        .from("abandoned_carts")
        .select("status, total, touches_sent")
        .eq("workspace_id", workspaceId)
        .gte("abandoned_at", startIso)
        .lt("abandoned_at", endIso),

      // Mensajes del mes (para conversaciones activas, in/out y templates)
      supabase
        .from("messages")
        .select("conversation_id, direction, type")
        .eq("workspace_id", workspaceId)
        .gte("created_at", startIso)
        .lt("created_at", endIso),

      // Conversaciones derivadas a humano en el mes
      supabase
        .from("events")
        .select("conversation_id")
        .eq("workspace_id", workspaceId)
        .eq("type", "state_change")
        .filter("payload->>to", "eq", "handoff_pending")
        .gte("created_at", startIso)
        .lt("created_at", endIso),

      // Gasto LLM del mes
      supabase
        .from("events")
        .select("payload")
        .eq("workspace_id", workspaceId)
        .eq("type", "llm_usage")
        .gte("created_at", startIso)
        .lt("created_at", endIso),
    ]);

  const carts = aggregateMonthlyCarts(
    (cartsResult.data as MonthlyCartRow[] | null) ?? [],
  );

  const conversations = aggregateConversationStats(
    (messagesResult.data as MonthlyMessageRow[] | null) ?? [],
    (
      (handoffResult.data as Array<{ conversation_id: string | null }> | null) ??
      []
    ).map((r) => r.conversation_id),
  );

  const llm = aggregateLlmUsage((llmResult.data as LlmUsageRow[] | null) ?? []);

  return { workspaceId, year, month, carts, conversations, llm };
}
