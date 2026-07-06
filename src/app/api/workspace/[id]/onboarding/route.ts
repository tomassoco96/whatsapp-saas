// Onboarding del cliente — GET: ítems del workspace (seed lazy) + progreso.
// Mismo patrón de auth que .../reports/monthly/route.ts.

import { NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import {
  computeProgress,
  getOrSeedItems,
} from "@/features/onboarding-cliente/services/onboarding.service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  try {
    const items = await getOrSeedItems(workspaceId);
    return NextResponse.json({ items, progress: computeProgress(items) });
  } catch (err) {
    console.error("[onboarding] GET error:", err);
    return NextResponse.json(
      { error: "No se pudo cargar el onboarding" },
      { status: 500 },
    );
  }
}
