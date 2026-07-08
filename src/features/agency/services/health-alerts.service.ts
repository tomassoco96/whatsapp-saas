// Orquestador de alertas de salud por workspace.
// Corre desde el cron /api/cron/health-check (service role, bypass RLS):
// junta datos crudos baratos que YA existen (message_batches, messages,
// events) y delega la evaluación en las funciones puras de health-rules.ts.
// Dedupe y auto-resolución sobre la tabla workspace_alerts.

import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  computeLlmSpend,
  countInbound,
  countRateLimited,
  countStuckBatches,
  evaluateBufferStuck,
  evaluateLlmSpend,
  evaluateRateLimited,
  evaluateSilence,
  evaluateToolErrors,
  planAlertChanges,
  type AlertCandidate,
  type OpenAlertRow,
} from "./health-rules";

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const DAY_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// Notificación saliente opcional (env ALERT_WEBHOOK_URL)
// ---------------------------------------------------------------------------

export interface AlertWebhookPayload {
  workspace: string;
  type: string;
  severity: string;
  message: string;
  created_at: string;
}

/**
 * POST JSON al webhook de alertas si está configurado. Fire-and-forget:
 * nunca lanza y no bloquea el cron más de 3 segundos.
 */
export async function notifyAlertWebhook(
  payload: AlertWebhookPayload,
): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // Nunca dejar que la notificación rompa el health check.
    console.warn("[health-alerts] notifyAlertWebhook failed:", err);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export interface HealthCheckSummary {
  workspaces: number;
  created: number;
  updated: number;
  resolved: number;
}

interface WsRow {
  id: string;
  name: string;
  slug: string;
}

interface InsertedAlertRow {
  id: string;
  workspace_id: string;
  type: string;
  severity: string;
  message: string;
  created_at: string;
}

/**
 * Evalúa las reglas de salud v1 para todos los workspaces activos y
 * sincroniza workspace_alerts (crear / refrescar / auto-resolver).
 * SOLO llamar server-side (cron con CRON_SECRET): usa service role.
 */
