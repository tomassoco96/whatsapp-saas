// Reporte mensual del workspace — GET ?year=YYYY&month=M (mes calendario UTC).
// Mismo patrón de auth que .../integrations/woocommerce/test/route.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { getMonthlyReport } from "@/features/reports/services/monthly-report";

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    year: url.searchParams.get("year"),
    month: url.searchParams.get("month"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Parámetros inválidos: se espera ?year=YYYY&month=1-12" },
      { status: 400 },
    );
  }

  try {
    const report = await getMonthlyReport(
      workspaceId,
      parsed.data.year,
      parsed.data.month,
    );
    return NextResponse.json(report);
  } catch (err) {
    console.error("[reports/monthly] error:", err);
    return NextResponse.json(
      { error: "No se pudo generar el reporte" },
      { status: 500 },
    );
  }
}
