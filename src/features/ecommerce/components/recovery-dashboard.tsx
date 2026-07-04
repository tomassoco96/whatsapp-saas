"use client";

import {
  ShoppingCart,
  CheckCircle2,
  Send,
  DollarSign,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  RecoveryMetrics,
  RecentCart,
} from "@/features/ecommerce/services/recovery-metrics";

interface RecoveryDashboardProps {
  metrics: RecoveryMetrics;
  recentCarts: RecentCart[];
}

interface KpiCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: boolean;
}

function KpiCard({ label, value, icon, accent = false }: KpiCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border p-5 flex items-start gap-4",
        "bg-card transition-colors",
        accent ? "border-primary/20 bg-primary/5" : "border-border/50",
      )}
    >
      <div
        className={cn(
          "shrink-0 rounded-lg p-2",
          accent
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
          {label}
        </p>
        <p className="font-display text-2xl font-semibold text-foreground mt-0.5 tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  contacted: "Contactado",
  recovered: "Recuperado",
  expired: "Expirado",
  opted_out: "Opt-out",
  not_contactable: "Sin teléfono",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-warning/10 text-warning",
  contacted: "bg-info/10 text-info",
  recovered: "bg-primary/10 text-primary",
  expired: "bg-muted text-muted-foreground",
  opted_out: "bg-destructive/10 text-destructive",
  not_contactable: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
        STATUS_COLORS[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function formatMoney(value: number, currency: string | null = null): string {
  const formatted = value.toLocaleString("es-AR", {
    maximumFractionDigits: 0,
  });
  return currency ? `$${formatted} ${currency}` : `$${formatted}`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function RecoveryDashboard({
  metrics,
  recentCarts,
}: RecoveryDashboardProps) {
  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">
          Recuperación de carritos
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Últimos 90 días · {metrics.totalCarts.toLocaleString("es")} carritos
          ingresados
        </p>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="$ recuperado"
          value={formatMoney(metrics.recoveredValue)}
          icon={<DollarSign className="h-4 w-4" aria-hidden="true" />}
          accent
        />
        <KpiCard
          label="$ en juego"
          value={formatMoney(metrics.inPlayValue)}
          icon={<ShoppingCart className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="Carritos recuperados"
          value={metrics.recovered.toLocaleString("es")}
          icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="Tasa de recuperación"
          value={
            metrics.recoveryRate === null
              ? "—"
              : `${Math.round(metrics.recoveryRate * 100)}%`
          }
          icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="Toques enviados"
          value={metrics.touchesSent.toLocaleString("es")}
          icon={<Send className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="En secuencia"
          value={(metrics.pending + metrics.contacted).toLocaleString("es")}
          icon={<ShoppingCart className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      {/* Desglose por estado */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["pending", metrics.pending],
            ["contacted", metrics.contacted],
            ["recovered", metrics.recovered],
            ["expired", metrics.expired],
            ["opted_out", metrics.optedOut],
            ["not_contactable", metrics.notContactable],
          ] as const
        ).map(([status, count]) => (
          <div
            key={status}
            className="flex items-center gap-2 rounded-lg border border-border/50 bg-card px-3 py-1.5"
          >
            <StatusBadge status={status} />
            <span className="text-sm font-medium tabular-nums text-foreground">
              {count.toLocaleString("es")}
            </span>
          </div>
        ))}
      </div>

      {/* Carritos recientes */}
      <div className="space-y-3">
        <h2 className="font-display text-sm font-semibold text-foreground">
          Carritos recientes
        </h2>

        {recentCarts.length === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Todavía no ingresaron carritos. Configurá el webhook del plugin
              en Settings → WooCommerce.
            </p>
          </div>
        ) : (
          <ul
            role="list"
            className="rounded-xl border border-border/50 bg-card divide-y divide-border/30 overflow-hidden"
          >
            {recentCarts.map((cart) => (
              <li
                key={cart.id}
                className="flex items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">
                    {cart.customerName ?? cart.phone ?? "Sin datos de contacto"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatMoney(cart.total, cart.currency)}
                    {cart.touchesSent > 0 &&
                      ` · ${cart.touchesSent} ${cart.touchesSent === 1 ? "toque" : "toques"}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={cart.status} />
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {formatRelativeTime(cart.abandonedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
