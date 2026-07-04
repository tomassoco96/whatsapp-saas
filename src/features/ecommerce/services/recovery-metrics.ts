// Métricas del dashboard de recuperación de carritos (paso 5 del plan v2).
// Mismo patrón que dashboard/services/metrics.ts: service role para agregados.

import { createClient as createSbClient } from "@supabase/supabase-js";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** Ventana de análisis del dashboard. */
const WINDOW_DAYS = 90;

export interface CartMetricRow {
  status: string;
  total: number | string | null;
  touches_sent: number | null;
}

export interface RecoveryMetrics {
  totalCarts: number;
  pending: number;
  contacted: number;
  recovered: number;
  expired: number;
  optedOut: number;
  notContactable: number;
  /** $ de carritos recuperados (atribución directa). */
  recoveredValue: number;
  /** $ de carritos aún en juego (pending + contacted). */
  inPlayValue: number;
  touchesSent: number;
  /** recovered / (recovered + expired), sobre carritos con desenlace. */
  recoveryRate: number | null;
}

/**
 * Agrega las filas de abandoned_carts a las métricas del dashboard.
 * Función pura, exportada para test.
 */
export function aggregateCartMetrics(rows: CartMetricRow[]): RecoveryMetrics {
  const m: RecoveryMetrics = {
    totalCarts: rows.length,
    pending: 0,
    contacted: 0,
    recovered: 0,
    expired: 0,
    optedOut: 0,
    notContactable: 0,
    recoveredValue: 0,
    inPlayValue: 0,
    touchesSent: 0,
    recoveryRate: null,
  };

  for (const row of rows) {
    const total = Number(row.total ?? 0);
    const safeTotal = Number.isFinite(total) ? total : 0;
    m.touchesSent += row.touches_sent ?? 0;

    switch (row.status) {
      case "pending":
        m.pending++;
        m.inPlayValue += safeTotal;
        break;
      case "contacted":
        m.contacted++;
        m.inPlayValue += safeTotal;
        break;
      case "recovered":
        m.recovered++;
        m.recoveredValue += safeTotal;
        break;
      case "expired":
        m.expired++;
        break;
      case "opted_out":
        m.optedOut++;
        break;
      case "not_contactable":
        m.notContactable++;
        break;
    }
  }

  const closed = m.recovered + m.expired;
  m.recoveryRate = closed > 0 ? m.recovered / closed : null;

  return m;
}

export async function getRecoveryMetrics(
  workspaceId: string,
): Promise<RecoveryMetrics> {
  const supabase = svc();
  const windowStart = new Date();
  windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_DAYS);

  const { data } = await supabase
    .from("abandoned_carts")
    .select("status, total, touches_sent")
    .eq("workspace_id", workspaceId)
    .gte("abandoned_at", windowStart.toISOString());

  return aggregateCartMetrics((data as CartMetricRow[] | null) ?? []);
}

export interface RecentCart {
  id: string;
  customerName: string | null;
  phone: string | null;
  status: string;
  total: number;
  currency: string | null;
  touchesSent: number;
  abandonedAt: string;
}

export async function getRecentCarts(
  workspaceId: string,
  limit = 8,
): Promise<RecentCart[]> {
  const supabase = svc();

  const { data } = await supabase
    .from("abandoned_carts")
    .select(
      "id, customer_name, phone, status, total, currency, touches_sent, abandoned_at",
    )
    .eq("workspace_id", workspaceId)
    .order("abandoned_at", { ascending: false })
    .limit(limit);

  return ((data as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
    id: r.id as string,
    customerName: (r.customer_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    status: r.status as string,
    total: Number(r.total ?? 0),
    currency: (r.currency as string | null) ?? null,
    touchesSent: (r.touches_sent as number | null) ?? 0,
    abandonedAt: r.abandoned_at as string,
  }));
}
