"use client";

// Vista del onboarding del cliente: progreso, guión de la reunión y
// checklist por secciones. Recibe los ítems ya resueltos del server
// component y muta vía PATCH /api/workspace/[id]/onboarding/[itemId].

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { GuionReunion } from "./guion-reunion";
import { OnboardingItemRow } from "./onboarding-item-row";
import type {
  OnboardingItem,
  OnboardingItemPatch,
} from "@/features/onboarding-cliente/services/onboarding.service";

interface OnboardingClienteViewProps {
  workspaceId: string;
  workspaceName: string;
  initialItems: OnboardingItem[];
}

export function OnboardingClienteView({
  workspaceId,
  workspaceName,
  initialItems,
}: OnboardingClienteViewProps) {
  const router = useRouter();
  const [items, setItems] = useState<OnboardingItem[]>(initialItems);
  const [refreshing, startRefresh] = useTransition();

  // Mismo criterio que computeProgress del servicio (recibido + no_aplica).
  const progress = useMemo(() => {
    const total = items.length;
    const done = items.filter(
      (i) => i.status === "recibido" || i.status === "no_aplica",
    ).length;
    return {
      total,
      done,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  }, [items]);

  // Agrupa por sección preservando el orden de sort_order.
  const sections = useMemo(() => {
    const map = new Map<string, OnboardingItem[]>();
    for (const item of items) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    return [...map.entries()];
  }, [items]);

  async function patchItem(
    itemId: string,
    patch: OnboardingItemPatch,
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `/api/workspace/${workspaceId}/onboarding/${itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const body = (await res.json().catch(() => null)) as {
        item?: OnboardingItem;
        error?: string;
      } | null;

      if (!res.ok || !body?.item) {
        toast.error(body?.error ?? "No se pudo guardar el cambio");
        return false;
      }

      const updated = body.item;
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      return true;
    } catch {
      toast.error("Error de red al guardar el cambio");
      return false;
    }
  }

  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">
          Onboarding del cliente
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {workspaceName} · qué preguntar, qué enviar y qué falta para trabajar
          sin contactarlo hasta la demo
        </p>
      </div>

      {/* Progreso */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
            Progreso de requisitos
          </p>
          <p className="font-mono text-sm text-foreground tabular-nums">
            {progress.done}/{progress.total} · {progress.percent}%
          </p>
        </div>
        <Progress
          value={progress.percent}
          aria-label={`Progreso del onboarding: ${progress.percent}%`}
        />
        <p className="text-xs text-muted-foreground">
          Recibido y No aplica cuentan como completados. Con todo en verde se
          puede construir el agente sin volver a contactar al cliente hasta la
          demo del MVP.
        </p>
      </div>

      {/* Guión de la reunión */}
      <GuionReunion />

      {/* Checklist por secciones */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card px-5 py-10 text-center space-y-3">
          <ClipboardCheck
            className="h-6 w-6 text-muted-foreground mx-auto"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-medium text-foreground">
              Sin ítems de onboarding
            </p>
            <p className="text-sm text-muted-foreground mt-0.5">
              El checklist estándar se genera al recargar la página.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            <RefreshCw
              className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              aria-hidden="true"
            />
            <span className="ml-2">Recargar</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map(([sectionName, sectionItems]) => {
            const sectionDone = sectionItems.filter(
              (i) => i.status === "recibido" || i.status === "no_aplica",
            ).length;
            return (
              <section key={sectionName} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-sm font-semibold text-foreground">
                    {sectionName}
                  </h2>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {sectionDone}/{sectionItems.length}
                  </span>
                </div>
                <ul
                  role="list"
                  className="rounded-xl border border-border/50 bg-card divide-y divide-border/30 overflow-hidden"
                >
                  {sectionItems.map((item) => (
                    <OnboardingItemRow
                      key={item.id}
                      item={item}
                      onPatch={(patch) => patchItem(item.id, patch)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
