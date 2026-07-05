import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAgencyRollup,
  resolvePeriod,
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

// GET /api/agency/metrics?periodo=actual|anterior — roll-up consolidado por workspace
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

  return NextResponse.json({ period, ...result.rollup });
}
