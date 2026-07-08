import { createClient as createSbClient } from "@supabase/supabase-js";
import { normalizeCuit } from "../lib/cuit";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface AccountStatusResult {
  ok: boolean;
  authorized: boolean;
  message: string;
}

/**
 * Consulta de cuenta corriente para VENDEDORES internos.
 *
 * Seguridad (correccion sobre v1, donde el telefono lo rellenaba el LLM):
 * 1. La identidad es el telefono del CANAL (senderPhone viene del ToolContext,
 *    anclado server-side — el LLM no puede inventarlo).
 * 2. Ownership: el CUIT consultado debe estar en la cartera del vendedor
 *    (vendedor_clientes).
 *
 * El dato real de saldo vive en el ERP (Flexus, Etapa 2): hoy se valida
 * identidad + ownership y se deriva a administracion registrando el evento
 * para seguimiento — el vendedor recibe una respuesta honesta, no inventada.
 */
export async function lookupAccountStatus(input: {
  workspaceId: string;
  senderPhone: string;
  clienteCuit: string;
}): Promise<AccountStatusResult> {
  try {
    const supabase = svc();
    const { workspaceId, senderPhone } = input;

    const { data: vendedor } = await supabase
      .from("vendedores")
      .select("id, nombre")
      .eq("workspace_id", workspaceId)
      .eq("telefono", senderPhone)
      .eq("activo", true)
      .maybeSingle();

    if (!vendedor) {
      return {
        ok: true,
        authorized: false,
        message:
          "Las consultas de cuenta corriente son solo para vendedores de la empresa desde su número registrado. Si sos cliente, tu vendedor de zona puede ayudarte con eso.",
      };
    }

    const cuit = normalizeCuit(input.clienteCuit);
    const { data: cartera } = await supabase
      .from("vendedor_clientes")
      .select("cliente_nombre")
      .eq("workspace_id", workspaceId)
      .eq("vendedor_id", (vendedor as { id: string }).id)
      .eq("cliente_cuit", cuit)
      .maybeSingle();

    if (!cartera) {
      return {
        ok: true,
        authorized: false,
        message: "Ese cliente no figura en tu cartera, no puedo pasarte esa información.",
      };
    }

    // Identidad y ownership OK — el saldo real requiere el ERP (Etapa 2).
    await supabase.from("events").insert({
      workspace_id: workspaceId,
      type: "cuenta_corriente_consulta",
      level: "info",
      payload: {
        vendedor: (vendedor as { nombre: string }).nombre,
        cliente_cuit: cuit,
        detalle: "Consulta autorizada; sin ERP conectado, derivada a administración.",
      },
    });

    return {
      ok: true,
      authorized: true,
      message:
        "Lo estoy consultando con administración y te confirmo el saldo a la brevedad. Quedó registrado tu pedido.",
    };
  } catch (e) {
    console.error("[mayorista] lookupAccountStatus error:", (e as Error).message);
    return {
      ok: false,
      authorized: false,
      message: "No pude consultar en este momento, lo veo con la oficina y te aviso.",
    };
  }
}
