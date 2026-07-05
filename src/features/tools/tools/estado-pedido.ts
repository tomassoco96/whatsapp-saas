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
  order_id: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Número de orden que dio el cliente (ej: 1234)"),
  phone: z
    .string()
    .min(6)
    .max(30)
    .optional()
    .describe(
      "Teléfono con el que se hizo el pedido, SOLO si el cliente dio uno distinto al de este chat",
    ),
});

type Args = z.infer<typeof schema>;

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getEcommerceConnection, connectionCanLookupOrders, lookupOrderFor } =
    await import("../../ecommerce/services/provider");

  const conn = await getEcommerceConnection(ctx.workspaceId);
  if (!conn) {
    return {
      ok: false,
      output: null,
      error:
        "No hay una tienda conectada para este workspace (WooCommerce, Tiendanube o Shopify)",
    };
  }
  if (!(await connectionCanLookupOrders(conn))) {
    return {
      ok: false,
      output: null,
      error: "Faltan las credenciales de la tienda para consultar pedidos",
    };
  }

  // Sin order_id ni phone explícito, usamos el teléfono del contacto de ESTA
  // conversación (SEC-01: viene anclado server-side, el LLM no lo controla).
  let phone = args.phone;
  if (args.order_id === undefined && !phone) {
    const supabase = svc();
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone")
      .eq("id", ctx.contactId)
      .maybeSingle();
    phone = (contact as { phone?: string } | null)?.phone ?? undefined;
    if (!phone) {
      return {
        ok: false,
        output: null,
        error:
          "No hay número de orden ni teléfono para buscar; pedile al cliente el número de orden",
      };
    }
  }

  const result = await lookupOrderFor(
    conn,
    { orderId: args.order_id, phone },
    { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId },
  );

  return { ok: true, output: result };
}

export const estadoPedidoTool: Tool<Args> = {
  name: "estado_pedido",
  description:
    "Consulta el estado REAL de un pedido en la tienda conectada (WooCommerce, Tiendanube o Shopify) por número de orden o por teléfono. Úsalo SIEMPRE que el cliente pregunte por su pedido, envío o demora — nunca inventes estados. Si no da número de orden, busca solo por el teléfono de este chat.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
