import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

// Dependencias pesadas del turno: mockeadas. Los tests de acá cubren la
// idempotencia y el reintento, que no dependen de la generación en sí.
vi.mock("./openrouter", () => ({ generateWithTools: vi.fn() }));
vi.mock("./cost-tracker", () => ({
  recordLlmUsage: vi.fn(),
  notifyRateLimited: vi.fn(),
}));
vi.mock("./dispatch", () => ({ dispatchText: vi.fn() }));
vi.mock("./decision-engine", () => ({ decide: vi.fn() }));
vi.mock("@/features/agents/services/auto-tagging", () => ({
  maybeAutoProcess: vi.fn(),
}));
vi.mock("./setter-evaluation", () => ({ runSetterEvaluation: vi.fn() }));
vi.mock("./batch-formatter", () => ({ formatInboundLine: () => "linea" }));
vi.mock("./buffer-context", () => ({ buildReplyContext: vi.fn() }));

import { processNextBatch } from "./buffer-process";
import { dispatchText } from "./dispatch";
import { decide } from "./decision-engine";

const mockDispatch = vi.mocked(dispatchText);
const mockDecide = vi.mocked(decide);

function batch(over: Record<string, unknown> = {}) {
  return {
    id: "batch-1",
    workspace_id: "ws-1",
    conversation_id: "conv-1",
    status: "processing",
    silence_ms: 10_000,
    flush_at: "2026-07-20T00:00:00.000Z",
    message_count: 1,
    merged_text: null,
    dispatched_at: null,
    retry_after: null,
    meta: {},
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

describe("processNextBatch — idempotencia (fix items 5/7)", () => {
  it("un batch ya despachado NO se re-envía: solo se marca processed", async () => {
    h.mock.queue.push(
      { data: [batch({ dispatched_at: "2026-07-20T00:01:00.000Z", merged_text: "hola" })] }, // claim
      { error: null }, // markBatchProcessed
    );

    const res = await processNextBatch();

    expect(res.processed).toBe(true);
    // Lo clave: no se despachó de nuevo.
    expect(mockDispatch).not.toHaveBeenCalled();
    // Ni se llegó a la decisión / generación.
    expect(mockDecide).not.toHaveBeenCalled();
    const marked = h.mock.calls.find(
      (c) => c.table === "message_batches" && c.method === "update",
    );
    expect((marked!.args[0] as { status: string }).status).toBe("processed");
  });

  it("sin batch listo: no hace nada", async () => {
    h.mock.queue.push({ data: [] }); // claim vacío
    const res = await processNextBatch();
    expect(res.processed).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("processNextBatch — reintento (fix item 7)", () => {
  it("al fallar el turno, el batch se queda en 'processing' con retry_after, NO vuelve a 'buffering'", async () => {
    h.mock.queue.push(
      { data: [batch()] }, // claim
      { data: [{ id: "m1", body: "hola", meta: null, type: "text", created_at: "x" }] }, // consolidateBatch select
      { data: null, error: { message: "Conversation not found: boom" } }, // load conversation → falla
      { error: null }, // update del reintento
    );

    const res = await processNextBatch();

    expect(res.processed).toBe(false);
    const update = h.mock.calls.find(
      (c) => c.table === "message_batches" && c.method === "update",
    );
    expect(update).toBeDefined();
    const payload = update!.args[0] as Record<string, unknown>;
    // Clave del fix: retry_after seteado y NO revierte a 'buffering'.
    expect(payload.retry_after).toBeDefined();
    expect(payload.status).toBeUndefined();
    expect((payload.meta as { retry_count: number }).retry_count).toBe(1);
  });
});
