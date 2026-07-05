import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

import { getEcommerceConnection, connectionCanLookupOrders } from "./provider";

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

describe("getEcommerceConnection", () => {
  it("sin integraciones habilitadas devuelve null", async () => {
    h.mock.queue.push({ data: [] });

    const conn = await getEcommerceConnection("ws1");

    expect(conn).toBeNull();
  });

  it("resuelve Tiendanube cuando es la única tienda conectada", async () => {
    h.mock.queue.push(
      { data: [{ provider: "tiendanube" }] },
      // fila que lee getTnConfig
      {
        data: {
          credentials: { tn_access_token: "tok_real" },
          config: { store_id: "123456", store_url: "https://tienda.test" },
        },
      },
    );

    const conn = await getEcommerceConnection("ws1");

    expect(conn?.provider).toBe("tiendanube");
    if (conn?.provider === "tiendanube") {
      expect(conn.cfg.storeId).toBe("123456");
      expect(conn.cfg.storeUrl).toBe("https://tienda.test");
    }
    expect(await connectionCanLookupOrders(conn!)).toBe(true);
  });

  it("resuelve Shopify con dominio normalizado", async () => {
    h.mock.queue.push(
      { data: [{ provider: "shopify" }] },
      {
        data: {
          credentials: { shopify_access_token: "shpat_x" },
          config: { shop_domain: "https://MiTienda.myshopify.com/" },
        },
      },
    );

    const conn = await getEcommerceConnection("ws1");

    expect(conn?.provider).toBe("shopify");
    if (conn?.provider === "shopify") {
      expect(conn.cfg.shopDomain).toBe("mitienda.myshopify.com");
    }
  });

  it("con varias tiendas gana WooCommerce (prioridad por compatibilidad)", async () => {
    h.mock.queue.push(
      { data: [{ provider: "shopify" }, { provider: "woocommerce" }] },
      // fila que lee getWcConfig
      {
        data: {
          credentials: { wc_consumer_key: "ck", wc_consumer_secret: "cs" },
          config: { store_url: "https://tienda.test" },
        },
      },
    );

    const conn = await getEcommerceConnection("ws1");

    expect(conn?.provider).toBe("woocommerce");
  });

  it("si la config del provider prioritario es inválida cae al siguiente", async () => {
    h.mock.queue.push(
      { data: [{ provider: "woocommerce" }, { provider: "shopify" }] },
      // wc config inválida (store_url http)
      { data: { credentials: {}, config: { store_url: "http://inseguro" } } },
      // shopify válida
      {
        data: {
          credentials: { shopify_access_token: "shpat_x" },
          config: { shop_domain: "mitienda.myshopify.com" },
        },
      },
    );

    const conn = await getEcommerceConnection("ws1");

    expect(conn?.provider).toBe("shopify");
  });
});
