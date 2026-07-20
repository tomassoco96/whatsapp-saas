import { createClient as createSbClient } from "@supabase/supabase-js";
import { isValidCuit } from "../lib/cuit";
import {
  computeMissing,
  nextBlockMissing,
  missingLabels,
  type LeadFields,
} from "../lib/missing-fields";
import { resolveListaPrecio, type ListaPrecio } from "../lib/lista-precio";
import { resolveVendedor } from "./resolve.service";
import { notifyVendedorLead } from "./vendor-alert.service";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const DERIVATION_MSG =
  "Dame un momento que lo coordino con el equipo y te respondo a la brevedad.";

export type LeadEstado =
  | "incompleto"
  | "pendiente_calificacion"
  | "calificado"
  | "asignado"
  | "rechazado_sin_razon_social";

export interface QualifyLeadInput {
  workspaceId: string;
  /** Telefono del CANAL (anclado server-side por el tool, no del LLM). */
  contactoPhone: string;
  nombreContacto?: string | null;
  razonSocial?: string | null;
  cuit?: string | null;
  provincia?: string | null;
  localidad?: string | null;
  email?: string | null;
  telefono?: string | null;
  rubro?: string | null;
  formatoVenta?: string | null;
  comentarios?: string | null;
  /** true si el cliente dijo explicitamente que no tiene/da razon social o CUIT. */
  rechazaRazonSocial?: boolean;
}

export interface QualifyLeadResult {
  ok: boolean;
  estado: LeadEstado;
  camposFaltantes: string[];
  vendedor?: { nombre: string; zona: string } | null;
  message: string;
}

/** Fila de `leads_mayorista` (snake_case, como la DB). */
interface LeadRow {
  contacto_phone: string;
  nombre_contacto: string | null;
  razon_social: string | null;
  cuit: string | null;
  provincia: string | null;
  localidad: string | null;
  email: string | null;
  telefono: string | null;
  rubro: string | null;
  formato_venta: string | null;
  comentarios: string | null;
  lista_precio: ListaPrecio | null;
  estado: LeadEstado;
  incompleto: boolean;
}

function inputToRow(input: QualifyLeadInput): Partial<LeadRow> {
  return {
    contacto_phone: input.contactoPhone,
    nombre_contacto: input.nombreContacto ?? null,
    razon_social: input.razonSocial ?? null,
    cuit: input.cuit ?? null,
    provincia: input.provincia ?? null,
    localidad: input.localidad ?? null,
    email: input.email ?? null,
    telefono: input.telefono ?? null,
    rubro: input.rubro ?? null,
    formato_venta: input.formatoVenta ?? null,
    comentarios: input.comentarios ?? null,
  };
}

/** Merge no destructivo: un valor entrante vacio NO pisa uno ya cargado. */
function mergeNonDestructive(
  existing: Partial<LeadRow> | null,
  incoming: Partial<LeadRow>,
): Partial<LeadRow> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    const empty =
      v === null ||
      v === undefined ||
      (typeof v === "string" && v.trim() === "");
    if (!empty) out[k] = v;
  }
  return out as Partial<LeadRow>;
}

function rowToFields(row: Partial<LeadRow>): LeadFields {
  // email y telefono NO son obligatorios → no entran en el cálculo de faltantes.
  return {
    nombreContacto: row.nombre_contacto,
    razonSocial: row.razon_social,
    cuit: row.cuit,
    provincia: row.provincia,
    localidad: row.localidad,
    rubro: row.rubro,
    formatoVenta: row.formato_venta,
  };
}

/** Alerta interna en `events` (visible en observabilidad del workspace). */
async function recordAlert(
  workspaceId: string,
  tipo: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await svc()
      .from("events")
      .insert({ workspace_id: workspaceId, type: tipo, level: "warn", payload });
  } catch {
    // fire-and-forget
  }
}

/**
 * Califica un lead mayorista. Es la AUTORIDAD de que falta (no el LLM). Hace
 * upsert no destructivo por (workspace, telefono del canal), aplica el gate
 * razon social + CUIT valido, asigna lista de precio y vendedor por zona, y
 * ALERTA AL VENDEDOR por WhatsApp (mejora sobre v1, que solo registraba en el
 * dashboard). NO lanza: ante error devuelve un mensaje de derivacion.
 */
