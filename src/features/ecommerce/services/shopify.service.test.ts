import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";
import type { ShopifyWorkspaceConfig } from "./shopify-config";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

import { searchProductsShopify, lookupOrderShopify } from "./shopify.service";

const CFG: ShopifyWorkspaceConfig = {
  shopDomain: "mitienda.myshopify.com",
  accessToken: "shpat_real",
  extraStopwords: [],
  statusMessages: null,
};

const CTX = { workspaceId: "ws1", conversationId: "conv1" };

// Nodo de producto como lo devuelve la Admin API GraphQL.
function shopifyProduct(over: Record<string, unknown> = {}) {
  return {
    legacyResourceId: "42",
    title: "Pijama Invierno",
    handle: "pijama-invierno",
    onlineStoreUrl: "https://mitienda.com/products/pijama-invierno",
    description: "Abrigado y suave",
    productType: "Pijamas",
    totalInventory: 3,
    tracksInventory: true,
    priceRangeV2: { minVariantPrice: { amount: "14000.0" } },
    ...over,
  };
}

function shopifyOrder(over: Record<string, unknown> = {}) {
  return {
    legacyResourceId: "999001",
    name: "#1234",
    createdAt: "2026-07-01T10:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    totalPriceSet: { shopMoney: { amount: "25000.00", currencyCode: "ARS" } },
    lineItems: {
      edges: [{ node: { title: "Pijama Invierno", quantity: 2 } }],
    },
    ...over,
  };
}

function edges(nodes: unknown[]) {
  return { edges: nodes.map((node) => ({ node })) };
}

const fetchMock = vi.fn();

function respondGraphql(data: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data }),
  } as Response;
}

function bodyOf(callIndex: number): string {
  const [, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
  return String(init.body);
}

beforeEach(() => {
  h.mock = createSupabaseMock();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchProductsShopify", () => {
  it("con resultados: normaliza el producto y manda el access token", async () => {
    fetchMock.mockResolvedValueOnce(
      respondGraphql({ products: edges([shopifyProduct()]) }),
    );

    const r = await searchProductsShopify(CFG, { query: "pijama", limit: 5 });

    expect(r.found).toBe(true);
    expect(r.count).toBe(1);
    expect(r.products[0].name).toBe("Pijama Invierno");
    expect(r.products[0].price).toBe("14000");
    expect(r.products[0].inStock).toBe(true);
    expect(r.products[0].permalink).toBe(
      "https://mitienda.com/products/pijama-invierno",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://mitienda.myshopify.com/admin/api/2025-07/graphql.json",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe("shpat_real");
    expect(bodyOf(0)).toContain("title:*pijama*");
  });

  it("sin resultados: agota los intentos de fallback y devuelve found:false", async () => {
    fetchMock.mockResolvedValue(respondGraphql({ products: edges([]) }));

    const r = await searchProductsShopify(CFG, {
      query: "pijama de invierno",
      limit: 5,
    });

    expect(r.found).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(r.message).toContain("https://mitienda.myshopify.com");
  });

  it("ambigua: devuelve varios productos", async () => {
    fetchMock.mockResolvedValueOnce(
      respondGraphql({
        products: edges([
          shopifyProduct(),
          shopifyProduct({ legacyResourceId: "43", title: "Pijama Verano" }),
        ]),
      }),
    );

    const r = await searchProductsShopify(CFG, { query: "pijama", limit: 5 });

    expect(r.count).toBe(2);
    expect(r.message).toContain("Pijama Verano");
  });

  it("sin onlineStoreUrl arma el link con el shop domain", async () => {
    fetchMock.mockResolvedValueOnce(
      respondGraphql({
        products: edges([shopifyProduct({ onlineStoreUrl: null })]),
      }),
    );

    const r = await searchProductsShopify(CFG, { query: "pijama", limit: 5 });

    expect(r.products[0].permalink).toBe(
      "https://mitienda.myshopify.com/products/pijama-invierno",
    );
  });

  it("credenciales inválidas (401): responde found:false sin lanzar", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ errors: "Invalid API key or access token" }),
    } as Response);

    const r = await searchProductsShopify(CFG, { query: "pijama", limit: 5 });

    expect(r.found).toBe(false);
    expect(r.message).toContain("No pude consultar el catálogo");
  });
});

