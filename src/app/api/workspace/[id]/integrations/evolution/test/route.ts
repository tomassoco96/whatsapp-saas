import { NextRequest, NextResponse } from "next/server";
import { createClient as svcClient } from "@supabase/supabase-js";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";
import { fetchInstanceState } from "@/features/inbox/services/evolution-client";

// POST /api/workspace/[id]/integrations/evolution/test
// Prueba la conexión con el servidor Evolution y devuelve el estado de la
// instancia ("open" = vinculada a WhatsApp; otro valor = falta escanear QR).

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const auth = await requireWorkspaceMember(workspaceId);
  if (!auth.ok) return auth.response;

  const svc = svcClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data } = await svc
    .from("integrations")
    .select("credentials, config")
    .eq("workspace_id", workspaceId)
    .eq("provider", "evolution")
    .single();

  const creds = data?.credentials as { evolution_api_key?: string } | null;
  const config = data?.config as {
    server_url?: string;
    instance_name?: string;
  } | null;

  if (!creds?.evolution_api_key || !config?.server_url || !config?.instance_name) {
    return NextResponse.json({
      ok: false,
      error: "Faltan datos: URL del servidor, API key o nombre de instancia",
    });
  }

  try {
    const { state } = await fetchInstanceState({
      serverUrl: config.server_url,
      apiKey: creds.evolution_api_key,
      instance: config.instance_name,
    });
    return NextResponse.json({ ok: true, state });
  } catch (err) {
    console.error(
      "[integrations/evolution/test] fetch error:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({
      ok: false,
      error: "No se pudo conectar con el servidor Evolution",
    });
  }
}