export async function qualifyLead(
  input: QualifyLeadInput,
): Promise<QualifyLeadResult> {
  try {
    const supabase = svc();
    const { workspaceId } = input;

    const { data: existing } = await supabase
      .from("leads_mayorista")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("contacto_phone", input.contactoPhone)
      .maybeSingle();

    const merged = mergeNonDestructive(
      existing as Partial<LeadRow> | null,
      inputToRow(input),
    );
    const fields = rowToFields(merged);

    const tieneRazonSocial =
      !!merged.razon_social && merged.razon_social.trim() !== "";
    const cuitValido = !!merged.cuit && isValidCuit(merged.cuit);
    const missing = computeMissing(fields);
    const listaPrecio = resolveListaPrecio(merged.formato_venta);

    let estado: LeadEstado;
    if (input.rechazaRazonSocial && (!tieneRazonSocial || !cuitValido)) {
      estado = "rechazado_sin_razon_social";
    } else if (missing.length > 0) {
      estado = "incompleto";
    } else {
      estado = "calificado";
    }

    merged.lista_precio = listaPrecio;
    merged.estado = estado;
    merged.incompleto = missing.length > 0;

    const { error: upsertError } = await supabase
      .from("leads_mayorista")
      .upsert(
        {
          ...merged,
          workspace_id: workspaceId,
          contacto_phone: input.contactoPhone,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,contacto_phone" },
      );
    // Si el guardado falla, NO seguir: la próxima llamada arrancaría con
    // existing=null y perdería lo ya cargado. Cae al catch (mensaje de derivación).
    if (upsertError) {
      throw new Error(`upsert leads_mayorista: ${upsertError.message}`);
    }

    if (estado === "rechazado_sin_razon_social") {
      return {
        ok: true,
        estado,
        camposFaltantes: [],
        message:
          "Para la venta mayorista necesitamos que el comercio esté registrado con razón social y CUIT válido. Si querés comprar para uso particular, te paso el link de la tienda.",
      };
    }

    if (estado === "incompleto") {
      // Pedir SOLO el bloque incompleto (identificación primero, negocio
      // después): máximo dos mensajes de repregunta, agrupados. Si el cliente
      // abandona a medias, igual quedó persistido arriba como lead incompleto.
      const blockMissing = nextBlockMissing(fields);
      const labels = missingLabels(blockMissing);

      // CUIT presente pero inválido: mensaje específico, no "necesito CUIT".
      const cuitInvalidoPresente =
        !!merged.cuit && merged.cuit.trim() !== "" && !cuitValido;
      let message: string;
      if (cuitInvalidoPresente && blockMissing.includes("cuit")) {
        const otros = labels.filter((l) => l !== "CUIT");
        message = otros.length
          ? `El CUIT no me figura como válido, ¿me lo revisás? También me falta: ${otros.join(", ")}.`
          : "El CUIT no me figura como válido, ¿me lo revisás? Fijate que sea el de la constancia de AFIP.";
      } else {
        message = `Para avanzar con la cuenta mayorista necesito: ${labels.join(", ")}. Me los pasás?`;
      }
      return { ok: true, estado, camposFaltantes: labels, message };
    }

    // Calificado: asignar vendedor por zona (localidad -> provincia).
    const vendedor = await resolveVendedor(workspaceId, {
      zonaText: merged.localidad ?? null,
      provincia: merged.provincia ?? null,
    });

    if (!vendedor) {
      await recordAlert(workspaceId, "lead_sin_vendedor", {
        contacto_phone: input.contactoPhone,
        razon_social: merged.razon_social,
        localidad: merged.localidad,
        provincia: merged.provincia,
        detalle: "Lead mayorista calificado sin vendedor de zona. Asignar manualmente.",
      });
      return {
        ok: true,
        estado: "calificado",
        camposFaltantes: [],
        vendedor: null,
        message:
          "Listo, quedó registrado todo. Un representante de la empresa te va a estar contactando a la brevedad para avanzar.",
      };
    }

    // Alerta por WhatsApp al vendedor (best-effort) + registro del resultado.
    const notified = await notifyVendedorLead(workspaceId, vendedor, {
      razonSocial: merged.razon_social ?? null,
      nombreContacto: merged.nombre_contacto ?? null,
      cuit: merged.cuit ?? null,
      provincia: merged.provincia ?? null,
      localidad: merged.localidad ?? null,
      rubro: merged.rubro ?? null,
      formatoVenta: merged.formato_venta ?? null,
      contactoPhone: input.contactoPhone,
      email: merged.email ?? null,
      comentarios: merged.comentarios ?? null,
    });

    await supabase
      .from("leads_mayorista")
      .update({
        estado: "asignado",
        vendedor_id: vendedor.id,
        vendedor_notificado_at: notified ? new Date().toISOString() : null,
      })
      .eq("workspace_id", workspaceId)
      .eq("contacto_phone", input.contactoPhone);

    // Sin notificacion (alertas apagadas, vendedor sin telefono o canal caido):
    // el lead igual queda asignado, pero alguien tiene que avisarle a mano.
    if (!notified) {
      await recordAlert(workspaceId, "lead_vendedor_sin_notificar", {
        contacto_phone: input.contactoPhone,
        vendedor: vendedor.nombre,
        vendedor_id: vendedor.id,
        detalle:
          "Lead asignado pero el vendedor NO fue notificado por WhatsApp (alertas desactivadas o envío fallido). Avisarle manualmente.",
      });
    }

    // Si la zona tiene varios vendedores, el agente NO nombra a nadie.
    const message = vendedor.multiple
      ? "Listo, quedó todo registrado. Un vendedor de tu zona te va a contactar a la brevedad para avanzar."
      : `Listo, quedó todo registrado. Te va a contactar ${vendedor.nombre}, que es quien cubre tu zona.`;

    return {
      ok: true,
      estado: "asignado",
      camposFaltantes: [],
      vendedor: vendedor.multiple
        ? null
        : { nombre: vendedor.nombre, zona: vendedor.zona },
      message,
    };
  } catch (e) {
    console.error("[mayorista] qualifyLead error:", (e as Error).message);
    return {
      ok: false,
      estado: "incompleto",
      camposFaltantes: [],
      message: DERIVATION_MSG,
    };
  }
}
