import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

// imports del módulo bajo test DESPUÉS de los vi.mock
import { upsertBatch } from "./buffer-enqueue";

const WS = "ws-1";
const CONV = "conv-1";
const MSG = "msg-1";

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

describe("upsertBatch", () => {
  it("crea un batch nuevo cuando no hay uno en buffering", async () => {
    h.mock.queue.push(
      { data: null }, // select batch existente → ninguno
      { data: { id: "batch-new" } }, // insert del batch nuevo
      { data: null }, // update messages.batch_id
    );

    const batchId = await upsertBatch({
      workspaceId: WS,
      conversationId: CONV,
      messageId: MSG,
    });

    expect(batchId).toBe("batch-new");

    const insert = h.mock.calls.find(
      (c) => c.table === "message_batches" && c.method === "insert",
    );
    expect(insert).toBeDefined();
    const payload = insert!.args[0] as Record<string, unknown>;
    expect(payload.workspace_id).toBe(WS);
    expect(payload.conversation_id).toBe(CONV);
    expect(payload.status).toBe("buffering");
    expect(payload.message_count).toBe(1);
    expect(payload.silence_ms).toBe(30_000); // default

    const link = h.mock.calls.find(
      (c) => c.table === "messages" && c.method === "update",
    );
    expect(link!.args[0]).toEqual({ batch_id: "batch-new" });
  });

  it("extiende el batch existente: incrementa count y corre flush_at", async () => {
    h.mock.queue.push(
      {
        data: {
          id: "batch-old",
          message_count: 2,
          flush_at: "2026-07-05T00:00:00.000Z",
        },
      }, // select → batch en buffering
      { data: null }, // update del batch
      { data: null }, // update messages.batch_id
    );

    const before = Date.now();
    const batchId = await upsertBatch({
      workspaceId: WS,
      conversationId: CONV,
      messageId: MSG,
      silenceMs: 10_000,
    });

    expect(batchId).toBe("batch-old");

    const update = h.mock.calls.find(
      (c) => c.table === "message_batches" && c.method === "update",
    );
    expect(update).toBeDefined();
    const payload = update!.args[0] as Record<string, unknown>;
    expect(payload.message_count).toBe(3);
    // flush_at se corre ~silenceMs hacia adelante
    const flushAt = new Date(payload.flush_at as string).getTime();
    expect(flushAt).toBeGreaterThanOrEqual(before + 10_000);

    // No debe insertar un batch nuevo
    const insert = h.mock.calls.find(
      (c) => c.table === "message_batches" && c.method === "insert",
    );
    expect(insert).toBeUndefined();
  });

  it("lanza si falla el insert del batch nuevo", async () => {
    h.mock.queue.push(
      { data: null }, // sin batch existente
      { data: null, error: { message: "insert boom" } }, // insert falla
    );

    await expect(
      upsertBatch({ workspaceId: WS, conversationId: CONV, messageId: MSG }),
    ).rejects.toThrow("Failed to create batch: insert boom");
  });

  it("no lanza si falla el link del mensaje (no fatal)", async () => {
    h.mock.queue.push(
      { data: null },
      { data: { id: "batch-x" } },
      { data: null, error: { message: "link boom" } }, // update messages falla
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const batchId = await upsertBatch({
      workspaceId: WS,
      conversationId: CONV,
      messageId: MSG,
    });
    expect(batchId).toBe("batch-x");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
