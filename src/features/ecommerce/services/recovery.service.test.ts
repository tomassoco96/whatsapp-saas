import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

vi.mock("@/features/inbox/services/dispatch", () => ({
  dispatchTemplate: vi.fn(),
  dispatchText: vi.fn(),
}));

vi.mock("./wc-client", () => ({
  searchOrderByPhone: vi.fn(),
}));

import { runRecoverySweep } from "./recovery.service";
import { dispatchTemplate } from "@/features/inbox/services/dispatch";
import { searchOrderByPhone } from "./wc-client";

const mockDispatch = vi.mocked(dispatchTemplate);
const mockByPhone = vi.mocked(searchOrderByPhone);

// 12:00 en Buenos Aires (15:00 UTC): fuera de quiet hours 21→09
const NOW = new Date("2026-07-03T15:00:00Z");

function integrationRow(recoveryOver: Record<string, unknown> = {}) {
  return {
    workspace_id: "ws1",
    credentials: {}, // sin keys REST → el sweep saltea la re-verificación de pago
    config: {
      store_url: "https://tienda.test",
      recovery: {
        enabled: true,
        touches: [
          { template_name: "carrito_1", delay_hours: 1 },
          { template_name: "carrito_2", delay_hours: 24 },
        ],
        ...recoveryOver,
      },
    },
  };
}

function cartRow(over: Record<string, unknown> = {}) {
  return {
    id: "cart1",
    workspace_id: "ws1",
    contact_id: "contact1",
    phone: "+5492216208886",
    customer_name: "Cliente",
    status: "pending",
    touches_sent: 0,
    abandoned_at: "2026-07-03T10:00:00Z", // hace 5h: primer toque (1h) debido
    last_touch_at: null,
    ...over,
  };
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  mockDispatch.mockReset();
  mockByPhone.mockReset();
});

describe("runRecoverySweep", () => {
  it("envía el toque debido con claim idempotente y lo loguea", async () => {
    h.mock.queue.push(
      { data: [integrationRow()] }, // integrations
      { data: [cartRow()] }, // carts del workspace
      { data: { id: "contact1", opt_in: true } }, // contacto vinculado
      { data: { id: "conv1" } }, // conversación upsert
      { data: [{ id: "cart1" }] }, // claim OK
      { data: null }, // event log
    );
    mockDispatch.mockResolvedValue({ ok: true, wamid: "w1" });

    const r = await runRecoverySweep(NOW);

    expect(r.touchesSent).toBe(1);
    expect(r.errors).toBe(0);
    expect(mockDispatch).toHaveBeenCalledWith({
      workspaceId: "ws1",
      conversationId: "conv1",
      templateName: "carrito_1",
      templateLanguage: "es",
    });
    // el claim avanza touches_sent con guarda sobre el valor previo
    const claim = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "update",
    );
    expect((claim!.args[0] as { touches_sent: number }).touches_sent).toBe(1);
  });

  it("respeta quiet hours: no procesa carritos del workspace", async () => {
    // 23:30 en Buenos Aires
    const night = new Date("2026-07-04T02:30:00Z");
    h.mock.queue.push({
      data: [integrationRow({ quiet_hours: { start: "21:00", end: "09:00" } })],
    });

    const r = await runRecoverySweep(night);

    expect(r.workspacesProcessed).toBe(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    const cartQuery = h.mock.calls.find((c) => c.table === "abandoned_carts");
    expect(cartQuery).toBeUndefined();
  });

  it("workspace sin recovery habilitado: ni se consulta la tabla", async () => {
    h.mock.queue.push({
      data: [
        {
          workspace_id: "ws1",
          credentials: {},
          config: { store_url: "https://tienda.test" }, // sin recovery
        },
      ],
    });

    const r = await runRecoverySweep(NOW);
    expect(r.workspacesProcessed).toBe(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("contacto con opt-out: marca opted_out y no envía", async () => {
    h.mock.queue.push(
      { data: [integrationRow()] },
      { data: [cartRow()] },
      { data: { id: "contact1", opt_in: false } }, // opt-out
      { data: null }, // update a opted_out
    );

    const r = await runRecoverySweep(NOW);

    expect(r.optedOut).toBe(1);
    expect(r.touchesSent).toBe(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    const optOutUpdate = h.mock.calls.find(
      (c) =>
        c.table === "abandoned_carts" &&
        c.method === "update" &&
        (c.args[0] as { status?: string }).status === "opted_out",
    );
    expect(optOutUpdate).toBeDefined();
  });

  it("re-verificación de pago: pedido pagado → recovered sin molestar", async () => {
    const row = integrationRow();
    row.credentials = { wc_consumer_key: "ck", wc_consumer_secret: "cs" };
    h.mock.queue.push(
      { data: [row] },
      { data: [cartRow()] },
      { data: null }, // update a recovered
      { data: null }, // event log
    );
    mockByPhone.mockResolvedValueOnce({
      id: 555,
      status: "processing",
      total: "100",
      currency: "ARS",
      dateCreated: "2026-07-03",
      items: [],
    });

    const r = await runRecoverySweep(NOW);

    expect(r.recovered).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    const recoveredUpdate = h.mock.calls.find(
      (c) =>
        c.table === "abandoned_carts" &&
        (c.args[0] as { status?: string })?.status === "recovered",
    );
    expect(
      (recoveredUpdate!.args[0] as { recovered_order_id: number })
        .recovered_order_id,
    ).toBe(555);
  });

  it("carrera del claim: otro worker ya avanzó el toque → no envía", async () => {
    h.mock.queue.push(
      { data: [integrationRow()] },
      { data: [cartRow()] },
      { data: { id: "contact1", opt_in: true } },
      { data: { id: "conv1" } },
      { data: [] }, // claim devuelve 0 filas: perdió la carrera
    );

    const r = await runRecoverySweep(NOW);

    expect(r.touchesSent).toBe(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("toque todavía no debido: no hace nada con el carrito", async () => {
    h.mock.queue.push(
      { data: [integrationRow()] },
      { data: [cartRow({ abandoned_at: NOW.toISOString() })] }, // recién abandonado
    );

    const r = await runRecoverySweep(NOW);

    expect(r.touchesSent).toBe(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("fallo del envío: cuenta el error y NO revierte el claim (sin duplicados)", async () => {
    h.mock.queue.push(
      { data: [integrationRow()] },
      { data: [cartRow()] },
      { data: { id: "contact1", opt_in: true } },
      { data: { id: "conv1" } },
      { data: [{ id: "cart1" }] }, // claim OK
      { data: null }, // event log del fallo
    );
    mockDispatch.mockResolvedValue({ ok: false, error: "template rechazado" });

    const r = await runRecoverySweep(NOW);

    expect(r.errors).toBe(1);
    expect(r.touchesSent).toBe(0);
    // ningún update posterior baja touches_sent
    const reverts = h.mock.calls.filter(
      (c) =>
        c.table === "abandoned_carts" &&
        c.method === "update" &&
        (c.args[0] as { touches_sent?: number }).touches_sent === 0,
    );
    expect(reverts).toHaveLength(0);
  });
});
