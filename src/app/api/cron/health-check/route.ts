import { NextResponse } from "next/server";
import { runHealthCheck } from "@/features/agency/services/health-alerts.service";

// ──────────────────────────────────────────────────────────────────────────────
// Cron: alertas de salud por workspace, cada 15 minutos (mismo esquema que
// buffer-flush / recovery-touch: pg_cron + pg_net → este endpoint).
// Auth: Bearer CRON_SECRET.
//
// Evalúa reglas baratas sobre datos que ya existen (buffer trabado, silencio
// anómalo, gasto LLM anómalo, errores de tools) y sincroniza la tabla
// workspace_alerts con dedupe por (workspace, type) y auto-resolución.
// Ver health-alerts.service.ts / health-rules.ts.
// ──────────────────────────────────────────────────────────────────────────────

export const schedule = "*/15 * * * *";
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runHealthCheck();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
