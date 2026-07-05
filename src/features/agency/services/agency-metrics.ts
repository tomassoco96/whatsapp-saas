// Métricas consolidadas de agencia (roll-up por workspace y período).
// Mismo patrón que dashboard/services/metrics.ts y recovery-metrics.ts:
// cliente service role (bypass RLS, solo server-side) + agregación en JS
// con funciones puras exportadas para test.

import { createClient as createServiceClient } from "@supabase/supabase-js";

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Estimación blended USD/token — mismo valor que dashboard/services/metrics.ts. */
const USD_PER_TOKEN = 0.000_002;

/** Estados de conversación que cuentan como intervención humana (no resuelta por IA). */
const HUMAN_STATES = new Set(["handoff_pending", "human_active"]);

// ---------------------------------------------------------------------------
// Período (mes actual / mes anterior, límites en UTC)
// ---------------------------------------------------------------------------

export type PeriodKey = "actual" | "anterior";

export interface Period {
  key: PeriodKey;
  /** ISO inclusive. */
  start: string;
  /** ISO exclusivo. */
  end: string;
  /** "YYYY-MM" del mes del período (para filenames y CSV). */
  monthKey: string;
}

/**
 * Resuelve el período pedido a límites de mes calendario en UTC.
 * Cualquier valor desconocido cae en "actual". Función pura, exportada para test.
 */
export function resolvePeriod(
  raw: string | undefined,
  now: Date = new Date(),
): Period {
  const key: PeriodKey = raw === "anterior" ? "anterior" : "actual";
  const offset = key === "anterior" ? -1 : 0;
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1),
  );
  return {
    key,
    start: start.toISOString(),
    end: end.toISOString(),
    monthKey: start.toISOString().slice(0, 7),
  };
}

// ---------------------------------------------------------------------------
// Tipos de filas crudas (lo mínimo que selecciona cada query)
// ---------------------------------------------------------------------------

export interface AgencyWorkspaceRow {
  id: string;
  name: string;
  slug: string;
}

export interface AgencyConversationRow {
  workspace_id: string;
  state: string;
  last_message_at: string | null;
}

export interface AgencyCartRow {
  workspace_id: string;
  status: string;
  total: number | string | null;
}

export interface AgencyLlmEventRow {
  workspace_id: string;
  payload: { total_tokens?: number | null } | null;
}

export interface AgencyAgentRow {
  workspace_id: string;
}

/** Alerta ABIERTA (resolved_at null) de workspace_alerts. */
export interface AgencyAlertRow {
  workspace_id: string;
  severity: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Resultado agregado
// ---------------------------------------------------------------------------

export interface WorkspacePeriodStats {
  id: string;
  name: string;
  slug: string;
  /** Conversaciones con actividad dentro del período. */
  conversations: number;
  /** Fracción 0..1 resuelta por IA (sin handoff ni humano); null sin datos. */
  iaResolvedRate: number | null;
  /** $ de carritos recuperados abandonados dentro del período. */
  recoveredValue: number;
  /** Gasto LLM estimado (USD) del período. */
  llmCostUsd: number;
  /** Agentes con is_active = true. */
  activeAgents: number;
  /** Último mensaje en cualquier conversación del workspace (salud básica). */
  lastActivityAt: string | null;
  /** Alertas de salud abiertas (workspace_alerts con resolved_at null). */
  openAlerts: WorkspaceOpenAlerts;
}

export interface WorkspaceOpenAlerts {
  critical: number;
  warning: number;
  /** Mensajes de las alertas abiertas (para tooltip), críticas primero. */
  messages: string[];
}

export interface AgencyRollup {
  totals: {
    workspaces: number;
    /** Workspaces con al menos una conversación activa en el período. */
    activeWorkspaces: number;
    conversations: number;
    recoveredValue: number;
    llmCostUsd: number;
    /** Total de alertas de salud abiertas en todos los workspaces. */
    openAlerts: number;
  };
  rows: WorkspacePeriodStats[];
}

interface AggregateInput {
  workspaces: AgencyWorkspaceRow[];
  conversations: AgencyConversationRow[];
  carts: AgencyCartRow[];
  llmEvents: AgencyLlmEventRow[];
  agents: AgencyAgentRow[];
  /** Opcional para no romper llamadas existentes (default: sin alertas). */
  alerts?: AgencyAlertRow[];
  period: Pick<Period, "start" | "end">;
}

/**
 * Agrega las filas crudas al roll-up por workspace + totales del período.
 * Las conversaciones llegan SIN filtrar por período (se usan también para la
 * señal de salud "última actividad"); acá se filtran por last_message_at.
 * Función pura, exportada para test.
 */
export function aggregateAgencyRollup(input: AggregateInput): AgencyRollup {
  const startMs = Date.parse(input.period.start);
  const endMs = Date.parse(input.period.end);

  const rowsById = new Map<string, WorkspacePeriodStats>();
  const humanCount = new Map<string, number>();
  const tokensByWs = new Map<string, number>();

  for (const w of input.workspaces) {
    rowsById.set(w.id, {
      id: w.id,
      name: w.name,
      slug: w.slug,
      conversations: 0,
      iaResolvedRate: null,
      recoveredValue: 0,
      llmCostUsd: 0,
      activeAgents: 0,
      lastActivityAt: null,
      openAlerts: { critical: 0, warning: 0, messages: [] },
    });
  }

  // Alertas de salud abiertas (críticas primero en los mensajes del tooltip).
  const sortedAlerts = [...(input.alerts ?? [])].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1,
  );
  for (const alert of sortedAlerts) {
    const row = rowsById.get(alert.workspace_id);
    if (!row) continue;
    if (alert.severity === "critical") row.openAlerts.critical++;
    else row.openAlerts.warning++;
    if (alert.message) row.openAlerts.messages.push(alert.message);
  }

