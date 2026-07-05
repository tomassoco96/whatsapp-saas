import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getActiveWorkspace,
  listMemberships,
} from "@/features/workspace/services/active-workspace";
import { getMonthlyReport } from "@/features/reports/services/monthly-report";
import { MonthlyReportView } from "@/features/reports/components/monthly-report-view";

export const dynamic = "force-dynamic";

/** Últimos `count` meses en formato YYYY-MM, más reciente primero (UTC). */
function lastMonths(count: number): string[] {
  const months: string[] = [];
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  for (let i = 0; i < count; i++) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
  }
  return months;
}

function parseMes(mes: string | undefined, options: string[]): string {
  if (mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(mes) && options.includes(mes)) {
    return mes;
  }
  return options[0];
}

export default async function ReportesPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [membership, memberships, { mes }] = await Promise.all([
    getActiveWorkspace(supabase, user.id),
    listMemberships(supabase, user.id),
    searchParams,
  ]);

  if (!membership) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground text-sm">
          No tienes un workspace activo.
        </p>
      </div>
    );
  }

  const monthOptions = lastMonths(12);
  const selectedMonth = parseMes(mes, monthOptions);
  const [year, month] = selectedMonth.split("-").map(Number);

  const workspaceName =
    memberships.find((m) => m.workspace_id === membership.workspace_id)?.name ??
    "Workspace";

  const report = await getMonthlyReport(membership.workspace_id, year, month);

  return (
    <MonthlyReportView
      report={report}
      workspaceName={workspaceName}
      selectedMonth={selectedMonth}
      monthOptions={monthOptions}
    />
  );
}
