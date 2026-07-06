"use client";

// Fila editable de un ítem del onboarding: status, responsable, fecha límite,
// notas inline (guardado onBlur) y botón Copiar para los textos de envío.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  OnboardingItem,
  OnboardingItemPatch,
} from "@/features/onboarding-cliente/services/onboarding.service";

const STATUS_OPTIONS: Array<{ value: OnboardingItem["status"]; label: string }> = [
  { value: "pendiente", label: "Pendiente" },
  { value: "enviado", label: "Enviado" },
  { value: "recibido", label: "Recibido" },
  { value: "no_aplica", label: "No aplica" },
];

const OWNER_OPTIONS: Array<{ value: OnboardingItem["owner"]; label: string }> = [
  { value: "cliente", label: "Cliente" },
  { value: "nosotros", label: "Nosotros" },
];

const KIND_LABELS: Record<OnboardingItem["kind"], string> = {
  pregunta_hecha: "Pregunta",
  entregable: "Entregable",
  envio: "Para enviar",
};

const STATUS_BADGE: Record<OnboardingItem["status"], string> = {
  pendiente: "bg-warning/10 text-warning",
  enviado: "bg-info/10 text-info",
  recibido: "bg-success/10 text-success",
  no_aplica: "bg-muted text-muted-foreground",
};

interface OnboardingItemRowProps {
  item: OnboardingItem;
  /** Devuelve true si el guardado fue exitoso. */
  onPatch: (patch: OnboardingItemPatch) => Promise<boolean>;
}

export function OnboardingItemRow({ item, onPatch }: OnboardingItemRowProps) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const done = item.status === "recibido" || item.status === "no_aplica";

  async function save(patch: OnboardingItemPatch) {
    setSaving(true);
    try {
      await onPatch(patch);
    } finally {
      setSaving(false);
    }
  }

  async function handleCopy() {
    if (!item.detail) return;
    try {
      await navigator.clipboard.writeText(item.detail);
      setCopied(true);
      toast.success("Texto copiado, listo para pegar en WhatsApp");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("No se pudo copiar al portapapeles");
    }
  }

  return (
    <li className="px-4 py-3 space-y-2.5" aria-busy={saving}>
      {/* Label + badges + copiar */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p
            className={cn(
              "text-sm",
              done ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {item.label}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
              {KIND_LABELS[item.kind]}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
                STATUS_BADGE[item.status],
              )}
            >
              {STATUS_OPTIONS.find((s) => s.value === item.status)?.label}
            </span>
          </div>
        </div>

        {item.detail && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            aria-label={`Copiar texto: ${item.label}`}
            className="shrink-0"
          >
            {copied ? (
              <Check className="h-4 w-4 text-success" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="ml-2 hidden sm:inline">
              {copied ? "Copiado" : "Copiar"}
            </span>
          </Button>
        )}
      </div>

      {/* Texto copiable (preview) */}
      {item.detail && (
        <p className="text-xs text-muted-foreground whitespace-pre-line rounded-lg bg-muted/40 border border-border/30 px-3 py-2">
          {item.detail}
        </p>
      )}

      {/* Controles */}
      <div className="grid grid-cols-2 sm:grid-cols-[140px_130px_150px_1fr] gap-2">
        <Select
          value={item.status}
          disabled={saving}
          onValueChange={(value) =>
            save({ status: value as OnboardingItem["status"] })
          }
        >
          <SelectTrigger
            className="h-8 text-xs"
            aria-label={`Estado de: ${item.label}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={item.owner}
          disabled={saving}
          onValueChange={(value) =>
            save({ owner: value as OnboardingItem["owner"] })
          }
        >
          <SelectTrigger
            className="h-8 text-xs"
            aria-label={`Responsable de: ${item.label}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OWNER_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          defaultValue={item.due_date ?? ""}
          disabled={saving}
          aria-label={`Fecha límite de: ${item.label}`}
          className="h-8 text-xs font-mono"
          onBlur={(e) => {
            const value = e.target.value || null;
            if (value !== item.due_date) void save({ due_date: value });
          }}
        />

        <Input
          type="text"
          defaultValue={item.notes ?? ""}
          disabled={saving}
          placeholder="Notas…"
          aria-label={`Notas de: ${item.label}`}
          className="h-8 text-xs col-span-2 sm:col-span-1"
          onBlur={(e) => {
            const value = e.target.value.trim() || null;
            if (value !== item.notes) void save({ notes: value });
          }}
        />
      </div>
    </li>
  );
}
