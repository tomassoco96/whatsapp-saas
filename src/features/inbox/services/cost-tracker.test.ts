import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

vi.mock("./dispatch", () => ({
  dispatchText: vi.fn(),
}));

import {
  checkRateLimits,
  recordLlmUsage,
  getWorkspaceLimits,
  notifyRateLimited,
  DEFAULT_LIMITS,
} from "./cost-tracker";
import { dispatchText } from "./dispatch";

const mockDispatch = vi.mocked(dispatchText);

/** Primera consulta de checkRateLimits: los límites del workspace. */
function queueLimits(limits?: Record<string, unknown>) {
  h.mock.queue.push({ data: { settings: limits ? { limits } : {} } });
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  mockDispatch.mockReset();
});

describe("getWorkspaceLimits", () => {
  it("sin settings devuelve los defaults", async () => {
    h.mock.queue.push({ data: { settings: {} } });
    await expect(getWorkspaceLimits("ws1")).resolves.toEqual(DEFAULT_LIMITS);
  });

  it("lee los overrides del workspace", async () => {
    queueLimits({
      llm_turns_per_contact_per_hour: 60,
      llm_daily_budget_tokens: 5_000_000,
    });
    await expect(getWorkspaceLimits("ws1")).resolves.toEqual({
      turnsPerContactPerHour: 60,
      dailyBudgetTokens: 5_000_000,
    });
  });

  it("ignora overrides basura (string, cero, negativo) y cae al default", async () => {
    queueLimits({
      llm_turns_per_contact_per_hour: "muchos",
      llm_daily_budget_tokens: -1,
    });
    await expect(getWorkspaceLimits("ws1")).resolves.toEqual(DEFAULT_LIMITS);
  });

  it("fail-open: un error de DB devuelve los defaults, no bloquea", async () => {
    h.mock.queue.push({ data: null, error: { message: "db caída" } });
    await expect(getWorkspaceLimits("ws1")).resolves.toEqual(DEFAULT_LIMITS);
  });
});

describe("checkRateLimits", () => {
  it("permite cuando está bajo ambos límites", async () => {
    queueLimits();
    h.mock.queue.push(
      { data: [{ id: "1" }, { id: "2" }] }, // 2 turnos en la hora (< 20)
      { data: [{ payload: { total_tokens: 5_000 } }] }, // 5k tokens hoy (< 1M)
    );
    const result = await checkRateLimits("ws1", "contact1");
    expect(result).toEqual({ allowed: true });
  });

  it("bloquea al llegar a 20 turnos por contacto en la hora", async () => {
    queueLimits();
    h.mock.queue.push({
      data: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })),
    });
    const result = await checkRateLimits("ws1", "contact1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rate_limit_contact_hour");
    expect(result.limit).toBe(20);
  });

  it("con el límite subido a 60, esos mismos 20 turnos pasan", async () => {
    queueLimits({ llm_turns_per_contact_per_hour: 60 });
    h.mock.queue.push(
      { data: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })) },
      { data: [] },
    );
    const result = await checkRateLimits("ws1", "contact1");
    expect(result).toEqual({ allowed: true });
  });

  it("bloquea al agotar el presupuesto diario de 1M tokens", async () => {
    queueLimits();
    h.mock.queue.push(
      { data: [] }, // hourly ok
      {
        data: [
          { payload: { total_tokens: 600_000 } },
          { payload: { total_tokens: 400_000 } },
        ],
      },
    );
    const result = await checkRateLimits("ws1", "contact1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("daily_token_budget_exceeded");
    expect(result.limit).toBe(1_000_000);
  });

  it("con el presupuesto subido a 5M, ese mismo consumo pasa", async () => {
    queueLimits({ llm_daily_budget_tokens: 5_000_000 });
    h.mock.queue.push(
      { data: [] },
      { data: [{ payload: { total_tokens: 1_000_000 } }] },
    );
    const result = await checkRateLimits("ws1", "contact1");
    expect(result).toEqual({ allowed: true });
  });

  it("ignora payloads sin total_tokens numérico al sumar el presupuesto", async () => {
    queueLimits();
    h.mock.queue.push(
      { data: [] },
      {
        data: [
          { payload: { total_tokens: "999999999" } }, // string: no cuenta
          { payload: null },
          { payload: { total_tokens: 100 } },
        ],
      },
    );
    const result = await checkRateLimits("ws1", "contact1");
    expect(result).toEqual({ allowed: true });
  });

  it("fail-open: un error de DB no bloquea la respuesta", async () => {
    queueLimits();
    h.mock.queue.push({ data: null, error: { message: "db caída" } });
    const result = await checkRateLimits("ws1", "contact1");
    expect(result).toEqual({ allowed: true });
  });
});

