import { createClient as createSbClient } from "@supabase/supabase-js";
import { normalizeZona } from "../lib/zona";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface VendedorMatch {
  id: string;
  nombre: string;
  telefono: string | null;
  zona: string;
  /** true si la zona tiene mas de un vendedor con la misma prioridad top —
   *  el agente NO nombra al vendedor en ese caso ("un vendedor de tu zona"). */
  multiple: boolean;
}

/**
 * Resuelve el vendedor que cubre una zona del workspace. Intenta por localidad
 * y cae a provincia. Ordena por prioridad (1 = principal) y desempata por
 * nombre para que la asignacion sea deterministica.
 * Devuelve null = sin cobertura (el caller dispara alerta de asignacion manual).
 * NO lanza: ante error devuelve null.
 */
export async function resolveVendedor(
  workspaceId: string,
  input: { zonaText: string | null; provincia: string | null },
): Promise<VendedorMatch | null> {
  const candidates = [normalizeZona(input.zonaText), normalizeZona(input.provincia)]
    .filter((z): z is string => !!z);
  if (candidates.length === 0) return null;

  try {
    const supabase = svc();
    for (const zona of candidates) {
      const { data, error } = await supabase
        .from("vendedor_zonas")
        .select("zona, prioridad, vendedores!inner(id, nombre, telefono, activo)")
        .eq("workspace_id", workspaceId)
        .eq("zona", zona)
        .eq("vendedores.activo", true)
        .order("prioridad", { ascending: true });

      if (error || !data || data.length === 0) continue;

      type Row = {
        zona: string;
        prioridad: number;
        vendedores: { id: string; nombre: string; telefono: string | null };
      };
      const rows = (data as unknown as Row[]).sort(
        (a, b) =>
          a.prioridad - b.prioridad ||
          a.vendedores.nombre.localeCompare(b.vendedores.nombre),
      );
      const top = rows[0];
      const multiple =
        rows.filter((r) => r.prioridad === top.prioridad).length > 1;

      return {
        id: top.vendedores.id,
        nombre: top.vendedores.nombre,
        telefono: top.vendedores.telefono,
        zona: top.zona,
        multiple,
      };
    }
    return null;
  } catch (e) {
    console.warn("[mayorista] resolveVendedor error:", (e as Error).message);
    return null;
  }
}
