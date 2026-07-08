import { createClient as createSbClient } from "@supabase/supabase-js";

// WH-02: actualización monotónica del status de un mensaje saliente.
// Compartido por los webhooks de canal (YCloud, Evolution): el status solo
// avanza (queued→sent→delivered→read); 'failed' es terminal y siempre aplica.

const STATUS_ORDER = ["queued", "sent", "delivered", "read"] as const;
type OrderedStatus = (typeof STATUS_ORDER)[number];
type MessageStatus = OrderedStatus | "failed";

// ReturnType sobre la función genérica resolvería los generics a never; se
// toma el tipo de una llamada concreta (igual que los svc() de las rutas).
function svcShape() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}
type SvcClient = ReturnType<typeof svcShape>;

export async function applyMessageStatusUpdate(
  supabase: SvcClient,
  providerMessageId: string,
  newStatus: string,
): Promise<void> {
  const { data: msg } = await supabase
    .from("messages")
    .select("id, status")
    .eq("wamid", providerMessageId)
    .single();

  // Mensaje no encontrado — puede ser un saliente que no trackeamos
  if (!msg) return;

  const current = msg.status as MessageStatus | null;

  // 'failed' es terminal — aplica siempre, sin importar el estado actual
  if (newStatus === "failed") {
    await supabase
      .from("messages")
      .update({ status: "failed" })
      .eq("id", msg.id);
    return;
  }

  // Para statuses ordenados: solo avanzar, nunca retroceder
  const currentIdx = current
    ? STATUS_ORDER.indexOf(current as OrderedStatus)
    : -1;
  const newIdx = STATUS_ORDER.indexOf(newStatus as OrderedStatus);

  if (newIdx > currentIdx) {
    await supabase
      .from("messages")
      .update({ status: newStatus })
      .eq("id", msg.id);
  }
  // else: mismo status o menor — se ignora (garantía monotónica)
}