describe("notifyRateLimited", () => {
  const PARAMS = {
    workspaceId: "ws1",
    conversationId: "conv1",
    contactId: "contact1",
    reason: "rate_limit_contact_hour" as const,
    limit: 20,
  };

  it("deja el evento y avisa al contacto la primera vez", async () => {
    h.mock.queue.push(
      { error: null }, // insert evento rate_limited
      { data: [] }, // no hay aviso previo en la ventana
      { error: null }, // insert evento rate_limit_notified
    );
    mockDispatch.mockResolvedValue({ ok: true, wamid: "w1" });

    const notified = await notifyRateLimited(PARAMS);

    expect(notified).toBe(true);
    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch.mock.calls[0][0].body).toContain("unos minutos");
    const event = h.mock.calls.find(
      (c) =>
        c.table === "events" &&
        c.method === "insert" &&
        (c.args[0] as { type: string }).type === "rate_limited",
    );
    expect((event!.args[0] as { payload: { limit: number } }).payload.limit).toBe(20);
  });

  it("no repite el aviso dentro de la misma ventana (pero sí registra el evento)", async () => {
    h.mock.queue.push(
      { error: null }, // insert evento rate_limited
      { data: [{ id: "ev-previo" }] }, // ya se aviso
    );

    const notified = await notifyRateLimited(PARAMS);

    expect(notified).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    const event = h.mock.calls.find(
      (c) =>
        c.table === "events" &&
        c.method === "insert" &&
        (c.args[0] as { type: string }).type === "rate_limited",
    );
    expect(event).toBeDefined();
  });

  it("si el envío falla, no marca como notificado", async () => {
    h.mock.queue.push({ error: null }, { data: [] });
    mockDispatch.mockResolvedValue({ ok: false, error: "WINDOW_EXPIRED" });

    const notified = await notifyRateLimited(PARAMS);

    expect(notified).toBe(false);
    const marked = h.mock.calls.find(
      (c) =>
        c.table === "events" &&
        c.method === "insert" &&
        (c.args[0] as { type: string }).type === "rate_limit_notified",
    );
    expect(marked).toBeUndefined();
  });

  it("usa un mensaje distinto para el presupuesto diario", async () => {
    h.mock.queue.push({ error: null }, { data: [] }, { error: null });
    mockDispatch.mockResolvedValue({ ok: true, wamid: "w1" });

    await notifyRateLimited({
      ...PARAMS,
      reason: "daily_token_budget_exceeded",
      limit: 1_000_000,
    });

    expect(mockDispatch.mock.calls[0][0].body).toContain("demora tecnica");
  });

  it("nunca lanza: un error interno devuelve false", async () => {
    h.mock.queue.push({ error: null }, { data: [] });
    mockDispatch.mockRejectedValue(new Error("canal caído"));

    await expect(notifyRateLimited(PARAMS)).resolves.toBe(false);
  });
});

describe("recordLlmUsage", () => {
  it("inserta el evento con total_tokens = prompt + completion", async () => {
    await recordLlmUsage({
      workspaceId: "ws1",
      conversationId: "conv1",
      contactId: "contact1",
      model: "test-model",
      promptTokens: 120,
      completionTokens: 80,
    });

    const insert = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "insert",
    );
    expect(insert).toBeDefined();
    const row = insert!.args[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(row.type).toBe("llm_usage");
    expect(row.payload.total_tokens).toBe(200);
    expect(row.payload.contact_id).toBe("contact1");
  });
});
