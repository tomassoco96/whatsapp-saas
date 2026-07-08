import { z } from "zod";
import { createClient as createSbClient } from "@supabase/supabase-js";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const optional = z.string().trim().min(1).max(200).optional();

const schema = z.object({
  nombre_contacto: optional.describe("Nombre y apellido de quien escribe"),
  razon_social: optional.describe("Razón social del comercio"),
  cuit: optional.describe("CUIT tal como lo dio el cliente (con o sin guiones)"),
  provincia: optional.describe("Provincia del comercio"),
  localidad: optional.describe("Localidad o ciudad del comercio"),
  email: optional.describe("Correo electrónico"),
  telefono: optional.describe("Teléfono que dio el cliente, si dio uno distinto al de este chat"),
  rubro: optional.describe("Rubro del comercio (ferretería, bazar, corralón...)"),
  formato_venta: optional.describe(
    "'Distribución' si revende a comercios, 'Venta al público' si vende al consumidor",
  ),
  comentarios: z.string().trim().max(1000).optional().describe("Comentarios adicionales del cliente"),
  rechaza_razon_social: z
    .boolean()
    .optional()
    .describe("true SOLO si el cliente dijo explícitamente que no tiene o no quiere dar razón social/CUIT"),
});

type Args = z.infer<typeof schema>;

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { qualifyLead } = await import(
    "../../mayorista/services/qualify.service"
  );

  // SEC-01: el telefono del lead es el del contacto de ESTA conversacion,
  // anclado server-side — el LLM no lo controla (correccion sobre v1/n8n).
  const supabase = svc();
  const { data: contact } = await supabase
    .from("contacts")
    .select("phone")
    .eq("id", ctx.contactId)
    .maybeSingle();
  const contactoPhone = (contact as { phone?: string } | null)?.phone;
  if (!contactoPhone) {
    return {
      ok: false,
      output: null,
      error: "No se pudo identificar el teléfono del contacto de esta conversación",
    };
  }

  const result = await qualifyLead({
    workspaceId: ctx.workspaceId,
    contactoPhone,
    nombreContacto: args.nombre_contacto,
    razonSocial: args.razon_social,
    cuit: args.cuit,
    provincia: args.provincia,
    localidad: args.localidad,
    email: args.email,
    telefono: args.telefono,
    rubro: args.rubro,
    formatoVenta: args.formato_venta,
    comentarios: args.comentarios,
    rechazaRazonSocial: args.rechaza_razon_social,
  });

  return { ok: result.ok, output: result };
}

export const calificarLeadTool: Tool<Args> = {
  name: "calificar_lead",
  description:
    "Registra o actualiza el lead MAYORISTA de esta conversación con los datos que el cliente fue dando. Llamalo cada vez que el cliente aporte un dato nuevo de la calificación (razón social, CUIT, zona, rubro...). El resultado te dice qué campos faltan (repreguntá uno por uno), si el CUIT es inválido, o el mensaje de cierre con el vendedor asignado. La validación del CUIT y la asignación de vendedor las hace el sistema — no las decidas vos.",
  sensitivity: "write",
  schema,
  enabledFor: () => true,
  run,
};
