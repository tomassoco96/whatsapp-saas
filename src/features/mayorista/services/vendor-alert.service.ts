import { createClient as createSbClient } from "@supabase/supabase-js";
import { dispatchText } from "@/features/inbox/services/dispatch";
import { normalizePhone } from "@/features/inbox/services/normalizer";
import type { VendedorMatch } from "./resolve.service";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface LeadResumen {
  razonSocial: string | null;
  nombreContacto: string | null;
  cuit: string | null;
  provincia: string | null;
  localidad: string | null;
  rubro: string | null;
  formatoVenta: string | null;
  contactoPhone: string;
  email: string | null;
  comentarios: string | null;
}

function buildAlertBody(lead: LeadResumen): string {
  const lineas = [
    "Nuevo lead mayorista asignado a vos:",
    "",
    `*Razón social:* ${lead.razonSocial ?? "-"}`,
    `*Contacto:* ${lead.nombreContacto ?? "-"}`,
    `*CUIT:* ${lead.cuit ?? "-"}`,
    `*Zona:* ${lead.localidad ?? "-"}, ${lead.provincia ?? "-"}`,
    `*Rubro:* ${lead.rubro ?? "-"}`,
    `*Formato:* ${lead.formatoVenta ?? "-"}`,
    `*WhatsApp:* ${lead.contactoPhone}`,
    `*Email:* ${lead.email ?? "-"}`,
  ];
  if (lead.comentarios) lineas.push(`*Comentarios:* ${lead.comentarios}`);
  lineas.push("", "El cliente ya sabe que lo vas a contactar. Respondé dentro de las próximas 2 horas.");
  return lineas.join("\n");
}

/**
 * Las alertas salen a TELEFONOS REALES de vendedores. Arrancan APAGADAS: se
 * encienden con OK explicito del cliente, igual que la recuperacion de carritos.
 * Flag: business_info.structured.vendor_alerts_enabled === true.
 */
async function vendorAlertsEnabled(
  supabase: ReturnType<typeof svc>,
  workspaceId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const structured = (data?.structured ?? null) as {
    vendor_alerts_enabled?: boolean;
  } | null;
  return structured?.vendor_alerts_enabled === true;
}

/**
 * Alerta por WhatsApp al vendedor asignado (el hueco del v1: alli solo quedaba
 * una fila en el dashboard). Crea/reusa el contacto y la conversacion del
 * vendedor en el MISMO canal del workspace y envia via dispatchText (SEC-04).
 *
 * Best-effort: si falla (sin telefono, canal caido, alertas apagadas) devuelve
 * false y el caller registra el evento para seguimiento manual — nunca rompe la
 * calificacion del lead.
 */
export async function notifyVendedorLead(
  workspaceId: string,
  vendedor: VendedorMatch,
  lead: LeadResumen,
): Promise<boolean> {
  if (!vendedor.telefono) return false;

  try {
    const supabase = svc();

    // Guard: sin OK del cliente no se le escribe a ningun vendedor real.
    if (!(await vendorAlertsEnabled(supabase, workspaceId))) {
      console.info(
        "[mayorista] alertas a vendedores desactivadas — lead asignado sin notificar",
      );
      return false;
    }

    const phone = normalizePhone(vendedor.telefono, "54");

    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .upsert(
        {
          workspace_id: workspaceId,
          phone,
          name: vendedor.nombre,
          opt_in: true,
          opt_in_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,phone", ignoreDuplicates: false },
      )
      .select()
      .single();
    if (contactErr || !contact) return false;

    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .upsert(
        {
          workspace_id: workspaceId,
          contact_id: (contact as { id: string }).id,
          channel: "whatsapp",
          last_message_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,contact_id,channel", ignoreDuplicates: false },
      )
      .select()
      .single();
    if (convErr || !conv) return false;

    const result = await dispatchText({
      workspaceId,
      conversationId: (conv as { id: string }).id,
      body: buildAlertBody(lead),
    });
    return result.ok;
  } catch (e) {
    console.warn("[mayorista] notifyVendedorLead error:", (e as Error).message);
    return false;
  }
}
