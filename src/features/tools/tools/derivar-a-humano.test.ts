import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

import { derivarAHumanoTool } from "./derivar-a-humano";

const CTX = {
  workspaceId: "ws1",
  conversationId: "conv1",
  contactId: "contact1",
};

beforeEach(() => {
  h.mock = createSupabaseMock();
});

describe("derivar_a_humano", () => {
  it("pausa la IA (handoff_pending solo desde ai_active), registra el evento y etiqueta el contacto", async () => {
    h.mock.queue.push(
      { error: null }, // update conversations (transición)
      { error: null }, // insert event handoff_requested
      { data: { tags: ["cliente-nuevo"] } }, // select contact.tags
      { error: null }, // update contact.tags
    );

    const res = await derivarAHumanoTool.run(
      { etiqueta: "santiago", resumen: "Cliente se lastimó con una espátula", urgente: true },
      CTX,
    );

    expect(res.ok).toBe(true);

    // Transición atómica: update con guardas state=ai_active + state=handoff_pending
    const conv = h.mock.calls.find(
      (c) => c.table === "conversations" && c.method === "update",
    );
    expect((conv!.args[0] as { state: string; ai_enabled: boolean })).toMatchObject({
      state: "handoff_pending",
      ai_enabled: false,
    });
    // El .eq("state","ai_active") garantiza que no pise un estado humano.
    const guarded = h.mock.calls.some(
      (c) =>
        c.table === "conversations" &&
        c.method === "eq" &&
        c.args[0] === "state" &&
        c.args[1] === "ai_active",
    );
    expect(guarded).toBe(true);

    // Evento con urgencia -> level warn
    const ev = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "insert",
    );
    const evRow = ev!.args[0] as { type: string; level: string; payload: Record<string, unknown> };
    expect(evRow.type).toBe("handoff_requested");
    expect(evRow.level).toBe("warn");
    expect(evRow.payload.etiqueta).toBe("santiago");
    expect(evRow.payload.urgente).toBe(true);

    // Tag agregado sin duplicar los existentes
    const tagUpd = h.mock.calls.find(
      (c) => c.table === "contacts" && c.method === "update",
    );
    expect((tagUpd!.args[0] as { tags: string[] }).tags).toEqual([
      "cliente-nuevo",
      "derivar:santiago",
    ]);
  });

  it("caso NO urgente: registra y etiqueta pero NO pausa la IA (el bot sigue respondiendo)", async () => {
    h.mock.queue.push(
      { error: null }, // insert event
      { data: [] }, // select contact.tags
      { error: null }, // update contact.tags
    );

    const res = await derivarAHumanoTool.run(
      { etiqueta: "esteban", resumen: "Garantía de un calefactor", urgente: false },
      CTX,
    );

    expect(res.ok).toBe(true);
    // Clave del fix (item 5): un caso no urgente NO toca conversations (no pausa).
    const conv = h.mock.calls.find(
      (c) => c.table === "conversations" && c.method === "update",
    );
    expect(conv).toBeUndefined();
    // Pero sí registra el evento (level info) y etiqueta.
    const ev = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "insert",
    );
    expect((ev!.args[0] as { level: string }).level).toBe("info");
  });

  it("no duplica una etiqueta ya presente", async () => {
    // urgente:false → no hay update de conversations; el primer .from() es el
    // insert del evento, el segundo el select de tags.
    h.mock.queue.push(
      { error: null }, // insert event
      { data: { tags: ["derivar:nico"] } }, // select: ya tiene la etiqueta
    );

    await derivarAHumanoTool.run(
      { etiqueta: "nico", resumen: "Consulta minorista", urgente: false },
      CTX,
    );

    // No debe haber un update de contacts.tags (ya estaba)
    const tagUpd = h.mock.calls.find(
      (c) => c.table === "contacts" && c.method === "update",
    );
    expect(tagUpd).toBeUndefined();
  });

  it("nunca rompe el turno: ante error devuelve ok:false sin lanzar", async () => {
    h.mock.queue.push({ error: { message: "db caída" } });
    // El update lanza dentro por el error → catch. Simulamos con throw en la cola:
    h.mock.client.from = () => {
      throw new Error("db caída");
    };

    const res = await derivarAHumanoTool.run(
      { etiqueta: "santiago", resumen: "x", urgente: true },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});
