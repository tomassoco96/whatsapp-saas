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
      "Teléfono con el que se hizo el pedido, si el cliente lo aporta (sirve para verificar que el pedido es suyo cuando busca por número)",
    ),
  email: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Email con el que se hizo el pedido, si el cliente lo aporta (verifica propiedad al buscar por número)",
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

  // Teléfono del contacto de ESTE chat (SEC-01: anclado server-side, el LLM no
  // lo controla). Se usa como término de búsqueda cuando no hay número de orden,
  // y SIEMPRE como prueba de propiedad cuando se busca por número (para no
  // revelar el pedido de otra persona con solo tirar un ID secuencial).
  const supabase = svc();
  const { data: contact } = await supabase
    .from("contacts")
    .select("phone")
    .eq("id", ctx.contactId)
    .maybeSingle();
  const contactPhone = (contact as { phone?: string } | null)?.phone ?? undefined;

  const phone = args.phone ?? (args.order_id === undefined ? contactPhone : undefined);

  if (args.order_id === undefined && !phone) {
    return {
      ok: false,
      output: null,
      error:
        "No hay número de orden ni teléfono para buscar; pedile al cliente el número de orden",
    };
  }

  const result = await lookupOrderFor(
    conn,
    { orderId: args.order_id, phone, email: args.email, contactPhone },
    { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId },
  );

  return { ok: true, output: result };
}

export const estadoPedidoTool: Tool<Args> = {
  name: "estado_pedido",
  description:
    "Consulta el estado REAL de un pedido en la tienda conectada (WooCommerce, Tiendanube o Shopify) por número de orden o por teléfono. Úsalo SIEMPRE que el cliente pregunte por su pedido, envío o demora — nunca inventes estados. Si no da número de orden, busca por el teléfono de este chat. Al buscar por número, el sistema verifica que el pedido sea del cliente (por el teléfono del chat o el teléfono/email que aporte); si no coincide, te pide ese dato — pasáselo en phone/email.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
