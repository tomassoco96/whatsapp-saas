import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

vi.mock("./ycloud-client", () => ({
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
}));

vi.mock("./evolution-client", () => ({
  sendEvolutionText: vi.fn(),
}));

import { dispatchText } from "./dispatch";
import { sendText } from "./ycloud-client";
import { sendEvolutionText } from "./evolution-client";

const mockSendText = vi.mocked(sendText);
const mockSendEvolutionText = vi.mocked(sendEvolutionText);

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

/**
 * Encola las respuestas en el orden en que dispatchText consulta la DB:
 * 1. conversations (window + contact_id) → 2. contacts (phone) →
 * 3. conversations (contact_id, SEC-10) → 4. contacts (opt_in) →
 * 5. integrations → 6. messages insert → 7. conversations update
 */
function queueHappyPath(opts: {
  windowExpiresAt?: string | null;
  optIn?: boolean;
  apiKey?: string;
  provider?: "ycloud" | "evolution";
}) {
  const {
    windowExpiresAt = FUTURE,
    optIn = true,
    apiKey = "real-key",
    provider = "ycloud",
  } = opts;
  // La integración de canal viene como lista (multi-provider): dispatch
  // prioriza ycloud y cae a evolution.
  const integrationRow =
    provider === "evolution"
      ? {
          provider: "evolution",
          credentials: { evolution_api_key: apiKey },
          config: { server_url: "https://evo.test", instance_name: "inst1" },
        }
      : {
          provider: "ycloud",
          credentials: { ycloud_api_key: apiKey },
          config: { phone_number: "+5215587654321" },
        };
  h.mock.queue.push(
    { data: { window_expires_at: windowExpiresAt, contact_id: "c1" } },
    { data: { phone: "+5215512345678" } },
    { data: { contact_id: "c1" } },
    { data: { opt_in: optIn } },
    { data: [integrationRow] },
    { error: null }, // messages insert
    { data: null }, // conversations update
  );
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  mockSendText.mockReset();
  mockSendEvolutionText.mockReset();
});

describe("dispatchText", () => {
  it("envía, persiste como 'sent' y devuelve el wamid", async () => {
    queueHappyPath({});
    mockSendText.mockResolvedValue({
      wamid: "wamid.out1",
      id: "yc1",
      status: "accepted",
    });

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
    });

    expect(result).toEqual({ ok: true, wamid: "wamid.out1" });
    expect(mockSendText).toHaveBeenCalledOnce();
    const insert = h.mock.calls.find(
      (c) => c.table === "messages" && c.method === "insert",
    );
    expect((insert!.args[0] as { status: string }).status).toBe("sent");
  });

  it("normaliza Markdown a formato WhatsApp antes de enviar y persistir", async () => {
    queueHappyPath({});
    mockSendText.mockResolvedValue({ wamid: "w", id: "y", status: "accepted" });

    await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "**Horarios**: [web](https://tienda.com)",
    });

    const sentBody = mockSendText.mock.calls[0][0].body;
    expect(sentBody).toBe("*Horarios*: web (https://tienda.com)");
    const insert = h.mock.calls.find(
      (c) => c.table === "messages" && c.method === "insert",
    );
    expect((insert!.args[0] as { body: string }).body).toBe(sentBody);
  });

  it("SEC-10: bloquea el envío a contactos con opt-out y no llama a YCloud", async () => {
    queueHappyPath({ optIn: false });

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("OPT_OUT");
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("bloquea con WINDOW_EXPIRED cuando la ventana de 24h venció", async () => {
    queueHappyPath({ windowExpiresAt: PAST });

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
    });

    expect(result).toEqual({ ok: false, error: "WINDOW_EXPIRED" });
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("overrideAdmin permite enviar con la ventana vencida", async () => {
    queueHappyPath({ windowExpiresAt: PAST });
    mockSendText.mockResolvedValue({
      wamid: "wamid.ovr",
      id: "yc",
      status: "accepted",
    });

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
      overrideAdmin: true,
    });

    expect(result.ok).toBe(true);
    expect(mockSendText).toHaveBeenCalledOnce();
  });

  it("dev mode: con api key 'placeholder' no envía y persiste como 'queued'", async () => {
    queueHappyPath({ apiKey: "placeholder" });

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
    });

    expect(result.ok).toBe(true);
    expect(mockSendText).not.toHaveBeenCalled();
    const insert = h.mock.calls.find(
      (c) => c.table === "messages" && c.method === "insert",
    );
    const row = insert!.args[0] as {
      status: string;
      meta: { dev_mode?: boolean };
    };
    expect(row.status).toBe("queued");
    expect(row.meta.dev_mode).toBe(true);
  });

  it("si YCloud falla, persiste el mensaje como 'failed' y devuelve el error", async () => {
    queueHappyPath({});
    mockSendText.mockRejectedValue(new Error("ycloud 500"));

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ycloud 500");
    const insert = h.mock.calls.find(
      (c) => c.table === "messages" && c.method === "insert",
    );
    expect((insert!.args[0] as { status: string }).status).toBe("failed");
  });

  it("con provider evolution envía por Evolution y persiste el key.id como wamid", async () => {
    queueHappyPath({ provider: "evolution" });
    mockSendEvolutionText.mockResolvedValue({
      id: "3EB0EVOID",
      status: "PENDING",
    });

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
    });

    expect(result).toEqual({ ok: true, wamid: "3EB0EVOID" });
    expect(mockSendEvolutionText).toHaveBeenCalledOnce();
    expect(mockSendText).not.toHaveBeenCalled();
    const call = mockSendEvolutionText.mock.calls[0][0];
    expect(call.serverUrl).toBe("https://evo.test");
    expect(call.instance).toBe("inst1");
    const insert = h.mock.calls.find(
      (c) => c.table === "messages" && c.method === "insert",
    );
    const row = insert!.args[0] as { meta: { provider?: string } };
    expect(row.meta.provider).toBe("evolution");
  });

  it("si YCloud y Evolution están habilitados a la vez, gana YCloud", async () => {
    queueHappyPath({});
    // Segunda integración en la misma respuesta: evolution también habilitada
    const queued = h.mock.queue[4] as { data: unknown[] };
    queued.data.push({
      provider: "evolution",
      credentials: { evolution_api_key: "evo-key" },
      config: { server_url: "https://evo.test", instance_name: "inst1" },
    });
    mockSendText.mockResolvedValue({
      wamid: "wamid.oficial",
      id: "yc1",
      status: "accepted",
    });

    const result = await dispatchText({
      workspaceId: "ws1",
      conversationId: "conv1",
      body: "hola",
    });

    expect(result).toEqual({ ok: true, wamid: "wamid.oficial" });
    expect(mockSendText).toHaveBeenCalledOnce();
    expect(mockSendEvolutionText).not.toHaveBeenCalled();
  });
});
