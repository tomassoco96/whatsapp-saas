import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { getShopifyConfig } from "@/features/ecommerce/services/shopify-config";
import { pingShopify } from "@/features/ecommerce/services/shopify-client";

/**
 * POST /api/workspace/[id]/integrations/shopify/test
 * Prueba la conexión con la tienda: catálogo (products) y pedidos (orders)
 * vía la Admin API GraphQL. Mismo patrón que el test de WooCommerce.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const cfg = await getShopifyConfig(workspaceId);
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      error:
        "La integración Shopify no está guardada o faltan shop domain (xxx.myshopify.com) / access token",
    });
  }

  const result = await pingShopify(cfg);
  return NextResponse.json(result);
}
