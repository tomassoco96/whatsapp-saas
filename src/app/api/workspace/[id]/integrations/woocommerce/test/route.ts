import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { getWcConfig } from "@/features/ecommerce/services/wc-config";
import { pingWooCommerce } from "@/features/ecommerce/services/wc-client";

/**
 * POST /api/workspace/[id]/integrations/woocommerce/test
 * Prueba la conexión con la tienda: Store API pública (catálogo) y, si hay
 * consumer keys, la REST v3 autenticada (pedidos). Mismo patrón que el test
 * de YCloud/HighLevel.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const cfg = await getWcConfig(workspaceId);
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      error:
        "La integración WooCommerce no está guardada o la URL de la tienda no es https",
    });
  }

  const result = await pingWooCommerce(cfg);
  return NextResponse.json(result);
}
