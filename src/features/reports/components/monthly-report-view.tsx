"use client";

import { useRouter } from "next/navigation";
import {
  Bot,
  DollarSign,
  MessageCircle,
  Printer,
  Cpu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MonthlyReport } from "@/features/reports/services/monthly-report";

interface MonthlyReportViewProps {
  report: MonthlyReport;
  workspaceName: string;
  /** Mes seleccionado en formato YYYY-MM. */
  selectedMonth: string;
  /** Opciones de meses (YYYY-MM), más reciente primero. */
  monthOptions: string[];
}

// ── Formatters (duplicados por convención del repo, no hay lib compartida) ──

function formatMoney(value: number): string {
  return `$${value.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

function formatUsd(value: number): string {
  return `US$ ${value.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const label = new Intl.DateTimeFormat("es-MX", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ── KPI card (patrón canónico de dashboard-metrics / recovery-dashboard) ────

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

// ── Tabla de detalle (div-grid, patrón del repo) ────────────────────────────

interface DetailRow {
  label: string;
  value: string;
}

function DetailSection({ title, rows }: { title: string; rows: DetailRow[] }) {
  return (
    <div className="space-y-2 break-inside-avoid">
      <h3 className="font-display text-sm font-semibold text-foreground">
        {title}
      </h3>
      <div className="rounded-xl border border-border/50 bg-card divide-y divide-border/30 overflow-hidden">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-3 px-4 py-2.5"
          >
            <span className="text-sm text-muted-foreground">{row.label}</span>
            <span className="font-mono text-sm font-medium text-foreground tabular-nums">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Vista principal ─────────────────────────────────────────────────────────

export function MonthlyReportView({
  report,
  workspaceName,
  selectedMonth,
  monthOptions,
}: MonthlyReportViewProps) {
  const router = useRouter();
  const { carts, conversations, llm } = report;

  const cartRows: DetailRow[] = [
    { label: "Carritos abandonados ingresados", value: carts.total.toLocaleString("es") },
    { label: "Carritos contactados por WhatsApp", value: carts.contacted.toLocaleString("es") },
    { label: "Carritos recuperados", value: carts.recovered.toLocaleString("es") },
    { label: "$ recuperado (atribución directa)", value: formatMoney(carts.recoveredValue) },
    { label: "Conversión (recuperados / contactados)", value: formatPercent(carts.conversionRate) },
    { label: "Toques de recupero enviados", value: carts.touchesSent.toLocaleString("es") },
  ];

  const conversationRows: DetailRow[] = [
    { label: "Conversaciones con actividad", value: conversations.total.toLocaleString("es") },
    { label: "Resueltas por la IA (sin intervención)", value: conversations.aiResolved.toLocaleString("es") },
    { label: "Derivadas a humano (handoff)", value: conversations.handedOff.toLocaleString("es") },
    { label: "% resueltas por IA", value: formatPercent(conversations.aiResolvedRate) },
    { label: "Mensajes recibidos", value: conversations.messagesIn.toLocaleString("es") },
    { label: "Mensajes enviados", value: conversations.messagesOut.toLocaleString("es") },
    { label: "Templates de WhatsApp enviados", value: conversations.templatesSent.toLocaleString("es") },
  ];

  const costRows: DetailRow[] = [
    { label: "Llamadas al modelo", value: llm.calls.toLocaleString("es") },
    { label: "Tokens consumidos", value: llm.totalTokens.toLocaleString("es") },
    { label: "Gasto LLM estimado", value: formatUsd(llm.estimatedCostUsd) },
  ];

  return (
    <div className="report-print-root p-6 space-y-8 max-w-5xl mx-auto">
      {/* CSS print-friendly: oculta navegación/controles y fuerza tinta oscura */}
      <style>{`
        @media print {
          header, nav, .report-no-print { display: none !important; }
          body { background: #fff !important; }
          .report-print-root { max-width: none !important; padding: 0 !important; }
          .report-print-root, .report-print-root * {
            color: #111 !important;
            background: transparent !important;
            border-color: #d4d4d4 !important;
            box-shadow: none !important;
          }
          .report-print-root .break-inside-avoid { break-inside: avoid; }
        }
      `}</style>

      {/* Header + controles */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">
            Reporte mensual
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {workspaceName} · {monthLabel(selectedMonth)}
          </p>
        </div>

        <div className="report-no-print flex items-center gap-2">
          <Select
            value={selectedMonth}
            onValueChange={(value) => router.push(`/reportes?mes=${value}`)}
          >
            <SelectTrigger className="w-[180px]" aria-label="Elegir mes">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {monthOptions.map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            aria-label="Imprimir reporte"
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
            <span className="ml-2">Imprimir</span>
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="$ recuperado"
          value={formatMoney(carts.recoveredValue)}
          icon={<DollarSign className="h-4 w-4" aria-hidden="true" />}
          accent
        />
        <KpiCard
          label="Conversaciones"
          value={conversations.total.toLocaleString("es")}
          icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="% resueltas por IA"
          value={formatPercent(conversations.aiResolvedRate)}
          icon={<Bot className="h-4 w-4" aria-hidden="true" />}
        />
        <KpiCard
          label="Gasto LLM"
          value={formatUsd(llm.estimatedCostUsd)}
          icon={<Cpu className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      {/* Detalle */}
      {carts.total === 0 && conversations.total === 0 && llm.calls === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card px-5 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Sin actividad registrada en {monthLabel(selectedMonth)}. Elegí otro
            mes en el selector.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <DetailSection
            title="Recuperación de carritos"
            rows={cartRows}
          />
          <DetailSection
            title="Conversaciones"
            rows={conversationRows}
          />
          <DetailSection title="Costos de IA" rows={costRows} />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Gasto LLM estimado con tarifa blended. El costo de templates de Meta no
        está incluido (no se trackea todavía). Mes calendario en UTC.
      </p>
    </div>
  );
}
