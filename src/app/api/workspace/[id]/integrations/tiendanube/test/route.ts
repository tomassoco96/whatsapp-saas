import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { getTnConfig } from "@/features/ecommerce/services/tn-config";
import { pingTiendanube } from "@/features/ecommerce/services/tn-client";

/**
 * POST /api/workspace/[id]/integrations/tiendanube/test
 * Prueba la conexión con la tienda: catálogo (products) y pedidos (orders)
 * con el access token de la integración. Mismo patrón que el test de
 * WooCommerce/YCloud/HighLevel.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const cfg = await getTnConfig(workspaceId);
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      error:
        "La integración Tiendanube no está guardada o faltan store ID / access token",
    });
  }

  const result = await pingTiendanube(cfg);
  return NextResponse.json(result);
}
