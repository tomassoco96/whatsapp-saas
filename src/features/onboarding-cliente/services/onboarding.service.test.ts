import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.mock.client }));

// imports del módulo bajo test DESPUÉS de los vi.mock
import {
  computeProgress,
  getOrSeedItems,
  sanitizePatch,
  updateItem,
  type OnboardingItem,
} from "./onboarding.service";
import {
  ONBOARDING_SECTIONS,
  ONBOARDING_SEED_ITEMS,
} from "./seed-items";

beforeEach(() => {
  h.mock = createSupabaseMock();
  vi.clearAllMocks();
});

const WS = "11111111-1111-1111-1111-111111111111";

function item(over: Partial<OnboardingItem> = {}): OnboardingItem {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    workspace_id: WS,
    section: "Negocio e identidad",
    label: "Logo en PNG",
    detail: null,
    kind: "entregable",
    status: "pendiente",
    owner: "cliente",
    due_date: null,
    notes: null,
    sort_order: 10,
    created_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
    ...over,
  };
}

// ── Template (integridad del seed) ──────────────────────────────────────────

describe("ONBOARDING_SEED_ITEMS", () => {
  it("cubre exactamente las secciones canónicas", () => {
    const sections = new Set(ONBOARDING_SEED_ITEMS.map((i) => i.section));
    expect([...sections]).toEqual([...ONBOARDING_SECTIONS]);
  });

  it("todos los ítems de envío tienen texto copiable y son nuestros", () => {
    const envios = ONBOARDING_SEED_ITEMS.filter((i) => i.kind === "envio");
    expect(envios.length).toBeGreaterThanOrEqual(4);
    for (const e of envios) {
      expect(e.section).toBe("Para enviar al cliente");
      expect(e.owner).toBe("nosotros");
      expect(e.detail).toBeTruthy();
      expect((e.detail ?? "").length).toBeGreaterThan(80);
    }
  });

  it("los sort_order son únicos y crecientes", () => {
    const orders = ONBOARDING_SEED_ITEMS.map((i) => i.sort_order);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});

// ── computeProgress ─────────────────────────────────────────────────────────

describe("computeProgress", () => {
  it("sin ítems devuelve 0/0 y 0% (no NaN)", () => {
    expect(computeProgress([])).toEqual({ total: 0, done: 0, percent: 0 });
  });

  it("cuenta recibido y no_aplica como completados; pendiente y enviado no", () => {
    const p = computeProgress([
      { status: "pendiente" },
      { status: "enviado" },
      { status: "recibido" },
      { status: "no_aplica" },
    ]);
    expect(p).toEqual({ total: 4, done: 2, percent: 50 });
  });

  it("redondea el porcentaje", () => {
    const p = computeProgress([
      { status: "recibido" },
      { status: "pendiente" },
      { status: "pendiente" },
    ]);
    expect(p.percent).toBe(33);
  });

  it("todo completado da 100%", () => {
    const p = computeProgress([
      { status: "recibido" },
      { status: "no_aplica" },
    ]);
    expect(p).toEqual({ total: 2, done: 2, percent: 100 });
  });
});

// ── getOrSeedItems ──────────────────────────────────────────────────────────

describe("getOrSeedItems", () => {
  it("siembra el template cuando el workspace no tiene ítems", async () => {
    const seeded = ONBOARDING_SEED_ITEMS.map((s, i) =>
      item({ ...s, id: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}` }),
    );
    h.mock.queue.push({ data: [] }, { data: seeded });

    const result = await getOrSeedItems(WS);

    const insert = h.mock.calls.find(
      (c) => c.table === "workspace_onboarding_items" && c.method === "insert",
    );
    expect(insert).toBeDefined();
    const rows = insert!.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(ONBOARDING_SEED_ITEMS.length);
    for (const row of rows) {
      expect(row.workspace_id).toBe(WS);
    }
    expect(result).toHaveLength(ONBOARDING_SEED_ITEMS.length);
  });

  it("NO duplica el seed cuando el workspace ya tiene ítems", async () => {
    h.mock.queue.push({ data: [item(), item({ id: "aaaaaaaa-0000-0000-0000-000000000002" })] });

    const result = await getOrSeedItems(WS);

    expect(result).toHaveLength(2);
    const insert = h.mock.calls.find((c) => c.method === "insert");
    expect(insert).toBeUndefined();
  });

  it("devuelve el seed ordenado por sort_order aunque el insert venga desordenado", async () => {
    h.mock.queue.push(
      { data: [] },
      {
        data: [
          item({ id: "aaaaaaaa-0000-0000-0000-000000000003", sort_order: 30 }),
          item({ id: "aaaaaaaa-0000-0000-0000-000000000001", sort_order: 10 }),
          item({ id: "aaaaaaaa-0000-0000-0000-000000000002", sort_order: 20 }),
        ],
      },
    );

    const result = await getOrSeedItems(WS);
    expect(result.map((i) => i.sort_order)).toEqual([10, 20, 30]);
  });

  it("propaga el error de lectura sin intentar sembrar", async () => {
    h.mock.queue.push({ data: null, error: { message: "boom" } });

    await expect(getOrSeedItems(WS)).rejects.toThrow("boom");
    expect(h.mock.calls.find((c) => c.method === "insert")).toBeUndefined();
  });

  it("propaga el error del insert del seed", async () => {
    h.mock.queue.push({ data: [] }, { data: null, error: { message: "insert falló" } });

    await expect(getOrSeedItems(WS)).rejects.toThrow("insert falló");
  });
});

// ── sanitizePatch ───────────────────────────────────────────────────────────

describe("sanitizePatch", () => {
  it("mantiene solo los campos editables y descarta el resto", () => {
    const out = sanitizePatch({
      status: "recibido",
      owner: "nosotros",
      notes: "ok",
      due_date: "2026-07-10",
      label: "hackeado",
      section: "otra",
      kind: "envio",
      workspace_id: "otro-ws",
    });
    expect(out).toEqual({
      status: "recibido",
      owner: "nosotros",
      notes: "ok",
      due_date: "2026-07-10",
    });
  });

  it("descarta valores inválidos de enum y fechas mal formadas", () => {
    expect(
      sanitizePatch({
        status: "listo",
        owner: "proveedor",
        due_date: "10/07/2026",
      }),
    ).toEqual({});
  });

  it("permite limpiar notes y due_date con null", () => {
    expect(sanitizePatch({ notes: null, due_date: null })).toEqual({
      notes: null,
      due_date: null,
    });
  });

  it("trunca notes larguísimas a 2000 caracteres", () => {
    const out = sanitizePatch({ notes: "x".repeat(5000) });
    expect((out.notes as string).length).toBe(2000);
  });
});

// ── updateItem ──────────────────────────────────────────────────────────────

describe("updateItem", () => {
  const ITEM_ID = "bbbbbbbb-0000-0000-0000-000000000001";

  it("actualiza con el patch saneado y ancla por workspace + id", async () => {
    const updated = item({ id: ITEM_ID, status: "recibido" });
    h.mock.queue.push({ data: updated });

    const result = await updateItem(WS, ITEM_ID, {
      status: "recibido",
      // @ts-expect-error — campo no editable, debe descartarse
      label: "no me podés tocar",
    });

    expect(result.status).toBe("recibido");

    const update = h.mock.calls.find(
      (c) => c.table === "workspace_onboarding_items" && c.method === "update",
    );
    expect(update).toBeDefined();
    expect(update!.args[0]).toEqual({ status: "recibido" });

    const eqs = h.mock.calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["id", ITEM_ID]);
    expect(eqs).toContainEqual(["workspace_id", WS]);
  });

  it("rechaza un patch vacío (o que quedó vacío tras sanear) sin tocar la DB", async () => {
    await expect(updateItem(WS, ITEM_ID, {})).rejects.toThrow("Patch vacío");
    await expect(
      // @ts-expect-error — status inválido a propósito
      updateItem(WS, ITEM_ID, { status: "cualquiera" }),
    ).rejects.toThrow("Patch vacío");
    expect(h.mock.calls).toHaveLength(0);
  });

  it("lanza si el ítem no existe en ese workspace", async () => {
    h.mock.queue.push({ data: null });

    await expect(
      updateItem(WS, ITEM_ID, { status: "recibido" }),
    ).rejects.toThrow("no encontrado");
  });

  it("propaga errores de la DB", async () => {
    h.mock.queue.push({ data: null, error: { message: "db caída" } });

    await expect(
      updateItem(WS, ITEM_ID, { notes: "hola" }),
    ).rejects.toThrow("db caída");
  });
});
