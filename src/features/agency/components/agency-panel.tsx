"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Building2,
  MessageCircle,
  DollarSign,
  Cpu,
  Download,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { switchWorkspace } from "@/features/workspace/services/actions";
import { cn } from "@/lib/utils";
import type {
  AgencyRollup,
  Period,
  WorkspaceOpenAlerts,
  WorkspacePeriodStats,
} from "../services/agency-metrics";

interface Props {
  rollup: AgencyRollup;
  period: Period;
}

// --- formatters locales (convención del repo: se duplican por componente) ---

function formatMoney(value: number): string {
  return `$${value.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function formatPercent(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function periodLabel(period: Period): string {
  return new Date(period.start).toLocaleDateString("es-AR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// --- KPI card (patrón canónico de dashboard-metrics / recovery-dashboard) ---

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

// --- salud: alertas abiertas primero (rojo/ámbar), si no, antigüedad del
// --- último mensaje ---

function healthInfo(
  lastActivityAt: string | null,
  openAlerts?: WorkspaceOpenAlerts,
): {
  color: string;
  label: string;
} {
  // Las alertas abiertas del health-check pisan la señal de actividad:
  // critical (rojo) > warning (ámbar). El detalle va al title/tooltip.
  if (openAlerts && (openAlerts.critical > 0 || openAlerts.warning > 0)) {
    const total = openAlerts.critical + openAlerts.warning;
    const detail =
      openAlerts.messages.length > 0
        ? openAlerts.messages.join(" · ")
        : `${total} alerta(s) de salud abierta(s)`;
    return {
      color: openAlerts.critical > 0 ? "bg-destructive" : "bg-warning",
      label: detail,
    };
  }
  if (!lastActivityAt) {
    return { color: "bg-muted-foreground/40", label: "Sin actividad" };
  }
  const hrs = (Date.now() - new Date(lastActivityAt).getTime()) / 3_600_000;
  if (hrs < 24) {
    return { color: "bg-success", label: "Activo en las últimas 24h" };
  }
  if (hrs < 72) {
    return { color: "bg-warning", label: "Sin mensajes hace más de 24h" };
  }
  return {
    color: "bg-muted-foreground/40",
    label: "Sin mensajes hace más de 3 días",
  };
}

function HealthDot({
  lastActivityAt,
  openAlerts,
}: {
  lastActivityAt: string | null;
  openAlerts?: WorkspaceOpenAlerts;
}) {
  const { color, label } = healthInfo(lastActivityAt, openAlerts);

  return (
    <span className="flex items-center gap-2">
      <span
        className={cn("h-2 w-2 rounded-full shrink-0", color)}
        aria-hidden="true"
      />
      <span className="font-mono text-xs text-muted-foreground" title={label}>
        {lastActivityAt ? `hace ${formatRelativeTime(lastActivityAt)}` : "—"}
      </span>
    </span>
  );
}

const GRID_COLS =
  "md:grid-cols-[2fr_1fr_0.8fr_1fr_1fr_0.7fr_1fr_auto]";

export function AgencyPanel({ rollup, period }: Props) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();

  // Mismo patrón que workspaces-table: setear cookie de workspace activo y
  // navegar client-side (redirect() dentro de startTransition no navega).
  function handleEnter(workspaceId: string) {
    startRefresh(async () => {
      const result = await switchWorkspace(workspaceId);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      router.push("/dashboard");
    });
  }

  const { totals } = rollup;

  return (
    <div className="space-y-6">
      {/* Toolbar: selector de período + export */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
          role="group"
          aria-label="Seleccionar período"
        >
          {(
            [
              { key: "actual", label: "Mes actual" },
              { key: "anterior", label: "Mes anterior" },
            ] as const
          ).map((opt) => (
            <Link
              key={opt.key}
              href={`/panel?periodo=${opt.key}`}
              aria-current={period.key === opt.key ? "page" : undefined}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm transition-colors duration-150",
                period.key === opt.key
                  ? "bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground capitalize">
            {periodLabel(period)}
          </p>
          <Button size="sm" variant="outline" asChild>
            <a
              href={`/api/agency/export?periodo=${period.key}`}
              aria-label={`Exportar CSV de uso del período ${periodLabel(period)}`}
            >
              <Download className="h-4 w-4 mr-1.5" aria-hidden="true" />
              Exportar CSV
            </a>
          </Button>
        </div>
      </div>

      {/* KPIs consolidados del período */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard
          label="Workspaces activos"
          value={`${totals.activeWorkspaces}/${totals.workspaces}`}
          icon={<Building2 className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="Conversaciones"
          value={totals.conversations.toLocaleString("es-AR")}
          icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="$ recuperado"
          value={formatMoney(totals.recoveredValue)}
          icon={<DollarSign className="h-4 w-4" aria-hidden="true" />}
          accent
        />
        <KpiCard
          label="Gasto LLM"
          value={formatCost(totals.llmCostUsd)}
          icon={<Cpu className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="Alertas abiertas"
          value={totals.openAlerts.toLocaleString("es-AR")}
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      {/* Tabla por workspace */}
      <div className="rounded-xl border border-border overflow-hidden">
        {/* Header (solo md+) */}
        <div
          className={cn(
            "hidden md:grid gap-4 px-4 py-2.5",
            "border-b border-border bg-muted/40",
            GRID_COLS,
          )}
        >
          {[
            "Workspace",
            "Conversaciones",
            "% IA",
            "$ Recuperado",
            "Gasto LLM",
            "Agentes",
            "Actividad",
            "",
          ].map((h, i) => (
            <p
              key={`${h}-${i}`}
              className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {h}
            </p>
          ))}
        </div>

        {/* Empty state */}
        {rollup.rows.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Building2 className="h-8 w-8 opacity-40" strokeWidth={1.5} />
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                Sin clientes aún
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Da de alta tu primer cliente para ver sus métricas acá.
              </p>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link href="/workspaces">Ir a workspaces</Link>
            </Button>
          </div>
        )}

        {/* Rows */}
        {rollup.rows.map((row: WorkspacePeriodStats) => (
          <div
            key={row.id}
            className={cn(
              "flex flex-col gap-3 px-4 py-4",
              "md:grid md:items-center md:gap-4 md:py-3",
              GRID_COLS,
              "border-b border-border last:border-0",
              "hover:bg-muted/20 transition-colors duration-150",
            )}
          >
            {/* Nombre + slug */}
            <div className="min-w-0">
              <p className="font-display text-sm font-semibold text-foreground truncate">
                {row.name}
              </p>
              <p className="font-mono text-xs text-muted-foreground mt-0.5">
                {row.slug}
              </p>
            </div>

            {/* Conversaciones */}
            <div className="flex items-center gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">
                Conversaciones:
              </span>
              <p className="font-mono text-sm font-bold text-foreground tabular-nums">
                {row.conversations}
              </p>
            </div>

            {/* % resueltas por IA */}
            <div className="flex items-center gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">
                Resueltas por IA:
              </span>
              <p className="font-mono text-sm text-foreground tabular-nums">
                {formatPercent(row.iaResolvedRate)}
              </p>
            </div>

            {/* $ recuperado */}
            <div className="flex items-center gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">
                Recuperado:
              </span>
              <p
                className={cn(
                  "font-mono text-sm tabular-nums",
                  row.recoveredValue > 0
                    ? "text-primary font-semibold"
                    : "text-muted-foreground",
                )}
              >
                {formatMoney(row.recoveredValue)}
              </p>
            </div>

            {/* Gasto LLM */}
            <div className="flex items-center gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">
                Gasto LLM:
              </span>
              <p className="font-mono text-sm text-foreground tabular-nums">
                {formatCost(row.llmCostUsd)}
              </p>
            </div>

            {/* Agentes activos */}
            <div className="flex items-center gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">
                Agentes:
              </span>
              <p className="font-mono text-sm text-foreground tabular-nums">
                {row.activeAgents}
              </p>
            </div>

            {/* Salud / última actividad */}
            <div className="flex items-center gap-2 md:block">
              <span className="text-xs text-muted-foreground md:hidden">
                Actividad:
              </span>
              <HealthDot
                lastActivityAt={row.lastActivityAt}
                openAlerts={row.openAlerts}
              />
            </div>

            {/* Acción: entrar al workspace */}
            <div className="flex items-center">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2.5 text-muted-foreground hover:text-foreground"
                aria-label={`Entrar al dashboard de ${row.name}`}
                onClick={() => handleEnter(row.id)}
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only sm:ml-1.5 text-xs">
                  Entrar
                </span>
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Refreshing indicator (mientras cambia de workspace) */}
      {refreshing && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}
