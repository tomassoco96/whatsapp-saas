import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/tool";

const schema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Término de búsqueda tal como lo dijo el cliente (ej: 'pijama de invierno')",
    ),
  category_slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Slug de categoría de la tienda, si se conoce"),
  product_slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Slug exacto del producto, si se conoce"),
  product_url: z
    .string()
    .trim()
    .url()
    .max(300)
    .optional()
    .describe("Link completo que pegó el cliente (producto o categoría)"),
  brand: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Marca que pidió el cliente (Brogas, Broksol, Brolux, Brosen, Broktools, Ayreco). Pasala cuando el cliente nombre una marca: prioriza los productos de esa marca en el resultado.",
    ),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

type Args = z.infer<typeof schema>;

async function run(args: Args, ctx: ToolContext): Promise<ToolResult> {
  const { getEcommerceConnection, searchProductsFor } = await import(
    "../../ecommerce/services/provider"
  );

  const conn = await getEcommerceConnection(ctx.workspaceId);
  if (!conn) {
    return {
      ok: false,
      output: null,
      error:
        "No hay una tienda conectada para este workspace (WooCommerce, Tiendanube o Shopify)",
    };
  }

  if (
    !args.query &&
    !args.category_slug &&
    !args.product_slug &&
    !args.product_url
  ) {
    return {
      ok: false,
      output: null,
      error: "Se requiere query, category_slug, product_slug o product_url",
    };
  }

  const result = await searchProductsFor(conn, {
    query: args.query,
    categorySlug: args.category_slug,
    productSlug: args.product_slug,
    productUrl: args.product_url,
    brand: args.brand,
    limit: args.limit,
  });

  return { ok: true, output: result };
}

export const buscarProductoTool: Tool<Args> = {
  name: "buscar_producto",
  description:
    "Busca productos REALES en el catálogo de la tienda conectada (WooCommerce, Tiendanube o Shopify): precio, stock y link. Úsalo SIEMPRE que el cliente pregunte por un producto, precio o stock — nunca inventes precios ni links. Acepta término de búsqueda, link de producto/categoría o slug.",
  sensitivity: "read",
  schema,
  enabledFor: () => true,
  run,
};
