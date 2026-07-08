import { createHash, timingSafeEqual } from "node:crypto";
import type { NormalizedInbound } from "./ycloud-webhook-handler";

// ──────────────────────────────────────────────────────────────────────────────
// Evolution webhook handler — parsea eventos de Evolution API v2 (Baileys) al
// mismo NormalizedInbound que produce el handler de YCloud, así processInbound
// y todo el pipeline (buffer, media, agente) quedan intactos.
//
// Seguridad: Evolution no firma sus webhooks con HMAC. La autenticación es un
// token secreto por workspace que viaja en la URL (?token=) o en el header
// x-webhook-token, comparado en tiempo constante contra el guardado en
// integrations.credentials.webhook_token.
// ──────────────────────────────────────────────────────────────────────────────

/** Comparación en tiempo constante de tokens (via hash para igualar largos). */
export function verifyEvolutionToken(
  received: string | null,
  expected: string,
): boolean {
  if (!received || !expected) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Inbound de Evolution: NormalizedInbound + media en base64 si el server lo adjunta. */
export interface EvolutionInbound {
  normalized: NormalizedInbound;
  /** Base64 del media (webhookBase64: true en la config de la instancia) */
  mediaBase64: string | null;
}

/** messageType de Baileys → message_type del enum de la DB. */
const TYPE_MAP: Record<string, string> = {
  conversation: "text",
  extendedTextMessage: "text",
  audioMessage: "audio",
  imageMessage: "image",
  videoMessage: "video",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
  stickerMessage: "sticker",
  locationMessage: "location",
};

/** Extrae el número E.164 de un JID de WhatsApp ("549115555@s.whatsapp.net"). */
function phoneFromJid(jid: string): string | null {
  const m = jid.match(/^(\d{5,15})@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : null;
}

interface EvolutionMessageData {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string };
  pushName?: string;
  message?: Record<string, unknown> & { base64?: string };
  messageType?: string;
  messageTimestamp?: number;
}

/**
 * Parsea un evento messages.upsert de Evolution v2.
 * Devuelve null si no es un inbound procesable (fromMe, grupos, broadcast,
 * newsletters o payload malformado).
 */
export function parseEvolutionInbound(body: unknown): EvolutionInbound | null {
  try {
    if (typeof body !== "object" || body === null) return null;
    const event = body as Record<string, unknown>;

    if (event.event !== "messages.upsert") return null;

    const data = event.data as EvolutionMessageData | undefined;
    if (typeof data !== "object" || data === null) return null;

    const key = data.key;
    if (!key || typeof key.id !== "string" || !key.id) return null;

    // Solo inbound de chats 1:1 — nunca ecos propios, grupos ni broadcasts.
    if (key.fromMe === true) return null;
    const remoteJid = typeof key.remoteJid === "string" ? key.remoteJid : "";
    const from = phoneFromJid(remoteJid);
    if (!from) return null;

    const msg = data.message ?? {};
    const rawType =
      typeof data.messageType === "string" ? data.messageType : "conversation";
    const type = TYPE_MAP[rawType] ?? "text";

    // El número del workspace viene en `sender` (JID de la instancia).
    const senderJid = typeof event.sender === "string" ? event.sender : "";
    const workspacePhone = phoneFromJid(senderJid) ?? "";

    const timestamp =
      typeof data.messageTimestamp === "number"
        ? new Date(data.messageTimestamp * 1000).toISOString()
        : new Date().toISOString();

    let text: string | null = null;
    let mediaMime: string | null = null;
    let mediaFilename: string | null = null;
    let mediaBase64: string | null = null;

    if (rawType === "conversation") {
      text = typeof msg.conversation === "string" ? msg.conversation : null;
    } else if (rawType === "extendedTextMessage") {
      const ext = msg.extendedTextMessage as { text?: string } | undefined;
      text = typeof ext?.text === "string" ? ext.text : null;
    } else {
      // Media: el objeto viene bajo la clave del tipo (audioMessage, etc.)
      const mediaObj = msg[rawType] as
        | { caption?: string; mimetype?: string; fileName?: string }
        | undefined;
      if (mediaObj) {
        mediaMime =
          typeof mediaObj.mimetype === "string" ? mediaObj.mimetype : null;
        mediaFilename =
          typeof mediaObj.fileName === "string" ? mediaObj.fileName : null;
        if (typeof mediaObj.caption === "string" && mediaObj.caption.trim()) {
          text = mediaObj.caption;
        }
      }
      // Con webhookBase64 activo, Evolution adjunta el media decodificado acá.
      if (typeof msg.base64 === "string" && msg.base64.length > 0) {
        mediaBase64 = msg.base64;
      }
      if (text === null) text = "[Multimedia]";
    }

    if (type === "text" && (text === null || text === "")) return null;

    return {
      normalized: {
        workspacePhone,
        from,
        type,
        text,
        wamid: key.id,
        customerName:
          typeof data.pushName === "string" && data.pushName
            ? data.pushName
            : null,
        createTime: timestamp,
        // Evolution no da un link descargable directo (las URLs .enc de
        // WhatsApp vienen cifradas): el media viaja como base64 o no viaja.
        mediaLink: null,
        mediaId: null,
        mediaMime,
        mediaFilename,
      },
      mediaBase64,
    };
  } catch {
    return null;
  }
}

/** ACK de Baileys → status del enum de mensajes. */
const ACK_MAP: Record<string, string> = {
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
  ERROR: "failed",
};

/**
 * Parsea un evento messages.update (cambio de estado de un mensaje saliente).
 * Devuelve null si el evento no trae un id + status mapeable.
 */
export function parseEvolutionStatusUpdate(
  body: unknown,
): { providerMessageId: string; status: string } | null {
  try {
    if (typeof body !== "object" || body === null) return null;
    const event = body as Record<string, unknown>;
    if (event.event !== "messages.update") return null;

    const data = event.data as
      | { keyId?: string; key?: { id?: string }; status?: string }
      | undefined;
    if (typeof data !== "object" || data === null) return null;

    const id =
      typeof data.keyId === "string" && data.keyId
        ? data.keyId
        : typeof data.key?.id === "string"
          ? data.key.id
          : null;
    const status = typeof data.status === "string" ? ACK_MAP[data.status] : null;

    if (!id || !status) return null;
    return { providerMessageId: id, status };
  } catch {
    return null;
  }
}
