import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyYCloudSignature, parseInbound } from "./ycloud-webhook-handler";

const SECRET = "test-secret";

function sign(rawBody: string, secret = SECRET, tsOffsetSec = 0): string {
  const ts = Math.floor(Date.now() / 1000) + tsOffsetSec;
  const sig = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  return `t=${ts},s=${sig}`;
}

describe("verifyYCloudSignature", () => {
  const body = JSON.stringify({ hello: "world" });

  it("acepta una firma válida y fresca", () => {
    expect(verifyYCloudSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rechaza header null o malformado", () => {
    expect(verifyYCloudSignature(body, null, SECRET)).toBe(false);
    expect(verifyYCloudSignature(body, "garbage", SECRET)).toBe(false);
    expect(verifyYCloudSignature(body, "t=123", SECRET)).toBe(false);
    expect(verifyYCloudSignature(body, "s=abcdef", SECRET)).toBe(false);
  });

  it("rechaza firma calculada con otro secret", () => {
    expect(verifyYCloudSignature(body, sign(body, "otro-secret"), SECRET)).toBe(
      false,
    );
  });

  it("rechaza si el body fue alterado después de firmar", () => {
    const header = sign(body);
    expect(verifyYCloudSignature(body + "x", header, SECRET)).toBe(false);
  });

  it("anti-replay: rechaza timestamps a más de 300s (pasado y futuro)", () => {
    expect(verifyYCloudSignature(body, sign(body, SECRET, -301), SECRET)).toBe(
      false,
    );
    expect(verifyYCloudSignature(body, sign(body, SECRET, 301), SECRET)).toBe(
      false,
    );
    // dentro de la ventana sigue siendo válida
    expect(verifyYCloudSignature(body, sign(body, SECRET, -290), SECRET)).toBe(
      true,
    );
  });

  it("rechaza firma truncada (longitud distinta)", () => {
    const header = sign(body);
    const truncated = header.slice(0, header.length - 4);
    expect(verifyYCloudSignature(body, truncated, SECRET)).toBe(false);
  });
});

function inboundEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "whatsapp.inbound_message.received",
    createTime: "2026-07-03T12:00:00Z",
    whatsappInboundMessage: {
      wamid: "wamid.test123",
      from: "+5215512345678",
      to: "+5215587654321",
      type: "text",
      text: { body: "hola" },
      customerProfile: { name: "Cliente Prueba" },
      ...overrides,
    },
  };
}

describe("parseInbound", () => {
  it("parsea un mensaje de texto completo", () => {
    const result = parseInbound(inboundEvent());
    expect(result).not.toBeNull();
    expect(result!.wamid).toBe("wamid.test123");
    expect(result!.from).toBe("+5215512345678");
    expect(result!.workspacePhone).toBe("+5215587654321");
    expect(result!.type).toBe("text");
    expect(result!.text).toBe("hola");
    expect(result!.customerName).toBe("Cliente Prueba");
    expect(result!.mediaLink).toBeNull();
  });

  it("ignora eventos que no son inbound_message", () => {
    expect(
      parseInbound({ type: "whatsapp.message.updated", data: {} }),
    ).toBeNull();
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound("string")).toBeNull();
  });

  it("rechaza mensajes sin wamid o sin from/to", () => {
    expect(parseInbound(inboundEvent({ wamid: undefined }))).toBeNull();
    expect(parseInbound(inboundEvent({ from: undefined }))).toBeNull();
    expect(parseInbound(inboundEvent({ to: undefined }))).toBeNull();
  });

  it("clampa 'voice' a 'audio' (enum de la DB) conservando el media link", () => {
    const result = parseInbound(
      inboundEvent({
        type: "voice",
        text: undefined,
        voice: {
          id: "media-1",
          link: "https://api.ycloud.com/media/1",
          mimeType: "audio/ogg",
        },
      }),
    );
    expect(result!.type).toBe("audio");
    expect(result!.mediaLink).toBe("https://api.ycloud.com/media/1");
    expect(result!.mediaMime).toBe("audio/ogg");
    expect(result!.text).toBe("[Multimedia]");
  });

  it("clampa tipos desconocidos a 'text' con placeholder", () => {
    const result = parseInbound(
      inboundEvent({ type: "reaction", text: undefined }),
    );
    expect(result!.type).toBe("text");
    expect(result!.text).toBe("[Multimedia]");
  });

  it("usa el caption de una imagen como texto del mensaje", () => {
    const result = parseInbound(
      inboundEvent({
        type: "image",
        text: undefined,
        image: {
          id: "media-2",
          link: "https://api.ycloud.com/media/2",
          mime_type: "image/jpeg",
          caption: "este es mi comprobante",
        },
      }),
    );
    expect(result!.type).toBe("image");
    expect(result!.text).toBe("este es mi comprobante");
    // lee mime_type (snake_case) además de mimeType
    expect(result!.mediaMime).toBe("image/jpeg");
  });
});
