"use client";

// Guión estático de la reunión de onboarding. Contenido fijo en TSX
// (no viene de la DB): es el machete que el operador lee durante la llamada.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const PREGUNTAS_NEGOCIO = [
  "¿Qué vendés y cuáles son tus 5 productos estrella?",
  "¿Quién es tu cliente típico?",
  "¿Qué te preguntan TODOS los días por WhatsApp? (top 5)",
  "¿Cuántas consultas por día reciben y quién las responde hoy?",
  "¿Cuánto tardan en responder y qué pasa fuera de horario?",
  "¿Cómo es el proceso desde que alguien pregunta hasta que compra?",
  "¿Qué objeciones aparecen siempre (precio, envío, talles)?",
  "¿Casos especiales: mayoristas, pedidos custom, reclamos?",
  "¿Promos vigentes y cómo las comunican?",
  "¿Qué NO debería decir o hacer jamás el agente?",
];

const COMO_FUNCIONA = [
  "El agente responde por WhatsApp con el catálogo y pedidos reales.",
  "Usa la API oficial de Meta (vía YCloud): necesitan un portfolio comercial de Meta (Business Manager) verificado y un número dedicado.",
  "Si hay recuperación de carritos: los mensajes salientes usan plantillas que Meta aprueba (demora días, idioma exacto).",
  "Panel con inbox humano (pueden intervenir cuando quieran) y reporte mensual con $ recuperado.",
];

const LO_QUE_NECESITO = [
  "Recorrer el checklist de accesos según su plataforma.",
  "Plugins a instalar (les mandamos tutorial).",
  "Logo + export de chats.",
  "Políticas y datos bancarios por escrito.",
  "Comprometer FECHA para cada pendiente.",
];

const CIERRE = [
  "Timeline: accesos días 1-2 → demo MVP → 1-2 semanas de iteración → go-live.",
  "Canal único de comunicación.",
  "“No los contacto hasta la demo salvo que falte algo de la lista.”",
];

function Bloque({
  titulo,
  children,
}: {
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h3 className="font-display text-sm font-semibold text-foreground">
        {titulo}
      </h3>
      {children}
    </div>
  );
}

function Lista({ items, ordenada = false }: { items: string[]; ordenada?: boolean }) {
  const className = "space-y-1 pl-5 text-sm text-muted-foreground";
  const rows = items.map((texto) => <li key={texto}>{texto}</li>);
  return ordenada ? (
    <ol className={cn(className, "list-decimal")}>{rows}</ol>
  ) : (
    <ul className={cn(className, "list-disc")}>{rows}</ul>
  );
}

export function GuionReunion() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="guion-reunion-contenido"
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/20 transition-colors"
      >
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold text-foreground">
            Guión de la reunión
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Apertura · El negocio · Cómo funciona lo nuestro · Lo que necesito ·
            Cierre (~45-50 min)
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground shrink-0 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          id="guion-reunion-contenido"
          className="px-5 pb-5 pt-4 space-y-5 border-t border-border/30"
        >
          <Bloque titulo="Apertura (5')">
            <p className="text-sm text-muted-foreground">
              Presentarse, agenda, objetivo:{" "}
              <span className="text-foreground">
                &ldquo;salgo de esta llamada pudiendo construir tu agente sin
                molestarte hasta la demo&rdquo;
              </span>
              .
            </p>
          </Bloque>

          <Bloque titulo="El negocio (15-20')">
            <p className="text-xs text-muted-foreground mb-1.5">
              Preguntas en orden:
            </p>
            <Lista items={PREGUNTAS_NEGOCIO} ordenada />
          </Bloque>

          <Bloque titulo="Cómo funciona lo nuestro (10')">
            <Lista items={COMO_FUNCIONA} />
          </Bloque>

          <Bloque titulo="Lo que necesito de ustedes (10')">
            <Lista items={LO_QUE_NECESITO} />
          </Bloque>

          <Bloque titulo="Cierre (5')">
            <Lista items={CIERRE} />
          </Bloque>
        </div>
      )}
    </div>
  );
}
