import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAgencyRollup,
  resolvePeriod,
  rollupToCsv,
} from "@/features/agency/services/agency-metrics";

async function assertSuperAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from("users")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  return data?.is_super_admin === true;
}

// GET /api/agency/export?periodo=actual|anterior — CSV de uso por workspace
// (insumo de facturación de la agencia: conversaciones, $ recuperado, gasto LLM).
export async function GET(req: NextRequest) {
  const allowed = await assertSuperAdmin();
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const period = resolvePeriod(
    req.nextUrl.searchParams.get("periodo") ?? undefined,
  );
  const result = await getAgencyRollup(period);

  if (result.error !== undefined) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  const csv = rollupToCsv(result.rollup, period);

  // BOM para que Excel abra el UTF-8 sin romper acentos.
  const bom = String.fromCharCode(0xfeff);
  return new NextResponse(bom + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="uso-agencia-${period.monthKey}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
