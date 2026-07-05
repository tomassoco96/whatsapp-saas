import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.mock.client }));

// imports del módulo bajo test DESPUÉS de los vi.mock
import {
  monthRangeUtc,
  aggregateMonthlyCarts,
  aggregateConversationStats,
  aggregateLlmUsage,
  getMonthlyReport,
  type MonthlyCartRow,
  type MonthlyMessageRow,
} from "./monthly-report";

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

function cart(
  status: string,
  total: number | string | null = 1000,
  touches = 0,
): MonthlyCartRow {
  return { status, total, touches_sent: touches };
}

function msg(
  conversationId: string | null,
  direction: string,
  type: string | null = "text",
): MonthlyMessageRow {
  return { conversation_id: conversationId, direction, type };
}

describe("monthRangeUtc", () => {
  it("devuelve [inicio de mes, inicio del mes siguiente) en UTC", () => {
    const r = monthRangeUtc(2026, 6);
    expect(r.startIso).toBe("2026-06-01T00:00:00.000Z");
    expect(r.endIso).toBe("2026-07-01T00:00:00.000Z");
  });

  it("cruza el fin de año (diciembre → enero)", () => {
    const r = monthRangeUtc(2025, 12);
    expect(r.startIso).toBe("2025-12-01T00:00:00.000Z");
    expect(r.endIso).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rechaza meses y años inválidos", () => {
    expect(() => monthRangeUtc(2026, 0)).toThrow();
    expect(() => monthRangeUtc(2026, 13)).toThrow();
    expect(() => monthRangeUtc(2026, 1.5)).toThrow();
    expect(() => monthRangeUtc(1999, 5)).toThrow();
  });
});

describe("aggregateMonthlyCarts", () => {
  it("cuenta contactados (con toques) vs recuperados y suma el $ recuperado", () => {
    const s = aggregateMonthlyCarts([
      cart("pending", 1000, 0),
      cart("contacted", 2000, 1),
      cart("contacted", 500, 2),
      cart("recovered", 3000, 1),
      cart("recovered", 1500, 0), // recuperado antes del primer toque
      cart("expired", 800, 3),
    ]);

    expect(s.total).toBe(6);
    expect(s.contacted).toBe(4); // los que tienen touches_sent > 0
    expect(s.recovered).toBe(2);
    expect(s.recoveredValue).toBe(4500);
    expect(s.touchesSent).toBe(7);
    expect(s.conversionRate).toBeCloseTo(2 / 4);
  });

  it("sin contactados la conversión es null (no 0% engañoso)", () => {
    const s = aggregateMonthlyCarts([cart("pending"), cart("not_contactable")]);
    expect(s.conversionRate).toBeNull();
  });

  it("tolera totales string (numeric de Postgres) y null", () => {
    const s = aggregateMonthlyCarts([
      cart("recovered", "2500.50", 1),
      cart("recovered", null, 1),
      cart("recovered", "no-numerico", 1),
    ]);
    expect(s.recoveredValue).toBeCloseTo(2500.5);
  });

  it("lista vacía devuelve todo en cero", () => {
    const s = aggregateMonthlyCarts([]);
    expect(s.total).toBe(0);
    expect(s.recoveredValue).toBe(0);
    expect(s.conversionRate).toBeNull();
  });
});

describe("aggregateConversationStats", () => {
  it("separa resueltas por IA de derivadas a humano", () => {
    const stats = aggregateConversationStats(
      [
        msg("c1", "in"),
        msg("c1", "out"),
        msg("c2", "in"),
        msg("c2", "out"),
        msg("c3", "in"),
        msg("c3", "out", "template"),
      ],
      ["c2"],
    );

    expect(stats.total).toBe(3);
    expect(stats.handedOff).toBe(1);
    expect(stats.aiResolved).toBe(2);
    expect(stats.aiResolvedRate).toBeCloseTo(2 / 3);
    expect(stats.messagesIn).toBe(3);
    expect(stats.messagesOut).toBe(3);
    expect(stats.templatesSent).toBe(1);
  });

  it("deduplica handoffs repetidos de la misma conversación", () => {
    const stats = aggregateConversationStats(
      [msg("c1", "in"), msg("c2", "in")],
      ["c1", "c1", null],
    );
    expect(stats.handedOff).toBe(1);
    expect(stats.aiResolved).toBe(1);
  });

  it("un handoff sin mensajes en el mes cuenta como conversación del mes", () => {
    const stats = aggregateConversationStats([msg("c1", "in")], ["c9"]);
    expect(stats.total).toBe(2);
    expect(stats.handedOff).toBe(1);
    expect(stats.aiResolved).toBe(1);
  });

  it("sin actividad devuelve tasa null", () => {
    const stats = aggregateConversationStats([], []);
    expect(stats.total).toBe(0);
    expect(stats.aiResolvedRate).toBeNull();
  });
});

