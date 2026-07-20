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
  it("crea/extiende vía el RPC atómico upsert_batch y linkea el mensaje", async () => {
    h.mock.queue.push(
      { data: "batch-42" }, // rpc upsert_batch → id
      { data: null }, // update messages.batch_id
    );

    const batchId = await upsertBatch({
      workspaceId: WS,
      conversationId: CONV,
      messageId: MSG,
      silenceMs: 10_000,
    });

    expect(batchId).toBe("batch-42");

    const rpc = h.mock.calls.find((c) => c.table === "rpc:upsert_batch");
    expect(rpc).toBeDefined();
    expect(rpc!.args[0]).toEqual({
      p_workspace_id: WS,
      p_conversation_id: CONV,
      p_silence_ms: 10_000,
    });

    const link = h.mock.calls.find(
      (c) => c.table === "messages" && c.method === "update",
    );
    expect(link!.args[0]).toEqual({ batch_id: "batch-42" });
  });

  it("usa el silence por defecto (30s) cuando no se pasa", async () => {
    h.mock.queue.push({ data: "batch-x" }, { data: null });

    await upsertBatch({ workspaceId: WS, conversationId: CONV, messageId: MSG });

    const rpc = h.mock.calls.find((c) => c.method === "rpc");
    expect((rpc!.args[0] as { p_silence_ms: number }).p_silence_ms).toBe(30_000);
  });

  it("lanza si el RPC falla", async () => {
    h.mock.queue.push({ data: null, error: { message: "rpc boom" } });

    await expect(
      upsertBatch({ workspaceId: WS, conversationId: CONV, messageId: MSG }),
    ).rejects.toThrow("Failed to upsert batch: rpc boom");
  });

  it("no lanza si falla el link del mensaje (no fatal)", async () => {
    h.mock.queue.push(
      { data: "batch-x" },
      { data: null, error: { message: "link boom" } },
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
