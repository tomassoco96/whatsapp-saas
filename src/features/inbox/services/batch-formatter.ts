/**
 * batch-formatter.ts — pure formatting of inbound messages into the single
 * consolidated text the LLM receives. Extracted from buffer.ts so the
 * multimedia→text rules are unit-testable without a DB.
 */

export interface InboundBatchMessage {
  body: string | null;
  meta: Record<string, unknown> | null;
  type: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Converts one inbound message into the line the model sees.
 * Media is pre-processed to text by media-understanding (transcript for
 * voice notes, description for images) and stored in messages.meta.
 */
export function formatInboundLine(msg: InboundBatchMessage): string {
  const meta = msg.meta ?? {};
  const transcript = str(meta.transcript);
  const description = str(meta.description);
  const caption = str(meta.caption);
  const filename = str(meta.filename);

  switch (msg.type) {
    case "audio":
    case "voice":
      // The transcript IS the customer's message — pass it through as plain
      // text. The old "[Nota de voz del cliente]:" prefix cued the model to
      // disclaim that it "can't hear voice notes" even though the transcript
      // was present, so it answered with a useless placeholder.
      return transcript
        ? transcript
        : "[El cliente envió una nota de voz que no se pudo transcribir; pídele que escriba su mensaje]";
    case "image":
      if (description)
        return `[El cliente envió una imagen]: ${description}${caption ? ` (texto adjunto: "${caption}")` : ""}`;
      return caption
        ? `[El cliente envió una imagen con el texto]: "${caption}"`
        : "[El cliente envió una imagen; pídele que describa qué necesita]";
    case "video":
      return `[El cliente envió un video${caption ? ` con el texto: "${caption}"` : ""}; no puedo verlo, pídele que lo describa o deriva a una persona]`;
    case "document":
      return `[El cliente envió un documento${filename ? `: "${filename}"` : ""}${caption ? ` con el texto: "${caption}"` : ""}; no puedo leer su contenido, pídele los datos clave o deriva a una persona]`;
    case "sticker":
      return "[El cliente envió un sticker]";
    default:
      return msg.body ?? "[Multimedia]";
  }
}
