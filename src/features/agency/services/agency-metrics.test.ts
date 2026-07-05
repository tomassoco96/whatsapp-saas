import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

// imports del módulo bajo test DESPUÉS de los vi.mock
import {
  aggregateAgencyRollup,
  getAgencyRollup,
  resolvePeriod,
  rollupToCsv,
  type AgencyRollup,
  type Period,
} from "./agency-metrics";

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// resolvePeriod
// ---------------------------------------------------------------------------

describe("resolvePeriod", () => {
  const now = new Date("2026-07-05T14:30:00.000Z");

  it("mes actual: del 1° del mes al 1° del mes siguiente (UTC)", () => {
    const p = resolvePeriod("actual", now);
    expect(p.key).toBe("actual");
    expect(p.start).toBe("2026-07-01T00:00:00.000Z");
    expect(p.end).toBe("2026-08-01T00:00:00.000Z");
    expect(p.monthKey).toBe("2026-07");
  });

  it("mes anterior: mes calendario completo previo", () => {
    const p = resolvePeriod("anterior", now);
    expect(p.key).toBe("anterior");
    expect(p.start).toBe("2026-06-01T00:00:00.000Z");
    expect(p.end).toBe("2026-07-01T00:00:00.000Z");
    expect(p.monthKey).toBe("2026-06");
  });

  it("cruza el año: anterior en enero es diciembre del año pasado", () => {
    const p = resolvePeriod("anterior", new Date("2026-01-15T00:00:00.000Z"));
    expect(p.start).toBe("2025-12-01T00:00:00.000Z");
    expect(p.end).toBe("2026-01-01T00:00:00.000Z");
    expect(p.monthKey).toBe("2025-12");
  });

  it("valor desconocido o undefined cae en 'actual'", () => {
    expect(resolvePeriod(undefined, now).key).toBe("actual");
    expect(resolvePeriod("cualquiera", now).key).toBe("actual");
  });
});

// ---------------------------------------------------------------------------
// aggregateAgencyRollup
// ---------------------------------------------------------------------------

const PERIOD: Period = {
  key: "actual",
  start: "2026-07-01T00:00:00.000Z",
  end: "2026-08-01T00:00:00.000Z",
  monthKey: "2026-07",
};

const WORKSPACES = [
  { id: "ws-a", name: "Tienda Alfa", slug: "alfa" },
  { id: "ws-b", name: "Tienda Beta", slug: "beta" },
];

