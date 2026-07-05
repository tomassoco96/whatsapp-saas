import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";
import type { TnWorkspaceConfig } from "./tn-config";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

import { searchProductsTn, lookupOrderTn } from "./tn.service";

const CFG: TnWorkspaceConfig = {
  storeId: "123456",
  accessToken: "tok_real",
  storeUrl: "https://tienda.test",
  extraStopwords: [],
  statusMessages: null,
};

const CTX = { workspaceId: "ws1", conversationId: "conv1" };

// Producto crudo como lo devuelve la API de Tiendanube (campos multi-idioma).
function tnProduct(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: { es: "Pijama Invierno" },
    description: { es: "<p>Abrigado &amp; suave</p>" },
    handle: { es: "pijama-invierno" },
    canonical_url: "https://tienda.test/productos/pijama-invierno/",
    published: true,
    variants: [
      { price: "14000.00", stock: 3, stock_management: true },
      { price: "12000.00", stock: 0, stock_management: true },
    ],
    categories: [{ name: { es: "Pijamas" } }],
    ...over,
  };
}

function tnOrder(over: Record<string, unknown> = {}) {
  return {
    id: 999001,
    number: 1234,
    status: "open",
    payment_status: "paid",
    shipping_status: "unpacked",
    total: "25000.00",
    currency: "ARS",
    created_at: "2026-07-01T10:00:00+0000",
    gateway_name: "Transferencia",
    customer: { phone: "+54 9 221 620-8886" },
    products: [{ name: "Pijama Invierno", quantity: 2 }],
    ...over,
  };
}

const fetchMock = vi.fn();

function respondJson(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchProductsTn", () => {
  it("con resultados: normaliza el producto y manda los headers de TN", async () => {
    fetchMock.mockResolvedValueOnce(respondJson([tnProduct()]));

    const r = await searchProductsTn(CFG, { query: "pijama", limit: 5 });

    expect(r.found).toBe(true);
    expect(r.count).toBe(1);
    expect(r.products[0].name).toBe("Pijama Invierno");
    expect(r.products[0].price).toBe("12000"); // el mínimo entre variantes
    expect(r.products[0].inStock).toBe(true); // una variante con stock alcanza
    expect(r.products[0].permalink).toBe(
      "https://tienda.test/productos/pijama-invierno/",
    );
    expect(r.message).toContain("Pijama Invierno");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.tiendanube.com/v1/123456/products?q=");
    expect(url).toContain("published=true");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authentication).toBe("bearer tok_real");
    expect(headers["User-Agent"]).toBeTruthy();
  });

  it("sin resultados: agota los intentos de fallback y devuelve found:false", async () => {
    fetchMock.mockResolvedValue(respondJson([]));

    const r = await searchProductsTn(CFG, {
      query: "pijama de invierno",
      limit: 5,
    });

    expect(r.found).toBe(false);
    expect(r.count).toBe(0);
    // frase completa → palabras significativas ("invierno", "pijama")
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(r.message).toContain("https://tienda.test");
  });

  it("ambigua: devuelve varios productos con sus links", async () => {
    fetchMock.mockResolvedValueOnce(
      respondJson([
        tnProduct(),
        tnProduct({
          id: 43,
          name: { es: "Pijama Verano" },
          canonical_url: "https://tienda.test/productos/pijama-verano/",
        }),
      ]),
    );

    const r = await searchProductsTn(CFG, { query: "pijama", limit: 5 });

    expect(r.count).toBe(2);
    expect(r.message).toContain("Pijama Invierno");
    expect(r.message).toContain("Pijama Verano");
  });

  it("credenciales inválidas (401): responde found:false sin lanzar", async () => {
    fetchMock.mockResolvedValue(respondJson({ error: "Unauthorized" }, 401));

    const r = await searchProductsTn(CFG, { query: "pijama", limit: 5 });

    expect(r.found).toBe(false);
    expect(r.message).toContain("No pude consultar el catálogo");
  });

  it("sanitiza el texto que viene de la tienda (anti prompt-injection)", async () => {
    fetchMock.mockResolvedValueOnce(
      respondJson([
        tnProduct({ name: { es: "Pijama <script>{{hack}}</script>" } }),
      ]),
    );

    const r = await searchProductsTn(CFG, { query: "pijama", limit: 5 });

    expect(r.products[0].name).not.toContain("<");
    expect(r.products[0].name).not.toContain("{");
  });
});

describe("lookupOrderTn", () => {
  it("por número de orden: matchea el number exacto y normaliza el estado", async () => {
    fetchMock.mockResolvedValueOnce(
      respondJson([tnOrder({ number: 9999 }), tnOrder()]),
    );

    const r = await lookupOrderTn(CFG, { orderId: 1234 }, CTX);

    expect(r.found).toBe(true);
    expect(r.order?.id).toBe(1234);
    expect(r.order?.statusLabel).toBe("Pago confirmado");
    expect(r.message).toContain('Tu pedido #1234 está en estado "Pago confirmado"');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/orders?q=1234");
  });

  it("por teléfono: matchea la variante AR contra el customer.phone de las órdenes", async () => {
    fetchMock.mockResolvedValueOnce(
      respondJson([
        tnOrder({ number: 777, customer: { phone: "1111111111" } }),
        tnOrder(), // phone "+54 9 221 620-8886" → dígitos 5492216208886
      ]),
    );

    const r = await lookupOrderTn(CFG, { phone: "0221 15-620-8886" }, CTX);

    expect(r.found).toBe(true);
    expect(r.order?.id).toBe(1234);
  });

  it("teléfono guardado en formato local también matchea", async () => {
    fetchMock.mockResolvedValueOnce(
      respondJson([tnOrder({ customer: { phone: "2216208886" } })]),
    );

    const r = await lookupOrderTn(CFG, { phone: "+5492216208886" }, CTX);

    expect(r.found).toBe(true);
  });

  it("estado enviado pisa al pago (shipping_status fulfilled)", async () => {
    fetchMock.mockResolvedValueOnce(
      respondJson([tnOrder({ shipping_status: "fulfilled" })]),
    );

    const r = await lookupOrderTn(CFG, { orderId: 1234 }, CTX);

    expect(r.order?.statusLabel).toBe("Enviado");
  });

  it("sin match: pide el número de orden", async () => {
    fetchMock.mockResolvedValue(respondJson([]));

    const r = await lookupOrderTn(CFG, { phone: "2216208886" }, CTX);

    expect(r.found).toBe(false);
    expect(r.message).toContain("número de orden");
  });

  it("credenciales inválidas (401): deriva sin lanzar", async () => {
    fetchMock.mockResolvedValue(respondJson({ error: "Unauthorized" }, 401));

    const r = await lookupOrderTn(CFG, { orderId: 1234 }, CTX);

    expect(r.found).toBe(false);
    expect(r.message).toContain("te derivo con alguien del equipo");
  });

  it("token PENDIENTE: deriva sin llamar a la API", async () => {
    const cfg = { ...CFG, accessToken: "PENDIENTE_TOKEN" };

    const r = await lookupOrderTn(cfg, { orderId: 1234 }, CTX);

    expect(r.found).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loguea la consulta en events con provider tiendanube", async () => {
    fetchMock.mockResolvedValueOnce(respondJson([tnOrder()]));

    await lookupOrderTn(CFG, { orderId: 1234 }, CTX);

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
    expect(row.payload.provider).toBe("tiendanube");
    expect(row.payload.found).toBe(true);
    expect(row.payload.order_id).toBe(1234);
  });
});