  for (const c of input.conversations) {
    const row = rowsById.get(c.workspace_id);
    if (!row || !c.last_message_at) continue;

    const t = Date.parse(c.last_message_at);
    if (!Number.isFinite(t)) continue;

    // Salud: último mensaje del workspace, sin importar el período.
    if (!row.lastActivityAt || t > Date.parse(row.lastActivityAt)) {
      row.lastActivityAt = c.last_message_at;
    }

    // Conversaciones del período (actividad dentro de [start, end)).
    if (t >= startMs && t < endMs) {
      row.conversations++;
      if (HUMAN_STATES.has(c.state)) {
        humanCount.set(c.workspace_id, (humanCount.get(c.workspace_id) ?? 0) + 1);
      }
    }
  }

  for (const cart of input.carts) {
    const row = rowsById.get(cart.workspace_id);
    if (!row || cart.status !== "recovered") continue;
    const total = Number(cart.total ?? 0);
    if (Number.isFinite(total)) row.recoveredValue += total;
  }

  for (const ev of input.llmEvents) {
    if (!rowsById.has(ev.workspace_id)) continue;
    const tokens = Number(ev.payload?.total_tokens ?? 0);
    if (Number.isFinite(tokens)) {
      tokensByWs.set(
        ev.workspace_id,
        (tokensByWs.get(ev.workspace_id) ?? 0) + tokens,
      );
    }
  }

  for (const agent of input.agents) {
    const row = rowsById.get(agent.workspace_id);
    if (row) row.activeAgents++;
  }

  const rows = Array.from(rowsById.values());
  for (const row of rows) {
    row.llmCostUsd = (tokensByWs.get(row.id) ?? 0) * USD_PER_TOKEN;
    const human = humanCount.get(row.id) ?? 0;
    row.iaResolvedRate =
      row.conversations > 0
        ? (row.conversations - human) / row.conversations
        : null;
  }

  // Más actividad primero; empates por nombre.
  rows.sort(
    (a, b) =>
      b.conversations - a.conversations || a.name.localeCompare(b.name, "es"),
  );

  return {
    totals: {
      workspaces: rows.length,
      activeWorkspaces: rows.filter((r) => r.conversations > 0).length,
      conversations: rows.reduce((sum, r) => sum + r.conversations, 0),
      recoveredValue: rows.reduce((sum, r) => sum + r.recoveredValue, 0),
      llmCostUsd: rows.reduce((sum, r) => sum + r.llmCostUsd, 0),
      openAlerts: rows.reduce(
        (sum, r) => sum + r.openAlerts.critical + r.openAlerts.warning,
        0,
      ),
    },
    rows,
  };
}