describe("aggregateAgencyRollup", () => {
  it("cuenta solo conversaciones con actividad dentro del período", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [
        { workspace_id: "ws-a", state: "closed", last_message_at: "2026-07-10T10:00:00Z" },
        { workspace_id: "ws-a", state: "ai_active", last_message_at: "2026-06-20T10:00:00Z" }, // fuera
        { workspace_id: "ws-a", state: "ai_active", last_message_at: null }, // sin actividad
        { workspace_id: "ws-b", state: "waiting_reply", last_message_at: "2026-07-31T23:59:59Z" },
      ],
      carts: [],
      llmEvents: [],
      agents: [],
      period: PERIOD,
    });

    const a = rollup.rows.find((r) => r.id === "ws-a")!;
    const b = rollup.rows.find((r) => r.id === "ws-b")!;
    expect(a.conversations).toBe(1);
    expect(b.conversations).toBe(1);
    expect(rollup.totals.conversations).toBe(2);
    expect(rollup.totals.activeWorkspaces).toBe(2);
  });

  it("calcula % resueltas por IA (handoff_pending y human_active cuentan como humano)", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [
        { workspace_id: "ws-a", state: "closed", last_message_at: "2026-07-02T00:00:00Z" },
        { workspace_id: "ws-a", state: "ai_active", last_message_at: "2026-07-03T00:00:00Z" },
        { workspace_id: "ws-a", state: "handoff_pending", last_message_at: "2026-07-04T00:00:00Z" },
        { workspace_id: "ws-a", state: "human_active", last_message_at: "2026-07-05T00:00:00Z" },
      ],
      carts: [],
      llmEvents: [],
      agents: [],
      period: PERIOD,
    });

    const a = rollup.rows.find((r) => r.id === "ws-a")!;
    expect(a.iaResolvedRate).toBe(0.5);
    // sin conversaciones en el período → null, no 0
    const b = rollup.rows.find((r) => r.id === "ws-b")!;
    expect(b.iaResolvedRate).toBeNull();
  });

  it("suma $ recuperado solo de carritos con status recovered y tolera totales string/null", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [],
      carts: [
        { workspace_id: "ws-a", status: "recovered", total: "1500.50" },
        { workspace_id: "ws-a", status: "recovered", total: 500 },
        { workspace_id: "ws-a", status: "pending", total: 9999 },
        { workspace_id: "ws-a", status: "recovered", total: null },
        { workspace_id: "ws-x", status: "recovered", total: 100 }, // ws desconocido
      ],
      llmEvents: [],
      agents: [],
      period: PERIOD,
    });

    const a = rollup.rows.find((r) => r.id === "ws-a")!;
    expect(a.recoveredValue).toBe(2000.5);
    expect(rollup.totals.recoveredValue).toBe(2000.5);
  });

  it("estima gasto LLM con USD_PER_TOKEN = 0.000002 sobre payload.total_tokens", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [],
      carts: [],
      llmEvents: [
        { workspace_id: "ws-a", payload: { total_tokens: 500_000 } },
        { workspace_id: "ws-a", payload: { total_tokens: 500_000 } },
        { workspace_id: "ws-b", payload: null }, // payload nulo no rompe
      ],
      agents: [],
      period: PERIOD,
    });

    const a = rollup.rows.find((r) => r.id === "ws-a")!;
    const b = rollup.rows.find((r) => r.id === "ws-b")!;
    expect(a.llmCostUsd).toBeCloseTo(2, 6);
    expect(b.llmCostUsd).toBe(0);
    expect(rollup.totals.llmCostUsd).toBeCloseTo(2, 6);
  });

  it("cuenta agentes activos por workspace", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [],
      carts: [],
      llmEvents: [],
      agents: [{ workspace_id: "ws-a" }],
      period: PERIOD,
    });

    expect(rollup.rows.find((r) => r.id === "ws-a")!.activeAgents).toBe(1);
    expect(rollup.rows.find((r) => r.id === "ws-b")!.activeAgents).toBe(0);
  });

  it("salud: lastActivityAt es el último mensaje aunque quede fuera del período", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [
        { workspace_id: "ws-a", state: "closed", last_message_at: "2026-05-01T00:00:00Z" },
        { workspace_id: "ws-a", state: "closed", last_message_at: "2026-06-15T00:00:00Z" },
      ],
      carts: [],
      llmEvents: [],
      agents: [],
      period: PERIOD,
    });

    const a = rollup.rows.find((r) => r.id === "ws-a")!;
    expect(a.lastActivityAt).toBe("2026-06-15T00:00:00Z");
    expect(a.conversations).toBe(0);
    expect(rollup.totals.activeWorkspaces).toBe(0);
  });

  it("ordena por conversaciones desc y luego por nombre", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: [
        { id: "ws-1", name: "Zeta", slug: "zeta" },
        { id: "ws-2", name: "Alfa", slug: "alfa" },
        { id: "ws-3", name: "Gama", slug: "gama" },
      ],
      conversations: [
        { workspace_id: "ws-3", state: "closed", last_message_at: "2026-07-02T00:00:00Z" },
      ],
      carts: [],
      llmEvents: [],
      agents: [],
      period: PERIOD,
    });

    expect(rollup.rows.map((r) => r.id)).toEqual(["ws-3", "ws-2", "ws-1"]);
  });

  it("cuenta alertas abiertas por severidad, con críticas primero en los mensajes", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [],
      carts: [],
      llmEvents: [],
      agents: [],
      alerts: [
        { workspace_id: "ws-a", severity: "warning", message: "silencio anómalo" },
        { workspace_id: "ws-a", severity: "critical", message: "buffer trabado" },
        { workspace_id: "ws-x", severity: "critical", message: "ws desconocido" },
      ],
      period: PERIOD,
    });

    const a = rollup.rows.find((r) => r.id === "ws-a")!;
    expect(a.openAlerts.critical).toBe(1);
    expect(a.openAlerts.warning).toBe(1);
    expect(a.openAlerts.messages).toEqual(["buffer trabado", "silencio anómalo"]);
    const b = rollup.rows.find((r) => r.id === "ws-b")!;
    expect(b.openAlerts).toEqual({ critical: 0, warning: 0, messages: [] });
    expect(rollup.totals.openAlerts).toBe(2);
  });

  it("sin input de alertas (opcional) queda todo en cero", () => {
    const rollup = aggregateAgencyRollup({
      workspaces: WORKSPACES,
      conversations: [],
      carts: [],
      llmEvents: [],
      agents: [],
      period: PERIOD,
    });

    expect(rollup.totals.openAlerts).toBe(0);
    expect(rollup.rows[0].openAlerts).toEqual({
      critical: 0,
      warning: 0,
      messages: [],
    });
  });
});

// ---------------------------------------------------------------------------
// rollupToCsv
// ---------------------------------------------------------------------------

