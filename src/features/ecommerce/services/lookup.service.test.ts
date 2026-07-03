import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";
import type { WooOrder } from "../types";
import type { WcWorkspaceConfig } from "./wc-config";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

vi.mock("./wc-client", () => ({
  getOrderById: vi.fn(),
  searchOrderByPhone: vi.fn(),
}));

import { lookupOrder } from "./lookup.service";
import { getOrderById, searchOrderByPhone } from "./wc-client";

const mockById = vi.mocked(getOrderById);
const mockByPhone = vi.mocked(searchOrderByPhone);

const CFG: WcWorkspaceConfig = {
  storeUrl: "https://tienda.test",
  consumerKey: "ck_real",
  consumerSecret: "cs_real",
  extraStopwords: [],
  statusMessages: null,
};

const CTX = { workspaceId: "ws1", conversationId: "conv1" };

function order(over: Partial<WooOrder> = {}): WooOrder {
  return {
    id: 1234,
    status: "en-produccion",
    total: "25000",
    currency: "ARS",
    dateCreated: "2026-07-01T10:00:00",
    paymentMethodTitle: "Transferencia",
    items: [{ name: "Pijama Invierno", qty: 2 }],
    ...over,
  };
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

describe("lookupOrder", () => {
  it("por ID: devuelve estado normalizado con mensaje listo para el cliente", async () => {
    mockById.mockResolvedValue(order());
    const r = await lookupOrder(CFG, { orderId: 1234 }, CTX);

    expect(r.found).toBe(true);
    expect(r.order?.statusLabel).toBe("En producción");
    expect(r.message).toContain('Tu pedido #1234 está en estado "En producción"');
    expect(mockById).toHaveBeenCalledWith(CFG, 1234);
  });

  it("aplica los status_messages custom del workspace", async () => {
    mockById.mockResolvedValue(order({ status: "listo-retirar" }));
    const cfg = {
      ...CFG,
      statusMessages: {
        "listo-retirar": { label: "Listo", customerMsg: "pasá a retirarlo" },
      },
    };
    const r = await lookupOrder(cfg, { orderId: 1234 }, CTX);
    expect(r.order?.statusLabel).toBe("Listo");
    expect(r.message).toContain("pasá a retirarlo");
  });

  it("por teléfono: prueba las variantes en orden hasta matchear", async () => {
    mockByPhone
      .mockResolvedValueOnce(null) // nacional 10 dígitos
      .mockResolvedValueOnce(order()); // E.164
    const r = await lookupOrder(CFG, { phone: "+5492216208886" }, CTX);

    expect(r.found).toBe(true);
    expect(mockByPhone).toHaveBeenNthCalledWith(1, CFG, "2216208886");
    expect(mockByPhone).toHaveBeenNthCalledWith(2, CFG, "+5492216208886");
  });

  it("orden no encontrada por ID: pide re-verificar el número", async () => {
    mockById.mockResolvedValue(null);
    const r = await lookupOrder(CFG, { orderId: 99 }, CTX);
    expect(r.found).toBe(false);
    expect(r.message).toContain("No encuentro la orden 99");
  });

  it("sin match por teléfono: pide el número de orden", async () => {
    mockByPhone.mockResolvedValue(null);
    const r = await lookupOrder(CFG, { phone: "2216208886" }, CTX);
    expect(r.found).toBe(false);
    expect(r.message).toContain("número de orden");
  });

  it("error de WooCommerce: deriva sin lanzar", async () => {
    mockById.mockRejectedValue(new Error("WooCommerce respondió 500"));
    const r = await lookupOrder(CFG, { orderId: 1234 }, CTX);
    expect(r.found).toBe(false);
    expect(r.message).toContain("te derivo con alguien del equipo");
  });

  it("sin credenciales REST: deriva sin llamar a WooCommerce", async () => {
    const cfg = { ...CFG, consumerKey: null, consumerSecret: null };
    const r = await lookupOrder(cfg, { orderId: 1234 }, CTX);
    expect(r.found).toBe(false);
    expect(mockById).not.toHaveBeenCalled();
  });

  it("loguea la consulta en events con el resultado", async () => {
    mockById.mockResolvedValue(order());
    await lookupOrder(CFG, { orderId: 1234 }, CTX);

    const log = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "insert",
    );
    expect(log).toBeDefined();
    const row = log!.args[0] as {
      type: string;
      workspace_id: string;
      payload: Record<string, unknown>;
    };
    expect(row.type).toBe("order_lookup");
    expect(row.workspace_id).toBe("ws1");
    expect(row.payload.found).toBe(true);
    expect(row.payload.wc_order_id).toBe(1234);
  });
});