export async function runHealthCheck(
  now: Date = new Date(),
): Promise<HealthCheckSummary> {
  const supabase = svc();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  // "Hoy" en UTC, consistente con resolvePeriod de agency-metrics.
  const todayStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  const { data: wsData, error: wsError } = await supabase
    .from("workspaces")
    .select("id, name, slug")
    .eq("is_active", true);

  if (wsError) throw new Error(`workspaces: ${wsError.message}`);
  const workspaces = (wsData as WsRow[] | null) ?? [];
  const summary: HealthCheckSummary = {
    workspaces: workspaces.length,
    created: 0,
    updated: 0,
    resolved: 0,
  };
  if (workspaces.length === 0) return summary;

  const ids = workspaces.map((w) => w.id);
  const sevenDaysAgoIso = new Date(nowMs - 7 * DAY_MS).toISOString();
  const llmWindowStartIso = new Date(todayStartMs - 7 * DAY_MS).toISOString();
  const oneHourAgoIso = new Date(nowMs - 3_600_000).toISOString();

  const [batchesRes, inboundRes, llmRes, toolErrRes, rateLimitRes, openRes] =
    await Promise.all([
      // a. Buffer trabado: batches todavía en 'buffering' (el flush corre
      //    cada minuto; si flush_at quedó >10' en el pasado, algo está roto).
      supabase
        .from("message_batches")
        .select("workspace_id, flush_at, created_at")
        .eq("status", "buffering")
        .in("workspace_id", ids),
      // b. Silencio anómalo: entrantes de los últimos 7 días.
      supabase
        .from("messages")
        .select("workspace_id, created_at")
        .eq("direction", "in")
        .gte("created_at", sevenDaysAgoIso)
        .in("workspace_id", ids),
      // c. Gasto LLM: eventos llm_usage de hoy + 7 días previos.
      supabase
        .from("events")
        .select("workspace_id, created_at, payload")
        .eq("type", "llm_usage")
        .gte("created_at", llmWindowStartIso)
        .in("workspace_id", ids),
      // d. Errores de tools: el registry loguea events type='tool_call'
      //    con level='error' cuando result_ok = false.
      supabase
        .from("events")
        .select("workspace_id")
        .eq("type", "tool_call")
        .eq("level", "error")
        .gte("created_at", oneHourAgoIso)
        .in("workspace_id", ids),
      // e. Bot limitado: mensajes que quedaron sin responder por un techo de
      //    costo (cost-tracker inserta events type='rate_limited').
      supabase
        .from("events")
        .select("workspace_id, payload")
        .eq("type", "rate_limited")
        .gte("created_at", oneHourAgoIso)
        .in("workspace_id", ids),
      // Alertas abiertas actuales (para dedupe / auto-resolución).
      supabase
        .from("workspace_alerts")
        .select("id, workspace_id, type, severity, message")
        .filter("resolved_at", "is", null)
        .in("workspace_id", ids),
    ]);

  const failed = [
    batchesRes,
    inboundRes,
    llmRes,
    toolErrRes,
    rateLimitRes,
    openRes,
  ].find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);

  type Row = { workspace_id: string };
  const groupByWs = <T extends Row>(rows: T[] | null): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const row of rows ?? []) {
      const list = map.get(row.workspace_id);
      if (list) list.push(row);
      else map.set(row.workspace_id, [row]);
    }
    return map;
  };

  const batchesByWs = groupByWs(
    batchesRes.data as Array<
      Row & { flush_at: string | null; created_at: string | null }
    > | null,
  );
  const inboundByWs = groupByWs(
    inboundRes.data as Array<Row & { created_at: string | null }> | null,
  );
  const llmByWs = groupByWs(
    llmRes.data as Array<
      Row & {
        created_at: string | null;
        payload: { total_tokens?: number | null } | null;
      }
    > | null,
  );
  const toolErrByWs = groupByWs(toolErrRes.data as Row[] | null);
  const rateLimitByWs = groupByWs(
    rateLimitRes.data as Array<
      Row & { payload: { reason?: string | null } | null }
    > | null,
  );
  const openByWs = groupByWs(
    (openRes.data as (OpenAlertRow & { workspace_id: string })[] | null) ?? [],
  );

  const toInsert: Array<AlertCandidate & { workspace_id: string }> = [];
  const toUpdate: Array<{
    id: string;
    severity: string;
    message: string;
    payload: Record<string, unknown>;
  }> = [];
  const toResolve: string[] = [];

  for (const ws of workspaces) {
    const candidates = [
      evaluateBufferStuck(countStuckBatches(batchesByWs.get(ws.id) ?? [], nowMs)),
      evaluateSilence(countInbound(inboundByWs.get(ws.id) ?? [], nowMs)),
      evaluateLlmSpend(computeLlmSpend(llmByWs.get(ws.id) ?? [], todayStartMs)),
      evaluateToolErrors((toolErrByWs.get(ws.id) ?? []).length),
      evaluateRateLimited(countRateLimited(rateLimitByWs.get(ws.id) ?? [])),
    ].filter((c): c is AlertCandidate => c !== null);

    const plan = planAlertChanges(candidates, openByWs.get(ws.id) ?? []);
    for (const cand of plan.toInsert) {
      toInsert.push({ ...cand, workspace_id: ws.id });
    }
    toUpdate.push(...plan.toUpdate);
    toResolve.push(...plan.toResolve);
  }

  // 1) Alertas nuevas (batch) + notificación saliente opcional.
  let insertedRows: InsertedAlertRow[] = [];
  if (toInsert.length > 0) {
    const { data, error } = await supabase
      .from("workspace_alerts")
      .insert(
        toInsert.map((a) => ({
          workspace_id: a.workspace_id,
          type: a.type,
          severity: a.severity,
          message: a.message,
          payload: a.payload,
        })),
      )
      .select("id, workspace_id, type, severity, message, created_at");
    if (error) throw new Error(`insert workspace_alerts: ${error.message}`);
    insertedRows = (data as InsertedAlertRow[] | null) ?? [];
    summary.created = toInsert.length;
  }

  // 2) Refresco de alertas abiertas que siguen disparando.
  for (const upd of toUpdate) {
    const { error } = await supabase
      .from("workspace_alerts")
      .update({
        severity: upd.severity,
        message: upd.message,
        payload: upd.payload,
      })
      .eq("id", upd.id);
    if (error) throw new Error(`update workspace_alerts: ${error.message}`);
  }
  summary.updated = toUpdate.length;

  // 3) Auto-resolución de las que dejaron de disparar.
  if (toResolve.length > 0) {
    const { error } = await supabase
      .from("workspace_alerts")
      .update({ resolved_at: nowIso })
      .in("id", toResolve);
    if (error) throw new Error(`resolve workspace_alerts: ${error.message}`);
    summary.resolved = toResolve.length;
  }

  // 4) Notificar solo alertas NUEVAS (fire-and-forget, nunca lanza).
  if (insertedRows.length > 0) {
    const nameById = new Map(workspaces.map((w) => [w.id, w.name]));
    await Promise.allSettled(
      insertedRows.map((row) =>
        notifyAlertWebhook({
          workspace: nameById.get(row.workspace_id) ?? row.workspace_id,
          type: row.type,
          severity: row.severity,
          message: row.message,
          created_at: row.created_at ?? nowIso,
        }),
      ),
    );
  }

  return summary;
}
