import { NextRequest, NextResponse } from "next/server";
import { getWcConfig } from "@/features/ecommerce/services/wc-config";
import {
  verifyCartWebhookSecret,
  ingestAbandonedCart,
} from "@/features/ecommerce/services/cart-ingest.service";
import { abandonedCartWebhookSchema } from "@/features/ecommerce/schemas/cart";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/cart-abandoned/[workspaceId]
 * Webhook del plugin de carritos abandonados (Flujo A, multi-tenant).
 * Auth: header `X-Webhook-Secret` contra cart_webhook_secret de la
 * integración woocommerce del workspace. Idempotente por external_id.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;

  // La config exige integración woocommerce habilitada + store_url https.
  const cfg = await getWcConfig(workspaceId);
  if (!cfg || !cfg.cartWebhookSecret) {
    // 404 para no confirmar la existencia del workspace a un tercero
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Webhook no configurado" } },
      { status: 404 },
    );
  }

  if (
    !verifyCartWebhookSecret(
      cfg.cartWebhookSecret,
      req.headers.get("x-webhook-secret"),
    )
  ) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Secret inválido" } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Body JSON inválido" } },
      { status: 400 },
    );
  }

  const parsed = abandonedCartWebhookSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: issue.message,
          field: issue.path.join(".") || undefined,
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await ingestAbandonedCart(workspaceId, parsed.data);
    return NextResponse.json(
      {
        cart_id: result.cartId,
        deduped: result.deduped,
        contactable: result.contactable,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(
      "[cart-abandoned] error al ingerir carrito:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "No se pudo procesar el carrito",
        },
      },
      { status: 500 },
    );
  }
}