describe("lookupOrderShopify", () => {
  it("por número de orden: busca por name y normaliza el estado", async () => {
    fetchMock.mockResolvedValueOnce(
      respondGraphql({ orders: edges([shopifyOrder()]) }),
    );

    const r = await lookupOrderShopify(CFG, { orderId: 1234 }, CTX);

    expect(r.found).toBe(true);
    expect(r.order?.id).toBe(1234);
    expect(r.order?.statusLabel).toBe("Pago confirmado");
    expect(bodyOf(0)).toContain("name:");
    expect(bodyOf(0)).toContain("#1234");
  });

  it("por teléfono: prueba variantes AR vía customers hasta matchear", async () => {
    fetchMock
      // variante 1 (nacional 10 dígitos): sin clientes
      .mockResolvedValueOnce(respondGraphql({ customers: edges([]) }))
      // variante 2 (+549...): cliente encontrado
      .mockResolvedValueOnce(
        respondGraphql({ customers: edges([{ legacyResourceId: "555" }]) }),
      )
      // órdenes del cliente
      .mockResolvedValueOnce(respondGraphql({ orders: edges([shopifyOrder()]) }));

    const r = await lookupOrderShopify(CFG, { phone: "0221 15-620-8886" }, CTX);

    expect(r.found).toBe(true);
    expect(r.order?.id).toBe(1234);
    expect(bodyOf(0)).toContain("2216208886");
    expect(bodyOf(1)).toContain("+5492216208886");
    expect(bodyOf(2)).toContain("customer_id:555");
  });

  it("fulfillment FULFILLED pisa al estado de pago", async () => {
    fetchMock.mockResolvedValueOnce(
      respondGraphql({
        orders: edges([shopifyOrder({ displayFulfillmentStatus: "FULFILLED" })]),
      }),
    );

    const r = await lookupOrderShopify(CFG, { orderId: 1234 }, CTX);

    expect(r.order?.statusLabel).toBe("Enviado");
  });

  it("sin match por teléfono: pide el número de orden", async () => {
    fetchMock.mockResolvedValue(respondGraphql({ customers: edges([]) }));

    const r = await lookupOrderShopify(CFG, { phone: "2216208886" }, CTX);

    expect(r.found).toBe(false);
    expect(r.message).toContain("número de orden");
  });

  it("credenciales inválidas (401): deriva sin lanzar", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ errors: "Invalid API key or access token" }),
    } as Response);

    const r = await lookupOrderShopify(CFG, { orderId: 1234 }, CTX);

    expect(r.found).toBe(false);
    expect(r.message).toContain("te derivo con alguien del equipo");
  });

  it("errores GraphQL (scope insuficiente): deriva sin lanzar", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: "Access denied for orders field" }],
      }),
    } as Response);

    const r = await lookupOrderShopify(CFG, { orderId: 1234 }, CTX);

    expect(r.found).toBe(false);
    expect(r.message).toContain("te derivo con alguien del equipo");
  });

  it("token PENDIENTE: deriva sin llamar a la API", async () => {
    const cfg = { ...CFG, accessToken: "PENDIENTE_TOKEN" };

    const r = await lookupOrderShopify(cfg, { orderId: 1234 }, CTX);

    expect(r.found).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loguea la consulta en events con provider shopify", async () => {
    fetchMock.mockResolvedValueOnce(
      respondGraphql({ orders: edges([shopifyOrder()]) }),
    );

    await lookupOrderShopify(CFG, { orderId: 1234 }, CTX);

    const log = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "insert",
    );
    expect(log).toBeDefined();
    const row = log!.args[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(row.type).toBe("order_lookup");
    expect(row.payload.provider).toBe("shopify");
    expect(row.payload.found).toBe(true);
  });
});