describe("aggregateLlmUsage", () => {
  it("suma tokens y estima el costo con la constante blended", () => {
    const s = aggregateLlmUsage([
      { payload: { total_tokens: 10_000 } },
      { payload: { total_tokens: 5_000 } },
    ]);
    expect(s.totalTokens).toBe(15_000);
    expect(s.calls).toBe(2);
    expect(s.estimatedCostUsd).toBeCloseTo(15_000 * 0.000_002);
  });

  it("ignora payloads sin total_tokens numérico", () => {
    const s = aggregateLlmUsage([
      { payload: { total_tokens: "500" } },
      { payload: null },
      { payload: {} },
    ]);
    expect(s.totalTokens).toBe(0);
    expect(s.calls).toBe(3);
  });
});

describe("getMonthlyReport", () => {
  it("arma el reporte completo filtrando por workspace y rango del mes", async () => {
    // Orden de la cola = orden de los .from() en el Promise.all:
    // 1) abandoned_carts, 2) messages, 3) events handoff, 4) events llm_usage
    h.mock.queue.push(
      { data: [cart("recovered", 2000, 1), cart("contacted", 500, 2)] },
      { data: [msg("c1", "in"), msg("c1", "out"), msg("c2", "in")] },
      { data: [{ conversation_id: "c2" }] },
      { data: [{ payload: { total_tokens: 50_000 } }] },
    );

    const report = await getMonthlyReport("ws-1", 2026, 6);

    expect(report.year).toBe(2026);
    expect(report.month).toBe(6);
    expect(report.carts.recovered).toBe(1);
    expect(report.carts.recoveredValue).toBe(2000);
    expect(report.carts.contacted).toBe(2);
    expect(report.conversations.total).toBe(2);
    expect(report.conversations.handedOff).toBe(1);
    expect(report.conversations.aiResolved).toBe(1);
    expect(report.llm.totalTokens).toBe(50_000);

    // Cada query filtra por workspace_id (multi-tenant, no se negocia)
    const wsFilters = h.mock.calls.filter(
      (c) => c.method === "eq" && c.args[0] === "workspace_id",
    );
    expect(wsFilters).toHaveLength(4);
    for (const call of wsFilters) expect(call.args[1]).toBe("ws-1");

    // El rango del mes es [inicio, inicio del mes siguiente)
    const gte = h.mock.calls.find((c) => c.method === "gte");
    const lt = h.mock.calls.find((c) => c.method === "lt");
    expect(gte?.args[1]).toBe("2026-06-01T00:00:00.000Z");
    expect(lt?.args[1]).toBe("2026-07-01T00:00:00.000Z");

    // El handoff se filtra por payload->>to
    const filter = h.mock.calls.find((c) => c.method === "filter");
    expect(filter?.args).toEqual(["payload->>to", "eq", "handoff_pending"]);
  });

  it("con un mes sin datos devuelve el reporte en cero", async () => {
    h.mock.queue.push({ data: [] }, { data: [] }, { data: [] }, { data: [] });

    const report = await getMonthlyReport("ws-1", 2026, 5);

    expect(report.carts.total).toBe(0);
    expect(report.conversations.total).toBe(0);
    expect(report.conversations.aiResolvedRate).toBeNull();
    expect(report.llm.estimatedCostUsd).toBe(0);
  });

  it("rechaza un mes inválido antes de tocar la DB", async () => {
    await expect(getMonthlyReport("ws-1", 2026, 13)).rejects.toThrow();
    expect(h.mock.calls).toHaveLength(0);
  });
});
