import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";
import type { AbandonedCartWebhook } from "../schemas/cart";
import { abandonedCartWebhookSchema } from "../schemas/cart";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

import {
  ingestAbandonedCart,
  verifyCartWebhookSecret,
} from "./cart-ingest.service";

function webhookPayload(
  over: Partial<AbandonedCartWebhook> = {},
): AbandonedCartWebhook {
  return {
    external_id: "cart-77",
    phone: "221 620 8886",
    name: "Cliente Prueba",
    items: [{ name: "Pijama Invierno", qty: 1, price: 14000 }],
    total: 14000,
    abandoned_at: "2026-07-03T12:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  h.mock = createSupabaseMock();
});

describe("verifyCartWebhookSecret", () => {
  it("acepta el secret exacto", () => {
    expect(verifyCartWebhookSecret("s3cr3t", "s3cr3t")).toBe(true);
  });

  it("rechaza secret distinto, vacío, null o no configurado", () => {
    expect(verifyCartWebhookSecret("s3cr3t", "otro")).toBe(false);
    expect(verifyCartWebhookSecret("s3cr3t", null)).toBe(false);
    expect(verifyCartWebhookSecret(null, "s3cr3t")).toBe(false);
    expect(verifyCartWebhookSecret("s3cr3t", "s3cr3t-extra")).toBe(false);
  });
});

describe("abandonedCartWebhookSchema", () => {
  it("acepta el payload mínimo (items + total + abandoned_at)", () => {
    const r = abandonedCartWebhookSchema.safeParse({
      items: [{ name: "Producto", qty: "2", price: "100" }],
      total: "200",
      abandoned_at: "2026-07-03 12:00:00",
    });
    expect(r.success).toBe(true);
    // coerción de strings numéricos de los plugins
    expect(r.data!.items[0].qty).toBe(2);
    expect(r.data!.total).toBe(200);
  });

  it("rechaza carrito sin ítems o con fecha rota", () => {
    expect(
      abandonedCartWebhookSchema.safeParse({
        items: [],
        total: 100,
        abandoned_at: "2026-07-03",
      }).success,
    ).toBe(false);
    expect(
      abandonedCartWebhookSchema.safeParse({
        items: [{ name: "X", qty: 1, price: 1 }],
        total: 1,
        abandoned_at: "no es fecha",
      }).success,
    ).toBe(false);
  });
});

