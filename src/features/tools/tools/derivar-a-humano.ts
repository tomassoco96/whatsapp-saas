import { z } from "zod";
import { createClient as createSbClient } from "@supabase/supabase-js";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const schema = z.object({
  etiqueta: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "A quién/qué se deriva: el humano o motivo. Ej: santiago, esteban, nico, vendedor, lead-calificado, pago. Un slug corto, en minúsculas.",
    ),
  resumen: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "Resumen breve del caso para el humano que lo tome (máximo 2 líneas): qué pasó y qué necesita.",
    ),
  urgente: z
    .boolean()
    .default(false)
    .describe(
      "true SOLO para riesgo, lesión, amenaza legal o de escrache: el humano tiene que atenderlo de inmediato.",
    ),
});

type Args = z.infer<typeof schema>;

/**
 * Deriva la conversación a un humano: pausa la IA (handoff_pending), registra el
 * caso (etiqueta + resumen + urgencia) para que aparezca en el inbox, y etiqueta
 * al contacto para que se pueda rutear/filtrar. NO le manda un WhatsApp al humano
 * (el operador toma la conversación desde el inbox de la plataforma). El aviso
 * saliente al celular del humano requeriría un template de Meta (YCloud) — es un
 * agregado aparte.
 */
async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const supabase = svc();

  try {
    // 1. Pausar la IA: pasar a handoff_pending SOLO si está en ai_active (el
    //    .eq('state','ai_active') hace la transición atómica e idempotente: si ya
    //    está en un estado humano, no la pisa).
    await supabase
      .from("conversations")
      .update({
        state: "handoff_pending",
        ai_enabled: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ctx.conversationId)
      .eq("state", "ai_active");

    // 2. Registrar el handoff: surface en el inbox/dashboard + observabilidad.
    await supabase.from("events").insert({
      type: "handoff_requested",
      level: args.urgente ? "warn" : "info",
      workspace_id: ctx.workspaceId,
      conversation_id: ctx.conversationId,
      payload: {
        etiqueta: args.etiqueta,
        resumen: args.resumen,
        urgente: args.urgente,
        contact_id: ctx.contactId,
        actor: "ai",
      },
    });

    // 3. Etiquetar el contacto (para rutear/filtrar en el inbox), sin duplicar.
    const { data: contact } = await supabase
      .from("contacts")
      .select("tags")
      .eq("id", ctx.contactId)
      .maybeSingle();
    const existing = Array.isArray((contact as { tags?: string[] } | null)?.tags)
      ? ((contact as { tags: string[] }).tags)
      : [];
    const tag = `derivar:${args.etiqueta}`;
    if (!existing.includes(tag)) {
      await supabase
        .from("contacts")
        .update({ tags: [...existing, tag] })
        .eq("id", ctx.contactId);
    }

    return {
      ok: true,
      output: {
        derivado: true,
        etiqueta: args.etiqueta,
        urgente: args.urgente,
        // El agente igual le da al cliente un cierre humano ("lo paso con X");
        // este output es interno.
        nota: "Conversación derivada. La IA queda en pausa hasta que un humano la retome.",
      },
    };
  } catch (err) {
    // No romper el turno: si falla, el agente igual responde al cliente.
    console.error(
      "[derivar_a_humano] error:",
      err instanceof Error ? err.message : "unknown",
    );
    return {
      ok: false,
      output: null,
      error: "No se pudo registrar la derivación",
    };
  }
}

export const derivarAHumanoTool: Tool<Args> = {
  name: "derivar_a_humano",
  description:
    "Deriva la conversación a un humano cuando el caso lo amerita (riesgo/lesión, garantía sensible, cliente muy enojado, o algo que no podés resolver). Pausa la IA y deja el caso registrado para que la persona correcta lo tome. Llamalo UNA sola vez por caso. Pasás: etiqueta (a quién/qué), resumen (máx 2 líneas), urgente (true para riesgo/legal). Después dale al cliente un cierre humano nombrando a la persona con naturalidad.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
