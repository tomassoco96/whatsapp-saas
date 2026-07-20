import { NextResponse } from "next/server";
import { processNextBatch } from "@/features/inbox/services/buffer";

// ──────────────────────────────────────────────────────────────────────────────
// Vercel Cron: process buffer batches every minute
//
// For production at scale, consider:
//   - pg_cron every 5s for lower latency
//   - pgmq (message queue) for fan-out across multiple workers
//
// Vercel sets Authorization: Bearer {CRON_SECRET} automatically when the
// cron job is configured in vercel.json.
// ──────────────────────────────────────────────────────────────────────────────

export const schedule = "* * * * *";

// Cada batch es LLM + tools (decenas de segundos). Sin este límite, el default
// de Vercel (~10-15s) mataba el cron a mitad de un batch, dejándolo 'processing'
// colgado hasta el reclaim de 5 min — la fuente del "un minuto más tarde" del
// item 5. Igual que los webhooks y los otros crons.
export const maxDuration = 60;

// Tope de batches por tick y presupuesto de tiempo: se corta antes de que Vercel
// mate la función a mitad de un batch.
const MAX_BATCHES_PER_RUN = 10;
const TIME_BUDGET_MS = 50_000;

export async function GET(request: Request): Promise<NextResponse> {
  // Verify Vercel cron auth header
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const results: Array<{ processed: boolean; error?: string }> = [];

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    // Cortar si no queda margen para otro batch dentro del presupuesto.
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;

    const result = await processNextBatch();
    results.push(result);

    // No more ready batches — stop early
    if (!result.processed) break;
  }

  const processedCount = results.filter((r) => r.processed).length;

  return NextResponse.json({ ok: true, processed: processedCount });
}
