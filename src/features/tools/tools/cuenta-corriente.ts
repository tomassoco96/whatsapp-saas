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
  cliente_cuit: z
    .string()
    .trim()
    .min(8)
    .max(20)
    .describe("CUIT del cliente por el que pregunta el vendedor"),
});

type Args = z.infer<typeof schema>;

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { lookupAccountStatus } = await import(
    "../../mayorista/services/account-status.service"
  );

  // SEC-01: la identidad del vendedor es el telefono del CANAL de esta
  // conversacion — anclado server-side, el LLM no puede suplantarla.
  const supabase = svc();
  const { data: contact } = await supabase
    .from("contacts")
    .select("phone")
    .eq("id", ctx.contactId)
    .maybeSingle();
  const senderPhone = (contact as { phone?: string } | null)?.phone;
  if (!senderPhone) {
    return {
      ok: false,
      output: null,
      error: "No se pudo identificar el teléfono del remitente",
    };
  }

  const result = await lookupAccountStatus({
    workspaceId: ctx.workspaceId,
    senderPhone,
    clienteCuit: args.cliente_cuit,
  });

  return { ok: result.ok, output: result };
}

export const cuentaCorrienteTool: Tool<Args> = {
  name: "consultar_cuenta_corriente",
  description:
    "SOLO para vendedores internos de la empresa que preguntan por la cuenta corriente o facturas de un cliente de SU cartera. La identidad del vendedor se valida por el número de este chat — si no es un vendedor registrado, el sistema lo rechaza solo. Nunca compartas datos de cuenta corriente sin usar este tool.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
