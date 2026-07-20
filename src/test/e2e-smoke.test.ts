/**
 * e2e-smoke.test.ts — smoke test E2E del camino crítico, sin red ni DB real:
 *
 *   POST /api/webhooks/ycloud (firma HMAC) → normalizer → buffer (ráfaga)
 *   → claim del batch → decision engine → LLM (fetch stub de OpenRouter,
 *   con tool-calling) → dispatch → YCloud (fetch stub) → batch processed.
 *
 * Usa los route handlers y servicios REALES importados directamente; solo se
 * fakean los bordes: @supabase/supabase-js (supabase-fake-db), fetch global
 * (OpenRouter + YCloud) y after() de next/server (se captura, no se ejecuta,
 * para no dormir la ventana de silencio en el test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createFakeDb, type FakeDb } from "@/test/supabase-fake-db";

// ──────────────────────────────────────────────────────────────────────────────
// Estado compartido con los mocks (vi.hoisted corre antes que los vi.mock)
// ──────────────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  afterCallbacks: [] as Array<() => unknown>,
  llmResponses: [] as unknown[],
  llmCalls: [] as Array<Record<string, unknown>>,
  ycloudCalls: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.db.client,
}));

// after() real requiere el request scope de Next — acá se captura y listo.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      h.afterCallbacks.push(fn);
    },
  };
});

// imports del código real DESPUÉS de los vi.mock
import { NextRequest } from "next/server";
import { POST as ycloudWebhookPost } from "@/app/api/webhooks/ycloud/route";
import { processNextBatch } from "@/features/inbox/services/buffer";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────
const WS = "ws-e2e-1";
const SECRET = "test-signing-secret";
const CUSTOMER_PHONE = "+5215587654321";
const BUSINESS_PHONE = "+5215550000000";

function signHeader(rawBody: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  return `t=${ts},s=${sig}`;
}

function inboundPayload(opts: { wamid: string; text: string }) {
  return {
    type: "whatsapp.inbound_message.received",
    createTime: new Date().toISOString(),
    whatsappInboundMessage: {
      wamid: opts.wamid,
      from: CUSTOMER_PHONE,
      to: BUSINESS_PHONE,
      type: "text",
      text: { body: opts.text },
      customerProfile: { name: "Cliente Test" },
    },
  };
}

async function postWebhook(
  payload: unknown,
  opts: { secret?: string; omitSignature?: boolean } = {},
) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!opts.omitSignature) {
    headers["YCloud-Signature"] = signHeader(raw, opts.secret ?? SECRET);
  }
  const req = new NextRequest(
    `https://app.test/api/webhooks/ycloud?wsid=${WS}`,
    { method: "POST", body: raw, headers },
  );
  return ycloudWebhookPost(req);
}

// Respuestas del stub de OpenRouter (formato OpenAI chat completions)
function llmText(text: string) {
  return {
    id: "gen-test",
    object: "chat.completion",
    created: 1720000000,
    model: "openai/gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function llmToolCall(toolName: string, args: Record<string, unknown>) {
  return {
    id: "gen-test-tool",
    object: "chat.completion",
    created: 1720000000,
    model: "openai/gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
  };
}

async function fetchStub(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};

  if (url.includes("openrouter.ai")) {
    h.llmCalls.push(body);
    const next = h.llmResponses.shift();
    if (!next) {
      throw new Error(`fetch stub: sin respuestas LLM encoladas para ${url}`);
    }
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.includes("api.ycloud.com")) {
    h.ycloudCalls.push({ url, body });
    return new Response(
      JSON.stringify({ id: "yc-msg-1", wamid: "wamid.out.1", status: "accepted" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  throw new Error(`fetch stub: URL inesperada ${url}`);
}

/** Deja el único batch listo para el claim del cron. */
function makeBatchClaimable() {
  const batch = h.db.tables.message_batches?.[0];
  expect(batch).toBeDefined();
  batch.flush_at = new Date(Date.now() - 1_000).toISOString();
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

function outboundMessages() {
  return (h.db.tables.messages ?? []).filter((m) => m.direction === "out");
}

function writesTo(table: string) {
  return h.db.calls.filter(
    (c) =>
      c.table === table && ["insert", "upsert", "update"].includes(c.method),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  h.db = createFakeDb();
  h.afterCallbacks = [];
  h.llmResponses = [];
  h.llmCalls = [];
  h.ycloudCalls = [];

  // OpenRouter "placeholder" desactiva embeddings de KB (searchKb → []);
  // la generación igual pasa por el fetch stub.
  vi.stubEnv("OPENROUTER_API_KEY", "placeholder");
  vi.stubGlobal("fetch", fetchStub);

  h.db.tables.integrations = [
    {
      id: "int-ycloud",
      workspace_id: WS,
      provider: "ycloud",
      enabled: true,
      credentials: {
        ycloud_api_key: "test-api-key",
        webhook_signing_secret: SECRET,
      },
      config: { phone_number: BUSINESS_PHONE },
    },
  ];

  // RPC de encolado atómico (equivalente in-memory de upsert_batch):
  // extiende el batch buffering de la conversación o crea uno.
  h.db.rpcHandlers.upsert_batch = (args) => {
    const a = (args ?? {}) as {
      p_workspace_id?: string;
      p_conversation_id?: string;
      p_silence_ms?: number;
    };
    const now = Date.now();
    const flushAt = new Date(now + (a.p_silence_ms ?? 30_000)).toISOString();
    const batches = (h.db.tables.message_batches ??= []);
    const existing = batches.find(
      (b) =>
        b.conversation_id === a.p_conversation_id && b.status === "buffering",
    );
    if (existing) {
      existing.flush_at = flushAt;
      existing.message_count = (Number(existing.message_count) || 0) + 1;
      existing.updated_at = new Date(now).toISOString();
      return { data: existing.id };
    }
    const id = `message_batches-${batches.length + 1}`;
    batches.push({
      id,
      workspace_id: a.p_workspace_id,
      conversation_id: a.p_conversation_id,
      status: "buffering",
      silence_ms: a.p_silence_ms ?? 30_000,
      flush_at: flushAt,
      message_count: 1,
      merged_text: null,
      dispatched_at: null,
      retry_after: null,
      meta: {},
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    return { data: id };
  };

  // RPC del claim atómico (equivalente in-memory de claim_next_batch)
  h.db.rpcHandlers.claim_next_batch = () => {
    const now = new Date().toISOString();
    const batch = (h.db.tables.message_batches ?? []).find(
      (b) => b.status === "buffering" && String(b.flush_at) <= now,
    );
    if (!batch) return { data: [] };
    batch.status = "processing";
    batch.updated_at = now;
    return { data: [{ ...batch }] };
  };
  h.db.rpcHandlers.cancel_batch = (args) => {
    const id = (args as { p_batch_id?: string } | null)?.p_batch_id;
    const batch = (h.db.tables.message_batches ?? []).find((b) => b.id === id);
    if (batch) batch.status = "cancelled";
    return { data: null };
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ──────────────────────────────────────────────────────────────────────────────
// Smoke E2E
// ──────────────────────────────────────────────────────────────────────────────
describe("smoke E2E: webhook → buffer → agente → respuesta", () => {
  it("a. inbound con firma HMAC válida entra al buffer", async () => {
    const res = await postWebhook(
      inboundPayload({ wamid: "wamid.in.1", text: "hola" }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ received: true, buffered: true });

    // Contacto + conversación + mensaje persistidos
    expect(h.db.tables.contacts).toHaveLength(1);
    expect(h.db.tables.contacts[0]).toMatchObject({
      workspace_id: WS,
      phone: CUSTOMER_PHONE,
      opt_in: true,
    });
    expect(h.db.tables.conversations).toHaveLength(1);
    expect(h.db.tables.conversations[0]).toMatchObject({
      workspace_id: WS,
      state: "ai_active",
      ai_enabled: true,
    });
    expect(h.db.tables.messages).toHaveLength(1);
    expect(h.db.tables.messages[0]).toMatchObject({
      direction: "in",
      body: "hola",
      wamid: "wamid.in.1",
    });

    // Batch en buffering, con el mensaje linkeado
    expect(h.db.tables.message_batches).toHaveLength(1);
    const batch = h.db.tables.message_batches[0];
    expect(batch).toMatchObject({ status: "buffering", message_count: 1 });
    expect(h.db.tables.messages[0].batch_id).toBe(batch.id);

    // El fast-path quedó agendado vía after() (capturado, no ejecutado)
    expect(h.afterCallbacks.length).toBeGreaterThan(0);
  });

  it("b. firma HMAC inválida → 401 y cero escrituras", async () => {
    const res = await postWebhook(
      inboundPayload({ wamid: "wamid.in.1", text: "hola" }),
      { secret: "otro-secreto-incorrecto" },
    );
    expect(res.status).toBe(401);

    const res2 = await postWebhook(
      inboundPayload({ wamid: "wamid.in.2", text: "hola" }),
      { omitSignature: true },
    );
    expect(res2.status).toBe(401);

    expect(h.db.tables.contacts ?? []).toHaveLength(0);
    expect(h.db.tables.messages ?? []).toHaveLength(0);
    expect(h.db.tables.message_batches ?? []).toHaveLength(0);
    // Ninguna escritura en ninguna tabla — solo lecturas de integrations
    expect(
      h.db.calls.filter((c) =>
        ["insert", "upsert", "update", "delete"].includes(c.method),
      ),
    ).toHaveLength(0);
  });

  it("c. ráfaga de 3 mensajes del mismo contacto → UNA respuesta consolidada", async () => {
    for (const [i, text] of ["hola", "quiero info", "del producto X"].entries()) {
      const res = await postWebhook(
        inboundPayload({ wamid: `wamid.in.${i + 1}`, text }),
      );
      expect(res.status).toBe(200);
    }

    // La ráfaga se acumuló en UN solo batch (criterio: mismo contacto +
    // conversación con batch en buffering → se extiende, no se crea otro)
    expect(h.db.tables.message_batches).toHaveLength(1);
    expect(h.db.tables.message_batches[0].message_count).toBe(3);
    expect(h.db.tables.messages).toHaveLength(3);

    // Cierre de la ventana de silencio + tick del cron
    makeBatchClaimable();
    h.llmResponses = [llmText("¡Hola! Te cuento sobre el producto X.")];

    const result = await processNextBatch();
    expect(result.processed).toBe(true);

    // UNA sola llamada al LLM, con los 3 mensajes consolidados en un turno
    expect(h.llmCalls).toHaveLength(1);
    const messages = h.llmCalls[0].messages as Array<{
      role: string;
      content: string;
    }>;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toBe("hola\nquiero info\ndel producto X");

    // UNA sola respuesta saliente por YCloud, al teléfono del contacto
    expect(h.ycloudCalls).toHaveLength(1);
    expect(h.ycloudCalls[0].body).toMatchObject({
      type: "text",
      to: CUSTOMER_PHONE,
      from: BUSINESS_PHONE,
      text: { body: "¡Hola! Te cuento sobre el producto X." },
    });
    expect(outboundMessages()).toHaveLength(1);
    expect(outboundMessages()[0]).toMatchObject({
      status: "sent",
      wamid: "wamid.out.1",
    });

    // Batch cerrado con merged_text de auditoría
    const batch = h.db.tables.message_batches[0];
    expect(batch.status).toBe("processed");
    expect(batch.merged_text).toBe("hola\nquiero info\ndel producto X");

    // Cost tracking del turno
    const llmUsage = (h.db.tables.events ?? []).filter(
      (e) => e.type === "llm_usage",
    );
    expect(llmUsage).toHaveLength(1);
  });

  it("d. la IA llama una tool (tool_call) y la respuesta final se envía", async () => {
    // La tool 'echo' habilitada vía tool_configs (el gate real por workspace)
    h.db.tables.tool_configs = [
      {
        id: "tc-1",
        workspace_id: WS,
        enabled: true,
        config: {},
        tool: { key: "echo" },
      },
    ];

    const res = await postWebhook(
      inboundPayload({ wamid: "wamid.in.1", text: "probá el eco con ping" }),
    );
    expect(res.status).toBe(200);

    makeBatchClaimable();
    h.llmResponses = [
      llmToolCall("echo", { msg: "ping" }),
      llmText("Listo, el eco devolvió: ping"),
    ];

    const result = await processNextBatch();
    expect(result.processed).toBe(true);
    await flushMicrotasks(); // el log de tool_call es fire-and-forget

    // Dos rounds con el LLM: tool_call + respuesta final
    expect(h.llmCalls).toHaveLength(2);

    // El primer request expuso la tool 'echo' al modelo
    const tools = (h.llmCalls[0].tools ?? []) as Array<{
      function?: { name?: string };
    }>;
    expect(tools.some((t) => t.function?.name === "echo")).toBe(true);

    // El segundo request llevó el resultado de la tool (role: tool)
    const roles = (
      h.llmCalls[1].messages as Array<{ role: string }>
    ).map((m) => m.role);
    expect(roles).toContain("tool");

    // La ejecución de la tool quedó auditada en events
    const toolCalls = (h.db.tables.events ?? []).filter(
      (e) => e.type === "tool_call",
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].payload).toMatchObject({
      tool_name: "echo",
      result_ok: true,
    });

    // La respuesta final salió por YCloud y quedó persistida
    expect(h.ycloudCalls).toHaveLength(1);
    expect(h.ycloudCalls[0].body).toMatchObject({
      text: { body: "Listo, el eco devolvió: ping" },
    });
    expect(outboundMessages()).toHaveLength(1);
    expect(outboundMessages()[0].body).toBe("Listo, el eco devolvió: ping");
  });

  it("e. conversación en human_active NO genera respuesta de IA", async () => {
    const res = await postWebhook(
      inboundPayload({ wamid: "wamid.in.1", text: "hola" }),
    );
    expect(res.status).toBe(200);

    // Un humano tomó la conversación mientras el batch seguía en buffering
    h.db.tables.conversations[0].state = "human_active";

    makeBatchClaimable();
    const result = await processNextBatch();

    // El batch se cierra (processed) pero sin IA ni envío
    expect(result.processed).toBe(true);
    expect(h.db.tables.message_batches[0].status).toBe("processed");
    expect(h.llmCalls).toHaveLength(0);
    expect(h.ycloudCalls).toHaveLength(0);
    expect(outboundMessages()).toHaveLength(0);
  });

  it("f. ai_enabled=false a nivel webhook: se persiste el mensaje pero no se bufferea", async () => {
    // Conversación pre-existente con la IA apagada (toggle del inbox)
    const contact = {
      id: "contact-pre",
      workspace_id: WS,
      phone: CUSTOMER_PHONE,
      opt_in: true,
      tags: [],
    };
    h.db.tables.contacts = [contact];
    h.db.tables.conversations = [
      {
        id: "conv-pre",
        workspace_id: WS,
        contact_id: contact.id,
        channel: "whatsapp",
        state: "ai_active",
        ai_enabled: false,
        window_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ];

    const res = await postWebhook(
      inboundPayload({ wamid: "wamid.in.1", text: "hola" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ received: true, ai: false });

    // El mensaje quedó en el inbox para el humano, pero sin batch ni IA
    expect(h.db.tables.messages).toHaveLength(1);
    expect(h.db.tables.message_batches ?? []).toHaveLength(0);
    expect(writesTo("message_batches")).toHaveLength(0);
    expect(h.llmCalls).toHaveLength(0);
    expect(h.ycloudCalls).toHaveLength(0);
  });
});