// ---------------------------------------------------------------------------
// CSV de facturación (una fila por workspace del período)
// ---------------------------------------------------------------------------

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serializa el roll-up a CSV (para la facturación de la agencia).
 * Función pura, exportada para test.
 */
export function rollupToCsv(rollup: AgencyRollup, period: Period): string {
  const header = [
    "periodo",
    "workspace",
    "slug",
    "conversaciones",
    "resueltas_ia_pct",
    "recuperado",
    "gasto_llm_usd",
    "agentes_activos",
  ].join(",");

  const lines = rollup.rows.map((r) =>
    [
      period.monthKey,
      csvField(r.name),
      csvField(r.slug),
      String(r.conversations),
      r.iaResolvedRate === null
        ? ""
        : String(Math.round(r.iaResolvedRate * 100)),
      r.recoveredValue.toFixed(2),
      r.llmCostUsd.toFixed(4),
      String(r.activeAgents),
    ].join(","),
  );

  return [header, ...lines].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Fetch (service role) + agregación
// ---------------------------------------------------------------------------

export type AgencyRollupResult =
  | { rollup: AgencyRollup; error?: never }
  | { rollup?: never; error: string };

/**
 * Roll-up cross-workspace del período. SOLO llamar detrás del guard
 * super_admin: usa service role y ve todos los tenants.
 */
export async function getAgencyRollup(
  period: Period,
): Promise<AgencyRollupResult> {
  const supabase = svc();

  const { data: wsData, error: wsError } = await supabase
    .from("workspaces")
    .select("id, name, slug")
    .order("created_at", { ascending: false });

  if (wsError) return { error: wsError.message };

  const workspaces = (wsData as AgencyWorkspaceRow[] | null) ?? [];
  if (workspaces.length === 0) {
    return {
      rollup: aggregateAgencyRollup({
        workspaces: [],
        conversations: [],
        carts: [],
        llmEvents: [],
        agents: [],
        period,
      }),
    };
  }

  const ids = workspaces.map((w) => w.id);

  // Nota: conversations se trae sin filtro de fecha porque también alimenta
  // la señal de salud (último mensaje); el filtro de período se hace en JS.
  const [convRes, cartsRes, eventsRes, agentsRes, alertsRes] =
    await Promise.all([
    supabase
      .from("conversations")
      .select("workspace_id, state, last_message_at")
      .in("workspace_id", ids),
    supabase
      .from("abandoned_carts")
      .select("workspace_id, status, total")
      .in("workspace_id", ids)
      .gte("abandoned_at", period.start)
      .filter("abandoned_at", "lt", period.end),
    supabase
      .from("events")
      .select("workspace_id, payload")
      .eq("type", "llm_usage")
      .in("workspace_id", ids)
      .gte("created_at", period.start)
      .filter("created_at", "lt", period.end),
    supabase
      .from("agents")
      .select("workspace_id")
      .eq("is_active", true)
      .in("workspace_id", ids),
    supabase
      .from("workspace_alerts")
      .select("workspace_id, severity, message")
      .filter("resolved_at", "is", null)
      .in("workspace_id", ids),
  ]);

  const failed = [convRes, cartsRes, eventsRes, agentsRes].find(
    (r) => r.error,
  );
  if (failed?.error) return { error: failed.error.message };

  // Las alertas de salud son señal secundaria: si su query falla (ej. la
  // migración workspace_alerts no está aplicada) el panel sigue funcionando.
  const alerts = alertsRes.error
    ? []
    : ((alertsRes.data as AgencyAlertRow[] | null) ?? []);

  return {
    rollup: aggregateAgencyRollup({
      workspaces,
      conversations:
        (convRes.data as AgencyConversationRow[] | null) ?? [],
      carts: (cartsRes.data as AgencyCartRow[] | null) ?? [],
      llmEvents: (eventsRes.data as AgencyLlmEventRow[] | null) ?? [],
      agents: (agentsRes.data as AgencyAgentRow[] | null) ?? [],
      alerts,
      period,
    }),
  };
}
