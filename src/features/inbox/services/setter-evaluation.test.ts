import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

vi.mock("./setter", () => ({
  getSetterConfig: vi.fn(),
  evaluateLead: vi.fn(),
}));

vi.mock("./dispatch", () => ({
  dispatchTemplate: vi.fn(),
  dispatchText: vi.fn(),
}));

vi.mock("./decision-engine", () => ({
  applyTransition: vi.fn(),
}));

vi.mock("./highlevel-client", () => ({
  syncContactToHL: vi.fn(),
  createHLOpportunity: vi.fn(),
}));

import { runSetterEvaluation } from "./setter-evaluation";
import { getSetterConfig, evaluateLead } from "./setter";
import { applyTransition } from "./decision-engine";
import { dispatchTemplate } from "./dispatch";

const mockGetConfig = vi.mocked(getSetterConfig);
const mockEvaluate = vi.mocked(evaluateLead);
const mockTransition = vi.mocked(applyTransition);
const mockTemplate = vi.mocked(dispatchTemplate);

const PARAMS = {
  workspaceId: "ws1",
  conversationId: "conv1",
  contactId: "contact1",
  history: [
    { role: "user" as const, content: "hola" },
    { role: "assistant" as const, content: "buenas!" },
  ],
  mergedText: "quiero el plan premium",
};

const CONFIG = {
  id: "setter-cfg-1",
  post_action: { type: "handoff" },
} as Awaited<ReturnType<typeof getSetterConfig>> & object;

function evaluation(over: Record<string, unknown> = {}) {
  return {
    score: 80,
    qualified: true,
    knocked_out: false,
    knockout_reason: null,
    summary: "lead caliente",
    ...over,
  } as Awaited<ReturnType<typeof evaluateLead>>;
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

describe("runSetterEvaluation", () => {
  it("dormant sin setter config: no evalúa ni toca la DB", async () => {
    mockGetConfig.mockResolvedValue(null);

    await runSetterEvaluation(PARAMS);

    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(h.mock.calls).toHaveLength(0);
  });

  it("idempotencia: lead ya calificado no se re-evalúa", async () => {
    mockGetConfig.mockResolvedValue(CONFIG);
    h.mock.queue.push({
      data: { tags: [], custom_fields: { lead_qualified: true }, stage: "qualified" },
    });

    await runSetterEvaluation(PARAMS);

    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it("debounce: si evaluó hace <2 turnos de usuario, saltea", async () => {
    mockGetConfig.mockResolvedValue(CONFIG);
    // history tiene 1 turno user + el actual = 2; última eval en turno 1 → diff 1 < 2
    h.mock.queue.push({
      data: {
        tags: [],
        custom_fields: { setter_eval_turns: 1 },
        stage: "lead",
      },
    });

    await runSetterEvaluation(PARAMS);

    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it("lead calificado: persiste score, sube stage y ejecuta el post_action handoff", async () => {
    mockGetConfig.mockResolvedValue(CONFIG);
    mockEvaluate.mockResolvedValue(evaluation());
    h.mock.queue.push(
      { data: { tags: [], custom_fields: {}, stage: "lead" } }, // contacto
      { data: null }, // update contacto
      { data: null }, // evento
    );

    await runSetterEvaluation(PARAMS);

    const update = h.mock.calls.find(
      (c) => c.table === "contacts" && c.method === "update",
    );
    const row = update!.args[0] as {
      stage?: string;
      custom_fields: Record<string, unknown>;
    };
    expect(row.stage).toBe("qualified");
    expect(row.custom_fields.lead_score).toBe(80);
    expect(row.custom_fields.lead_qualified).toBe(true);
    expect(mockTransition).toHaveBeenCalledWith("conv1", "handoff_pending");
  });

  it("knocked out: stage lost y NO ejecuta el post_action", async () => {
    mockGetConfig.mockResolvedValue(CONFIG);
    mockEvaluate.mockResolvedValue(
      evaluation({ qualified: false, knocked_out: true, knockout_reason: "sin presupuesto" }),
    );
    h.mock.queue.push(
      { data: { tags: [], custom_fields: {}, stage: "lead" } },
      { data: null },
      { data: null },
    );

    await runSetterEvaluation(PARAMS);

    const update = h.mock.calls.find(
      (c) => c.table === "contacts" && c.method === "update",
    );
    expect((update!.args[0] as { stage?: string }).stage).toBe("lost");
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockTemplate).not.toHaveBeenCalled();
  });

  it("nunca degrada a un customer aunque quede knocked out", async () => {
    mockGetConfig.mockResolvedValue(CONFIG);
    mockEvaluate.mockResolvedValue(
      evaluation({ qualified: false, knocked_out: true }),
    );
    h.mock.queue.push(
      { data: { tags: [], custom_fields: {}, stage: "customer" } },
      { data: null },
      { data: null },
    );

    await runSetterEvaluation(PARAMS);

    const update = h.mock.calls.find(
      (c) => c.table === "contacts" && c.method === "update",
    );
    expect((update!.args[0] as { stage?: string }).stage).toBeUndefined();
  });

  it("un error interno no lanza hacia el batch path y deja evento de error", async () => {
    mockGetConfig.mockResolvedValue(CONFIG);
    mockEvaluate.mockRejectedValue(new Error("LLM caído"));
    h.mock.queue.push(
      { data: { tags: [], custom_fields: {}, stage: "lead" } },
      { data: null }, // evento de error
    );

    await expect(runSetterEvaluation(PARAMS)).resolves.toBeUndefined();

    const errorEvent = h.mock.calls.find(
      (c) =>
        c.table === "events" &&
        c.method === "insert" &&
        (c.args[0] as { level?: string }).level === "error",
    );
    expect(errorEvent).toBeDefined();
  });
});