describe("ingestAbandonedCart", () => {
  it("inserta un carrito nuevo con teléfono normalizado y contacto vinculado", async () => {
    h.mock.queue.push(
      { data: null }, // dedupe por external_id: no existe
      { data: { id: "contact-1" } }, // contacto matchea por teléfono
      { data: { id: "cart-uuid-1" } }, // insert
      { data: null }, // event log
    );

    const r = await ingestAbandonedCart("ws1", webhookPayload());

    expect(r).toEqual({
      cartId: "cart-uuid-1",
      deduped: false,
      contactable: true,
    });
    const insert = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "insert",
    );
    const row = insert!.args[0] as Record<string, unknown>;
    expect(row.phone).toBe("+5492216208886"); // E.164 AR
    expect(row.contact_id).toBe("contact-1");
    expect(row.status).toBe("pending");
  });

  it("dedupe fuerte: external_id ya ingresado devuelve el carrito existente", async () => {
    h.mock.queue.push({ data: { id: "cart-existente", status: "contacted" } });

    const r = await ingestAbandonedCart("ws1", webhookPayload());

    expect(r.deduped).toBe(true);
    expect(r.cartId).toBe("cart-existente");
    const insert = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "insert",
    );
    expect(insert).toBeUndefined();
    // contacted: NO se refresca el contenido (ya hubo un toque sobre lo anterior)
    const update = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "update",
    );
    expect(update).toBeUndefined();
  });

  it("dedupe fuerte sobre un pending: refresca items, total y checkout_url", async () => {
    h.mock.queue.push(
      { data: { id: "cart-existente", status: "pending" } },
      { data: null }, // update de refresh
    );

    const r = await ingestAbandonedCart(
      "ws1",
      webhookPayload({
        total: 20000,
        items: [{ name: "Pijama", qty: 2, price: 10000 }],
      }),
    );

    expect(r.deduped).toBe(true);
    const update = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "update",
    );
    expect(update).toBeDefined();
    const row = update!.args[0] as { total: number; items: unknown[] };
    expect(row.total).toBe(20000);
    expect(row.items).toHaveLength(1);
  });

  it("teléfono internacional con código de país (+52) queda contactable", async () => {
    h.mock.queue.push(
      { data: null }, // dedupe external_id
      { data: null }, // contacto no existe
      { data: { id: "cart-mx" } },
      { data: null }, // event
    );

    const r = await ingestAbandonedCart(
      "ws1",
      webhookPayload({ phone: "+52 1 55 1234 5678" }),
    );

    expect(r.contactable).toBe(true);
    const insert = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "insert",
    );
    expect((insert!.args[0] as { phone: string }).phone).toBe(
      "+5215512345678",
    );
  });

  it("dedupe blando: sin external_id, mismo teléfono con pending reciente", async () => {
    h.mock.queue.push({ data: { id: "cart-reciente" } });

    const r = await ingestAbandonedCart(
      "ws1",
      webhookPayload({ external_id: undefined }),
    );

    expect(r).toEqual({
      cartId: "cart-reciente",
      deduped: true,
      contactable: true,
    });
  });

  it("sin teléfono normalizable: queda not_contactable y no busca contacto", async () => {
    h.mock.queue.push(
      { data: null }, // dedupe external_id
      { data: { id: "cart-uuid-2" } }, // insert (sin lookup de contacto)
      { data: null }, // event log
    );

    const r = await ingestAbandonedCart(
      "ws1",
      webhookPayload({ phone: "123" }),
    );

    expect(r.contactable).toBe(false);
    const insert = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "insert",
    );
    const row = insert!.args[0] as Record<string, unknown>;
    expect(row.phone).toBeNull();
    expect(row.status).toBe("not_contactable");
    const contactLookup = h.mock.calls.find((c) => c.table === "contacts");
    expect(contactLookup).toBeUndefined();
  });

  it("sanitiza los nombres de los ítems antes de persistir", async () => {
    h.mock.queue.push(
      { data: null },
      { data: null }, // sin contacto
      { data: { id: "cart-uuid-3" } },
      { data: null },
    );

    await ingestAbandonedCart(
      "ws1",
      webhookPayload({
        items: [{ name: "Taza {system}\n<ignora>", qty: 1, price: 100 }],
      }),
    );

    const insert = h.mock.calls.find(
      (c) => c.table === "abandoned_carts" && c.method === "insert",
    );
    const items = (insert!.args[0] as { items: Array<{ name: string }> })
      .items;
    expect(items[0].name).toBe("Taza system ignora");
  });

  it("carrera con el índice único (23505): resuelve como dedupe", async () => {
    h.mock.queue.push(
      { data: null }, // dedupe: aún no existe
      { data: { id: "contact-1" } },
      { data: null, error: { message: "duplicate key", code: "23505" } }, // insert pierde la carrera
      { data: { id: "cart-ganador" } }, // re-lectura por external_id
    );

    const r = await ingestAbandonedCart("ws1", webhookPayload());

    expect(r).toEqual({
      cartId: "cart-ganador",
      deduped: true,
      contactable: true,
    });
  });

  it("registra el evento cart_abandoned con los datos clave", async () => {
    h.mock.queue.push(
      { data: null },
      { data: { id: "contact-1" } },
      { data: { id: "cart-uuid-4" } },
      { data: null },
    );

    await ingestAbandonedCart("ws1", webhookPayload());

    const log = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "insert",
    );
    const row = log!.args[0] as { type: string; payload: Record<string, unknown> };
    expect(row.type).toBe("cart_abandoned");
    expect(row.payload.cart_id).toBe("cart-uuid-4");
    expect(row.payload.contactable).toBe(true);
  });
});
