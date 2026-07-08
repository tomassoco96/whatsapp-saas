import { describe, it, expect } from "vitest";
import {
  parseEvolutionInbound,
  parseEvolutionStatusUpdate,
  verifyEvolutionToken,
} from "./evolution-webhook-handler";

function upsertEvent(overrides: {
  key?: Record<string, unknown>;
  message?: Record<string, unknown>;
  messageType?: string;
  pushName?: string;
  sender?: string;
}) {
  return {
    event: "messages.upsert",
    instance: "brogas",
    sender: overrides.sender ?? "5491130715056@s.whatsapp.net",
    data: {
      key: {
        remoteJid: "5493764111222@s.whatsapp.net",
        fromMe: false,
        id: "3EB0C431C26A1916E07E",
        ...(overrides.key ?? {}),
      },
      pushName: overrides.pushName ?? "Juan",
      message: overrides.message ?? { conversation: "hola" },
      messageType: overrides.messageType ?? "conversation",
      messageTimestamp: 1751980000,
    },
  };
}

describe("parseEvolutionInbound", () => {
  it("parsea un texto simple (conversation)", () => {
    const parsed = parseEvolutionInbound(upsertEvent({}));
    expect(parsed).not.toBeNull();
    expect(parsed!.normalized).toMatchObject({
      from: "+5493764111222",
      workspacePhone: "+5491130715056",
      type: "text",
      text: "hola",
      wamid: "3EB0C431C26A1916E07E",
      customerName: "Juan",
    });
    expect(parsed!.mediaBase64).toBeNull();
  });

  it("parsea extendedTextMessage", () => {
    const parsed = parseEvolutionInbound(
      upsertEvent({
        message: { extendedTextMessage: { text: "hola con link" } },
        messageType: "extendedTextMessage",
      }),
    );
    expect(parsed!.normalized.text).toBe("hola con link");
    expect(parsed!.normalized.type).toBe("text");
  });

  it("parsea audio con base64 y mimetype", () => {
    const parsed = parseEvolutionInbound(
      upsertEvent({
        message: {
          audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 4 },
          base64: "T2dnUw==",
        },
        messageType: "audioMessage",
      }),
    );
    expect(parsed!.normalized.type).toBe("audio");
    expect(parsed!.normalized.text).toBe("[Multimedia]");
    expect(parsed!.normalized.mediaMime).toBe("audio/ogg; codecs=opus");
    expect(parsed!.mediaBase64).toBe("T2dnUw==");
  });

  it("usa el caption de la imagen como texto", () => {
    const parsed = parseEvolutionInbound(
      upsertEvent({
        message: {
          imageMessage: { caption: "mi constancia de CUIT", mimetype: "image/jpeg" },
          base64: "AAAA",
        },
        messageType: "imageMessage",
      }),
    );
    expect(parsed!.normalized.type).toBe("image");
    expect(parsed!.normalized.text).toBe("mi constancia de CUIT");
  });

  it("descarta ecos propios (fromMe)", () => {
    expect(
      parseEvolutionInbound(upsertEvent({ key: { fromMe: true } })),
    ).toBeNull();
  });

  it("descarta grupos y broadcasts (remoteJid no 1:1)", () => {
    expect(
      parseEvolutionInbound(
        upsertEvent({ key: { remoteJid: "1203630vabcd@g.us" } }),
      ),
    ).toBeNull();
    expect(
      parseEvolutionInbound(
        upsertEvent({ key: { remoteJid: "status@broadcast" } }),
      ),
    ).toBeNull();
  });

  it("descarta eventos que no son messages.upsert", () => {
    expect(
      parseEvolutionInbound({ event: "connection.update", data: {} }),
    ).toBeNull();
  });
});

describe("parseEvolutionStatusUpdate", () => {
  it("mapea los ACK de Baileys al enum de status", () => {
    const parsed = parseEvolutionStatusUpdate({
      event: "messages.update",
      data: { keyId: "3EB0OUT", status: "DELIVERY_ACK" },
    });
    expect(parsed).toEqual({
      providerMessageId: "3EB0OUT",
      status: "delivered",
    });
  });

  it("devuelve null para status desconocidos o sin id", () => {
    expect(
      parseEvolutionStatusUpdate({
        event: "messages.update",
        data: { keyId: "x", status: "WHATEVER" },
      }),
    ).toBeNull();
    expect(
      parseEvolutionStatusUpdate({
        event: "messages.update",
        data: { status: "READ" },
      }),
    ).toBeNull();
  });
});

describe("verifyEvolutionToken", () => {
  it("acepta el token correcto y rechaza los demás", () => {
    expect(verifyEvolutionToken("secreto123", "secreto123")).toBe(true);
    expect(verifyEvolutionToken("otro", "secreto123")).toBe(false);
    expect(verifyEvolutionToken(null, "secreto123")).toBe(false);
    expect(verifyEvolutionToken("secreto123", "")).toBe(false);
  });
});