describe("rollupToCsv", () => {
  const rollup: AgencyRollup = {
    totals: {
      workspaces: 2,
      activeWorkspaces: 1,
      conversations: 10,
      recoveredValue: 2000.5,
      llmCostUsd: 1.23456,
      openAlerts: 0,
    },
    rows: [
      {
        id: "ws-a",
        name: 'Tienda "Alfa", SRL',
        slug: "alfa",
        conversations: 10,
        iaResolvedRate: 0.8,
        recoveredValue: 2000.5,
        llmCostUsd: 1.23456,
        activeAgents: 1,
        lastActivityAt: "2026-07-04T00:00:00Z",
        openAlerts: { critical: 0, warning: 0, messages: [] },
      },
      {
        id: "ws-b",
        name: "Beta",
        slug: "beta",
        conversations: 0,
        iaResolvedRate: null,
        recoveredValue: 0,
        llmCostUsd: 0,
        activeAgents: 0,
        lastActivityAt: null,
        openAlerts: { critical: 0, warning: 0, messages: [] },
      },
    ],
  };

  it("genera header + una fila por workspace, con escaping CSV", () => {
    const csv = rollupToCsv(rollup, PERIOD);
    const lines = csv.trimEnd().split("\r\n");

    expect(lines[0]).toBe(
      "periodo,workspace,slug,conversaciones,resueltas_ia_pct,recuperado,gasto_llm_usd,agentes_activos",
    );
    expect(lines[1]).toBe(
      '2026-07,"Tienda ""Alfa"", SRL",alfa,10,80,2000.50,1.2346,1',
    );
    // sin datos de IA → celda vacía, no 0
    expect(lines[2]).toBe("2026-07,Beta,beta,0,,0.00,0.0000,0");
    expect(lines).toHaveLength(3);
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAgencyRollup (fetch + agregación, con mock de Supabase)
// ---------------------------------------------------------------------------

describe("getAgencyRollup", () => {
  it("consulta workspaces y luego conv/carritos/eventos/agentes en orden", async () => {
    h.mock.queue.push(
      { data: WORKSPACES }, // workspaces
      {
        data: [
          { workspace_id: "ws-a", state: "closed", last_message_at: "2026-07-10T00:00:00Z" },
        ],
      }, // conversations
      { data: [{ workspace_id: "ws-a", status: "recovered", total: 300 }] }, // abandoned_carts
      { data: [{ workspace_id: "ws-a", payload: { total_tokens: 1000 } }] }, // events
      { data: [{ workspace_id: "ws-a" }] }, // agents
      {
        data: [
          { workspace_id: "ws-a", severity: "critical", message: "buffer trabado" },
        ],
      }, // workspace_alerts abiertas
    );

    const result = await getAgencyRollup(PERIOD);

    expect(result.error).toBeUndefined();
    const a = result.rollup!.rows.find((r) => r.id === "ws-a")!;
    expect(a.conversations).toBe(1);
    expect(a.recoveredValue).toBe(300);
    expect(a.llmCostUsd).toBeCloseTo(0.002, 6);
    expect(a.activeAgents).toBe(1);
    expect(a.openAlerts.critical).toBe(1);
    expect(result.rollup!.totals.workspaces).toBe(2);
    expect(result.rollup!.totals.openAlerts).toBe(1);

    // Se consultaron las 6 tablas esperadas
    const tables = h.mock.calls.map((c) => c.table);
    expect(tables).toContain("workspaces");
    expect(tables).toContain("conversations");
    expect(tables).toContain("abandoned_carts");
    expect(tables).toContain("events");
    expect(tables).toContain("agents");
    expect(tables).toContain("workspace_alerts");

    // solo alertas abiertas (resolved_at null)
    const alertsFilter = h.mock.calls.find(
      (c) => c.table === "workspace_alerts" && c.method === "filter",
    );
    expect(alertsFilter?.args).toEqual(["resolved_at", "is", null]);

    // events filtra por type llm_usage y ventana del período
    const eventsEq = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "eq",
    );
    expect(eventsEq?.args).toEqual(["type", "llm_usage"]);
    const eventsGte = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "gte",
    );
    expect(eventsGte?.args).toEqual(["created_at", PERIOD.start]);
    const eventsLt = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "filter",
    );
    expect(eventsLt?.args).toEqual(["created_at", "lt", PERIOD.end]);
  });

  it("sin workspaces devuelve roll-up vacío sin consultar el resto", async () => {
    h.mock.queue.push({ data: [] });

    const result = await getAgencyRollup(PERIOD);

    expect(result.error).toBeUndefined();
    expect(result.rollup!.rows).toEqual([]);
    expect(result.rollup!.totals.workspaces).toBe(0);
    const tables = new Set(h.mock.calls.map((c) => c.table));
    expect(tables.has("conversations")).toBe(false);
  });

  it("propaga el error si falla la query de workspaces", async () => {
    h.mock.queue.push({ data: null, error: { message: "boom" } });

    const result = await getAgencyRollup(PERIOD);
    expect(result.error).toBe("boom");
    expect(result.rollup).toBeUndefined();
  });

  it("propaga el error si falla alguna query secundaria", async () => {
    h.mock.queue.push(
      { data: WORKSPACES },
      { data: null, error: { message: "conv caída" } },
      { data: [] },
      { data: [] },
      { data: [] },
      { data: [] },
    );

    const result = await getAgencyRollup(PERIOD);
    expect(result.error).toBe("conv caída");
  });

  it("si falla la query de alertas el roll-up sigue (señal secundaria)", async () => {
    h.mock.queue.push(
      { data: WORKSPACES },
      { data: [] }, // conversations
      { data: [] }, // abandoned_carts
      { data: [] }, // events
      { data: [] }, // agents
      { data: null, error: { message: "no existe workspace_alerts" } },
    );

    const result = await getAgencyRollup(PERIOD);
    expect(result.error).toBeUndefined();
    expect(result.rollup!.totals.openAlerts).toBe(0);
  });
});
