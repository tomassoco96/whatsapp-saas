import { describe, it, expect } from "vitest";
import { formatInboundLine } from "./batch-formatter";

describe("formatInboundLine", () => {
  it("texto plano pasa el body tal cual", () => {
    expect(
      formatInboundLine({ type: "text", body: "hola, tienen stock?", meta: null }),
    ).toBe("hola, tienen stock?");
  });

  it("texto sin body cae al placeholder", () => {
    expect(formatInboundLine({ type: "text", body: null, meta: null })).toBe(
      "[Multimedia]",
    );
  });

  it("nota de voz con transcript: el transcript ES el mensaje, sin prefijo", () => {
    const line = formatInboundLine({
      type: "audio",
      body: null,
      meta: { transcript: "quiero dos remeras talle M" },
    });
    // Sin prefijo "[Nota de voz...]": el prefijo hacía que el modelo respondiera
    // "no puedo escuchar audios" aunque tenía el transcript (fix de junio 2026)
    expect(line).toBe("quiero dos remeras talle M");
  });

  it("'voice' se trata igual que 'audio'", () => {
    expect(
      formatInboundLine({ type: "voice", body: null, meta: { transcript: "hola" } }),
    ).toBe("hola");
  });

  it("audio sin transcript pide que escriba", () => {
    const line = formatInboundLine({ type: "audio", body: null, meta: {} });
    expect(line).toContain("no se pudo transcribir");
    expect(line).toContain("pídele que escriba");
  });

  it("transcript vacío o con solo espacios cuenta como sin transcript", () => {
    const line = formatInboundLine({
      type: "audio",
      body: null,
      meta: { transcript: "   " },
    });
    expect(line).toContain("no se pudo transcribir");
  });

  it("imagen con descripción y caption combina ambos", () => {
    const line = formatInboundLine({
      type: "image",
      body: null,
      meta: { description: "comprobante de transferencia", caption: "pagué" },
    });
    expect(line).toBe(
      '[El cliente envió una imagen]: comprobante de transferencia (texto adjunto: "pagué")',
    );
  });

  it("imagen solo con caption", () => {
    const line = formatInboundLine({
      type: "image",
      body: null,
      meta: { caption: "esto llegó roto" },
    });
    expect(line).toBe('[El cliente envió una imagen con el texto]: "esto llegó roto"');
  });

  it("imagen sin nada pide descripción", () => {
    expect(formatInboundLine({ type: "image", body: null, meta: null })).toBe(
      "[El cliente envió una imagen; pídele que describa qué necesita]",
    );
  });

  it("video avisa que no puede verlo", () => {
    const line = formatInboundLine({
      type: "video",
      body: null,
      meta: { caption: "mirá esto" },
    });
    expect(line).toContain('con el texto: "mirá esto"');
    expect(line).toContain("no puedo verlo");
  });

  it("documento incluye filename y aviso de no-lectura", () => {
    const line = formatInboundLine({
      type: "document",
      body: null,
      meta: { filename: "factura.pdf" },
    });
    expect(line).toContain('"factura.pdf"');
    expect(line).toContain("no puedo leer su contenido");
  });

  it("sticker tiene su placeholder", () => {
    expect(formatInboundLine({ type: "sticker", body: null, meta: null })).toBe(
      "[El cliente envió un sticker]",
    );
  });
});
