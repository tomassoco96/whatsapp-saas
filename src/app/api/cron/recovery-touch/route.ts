import { NextResponse } from "next/server";
import { runRecoverySweep } from "@/features/ecommerce/services/recovery.service";

// ──────────────────────────────────────────────────────────────────────────────
// Cron: secuencia de toques de recuperación de carritos, cada 15 minutos
// (mismo esquema que buffer-flush: pg_cron + pg_net → este endpoint, o
// Vercel Cron en Pro). Auth: Bearer CRON_SECRET.
//
// El sweep aplica todas las guardas del v1: recovery habilitado por
// workspace, quiet hours, opt-out, re-verificación de pago e idempotencia
// (claim atómico sobre touches_sent). Ver recovery.service.ts.
// ──────────────────────────────────────────────────────────────────────────────

export const schedule = "*/15 * * * *";
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runRecoverySweep();
  return NextResponse.json({ ok: true, ...result });
}
