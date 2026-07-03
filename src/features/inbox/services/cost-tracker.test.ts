import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

import { checkRateLimits, recordLlmUsage } from "./cost-tracker";

beforeEach(() => {
  h.mock = createSupabaseMock();
});

describe("checkRateLimits", () => {
  it("permite cuando está bajo ambos límites", async () => {
    h.mock.queue.push(
      { data: [{ id: "1" }, { id: "2" }] }, // 2 turnos en la hora (< 20)
      { data: [{ payload: { total_tokens: 5_000 } }] }, // 5k tokens hoy (< 1M)
    );
    const result = await checkRateLimits("ws1", "contact1");
    expect(result).toEqual({ allowed: true });
  });

  it("bloquea al llegar a 20 turnos por contacto en la hora", async () => {
    h.mock.queue.push({
      data: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })),
    });
    const result = await checkRateLimits("ws1", "contact1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rate_limit_contact_hour");
  });

  it("bloquea al agotar el presupuesto diario de 1M tokens", async () => {
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
  });

  it("ignora payloads sin total_tokens numérico al sumar el presupuesto", async () => {
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
    h.mock.queue.push({ data: null, error: { message: "db caída" } });
    const result = await checkRateLimits("ws1", "contact1");
    expect(result).toEqual({ allowed: true });
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
