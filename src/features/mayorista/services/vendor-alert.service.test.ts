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
  dispatchText: vi.fn(),
}));

import { notifyVendedorLead } from "./vendor-alert.service";
import { dispatchText } from "@/features/inbox/services/dispatch";

const mockDispatch = vi.mocked(dispatchText);

const WS = "ws-brogas";
const VENDEDOR = {
  id: "v1",
  nombre: "Victor Barreras",
  telefono: "+5491154725758",
  zona: "entre rios",
  multiple: false,
};
const LEAD = {
  razonSocial: "Ferretería El Tornillo SRL",
  nombreContacto: "Juan Pérez",
  cuit: "20123456786",
  provincia: "Entre Ríos",
  localidad: "Paraná",
  rubro: "ferretería",
  formatoVenta: "Venta al público",
  contactoPhone: "+5493764111222",
  email: "juan@tornillo.com",
  comentarios: null,
};

beforeEach(() => {
  h.mock = createSupabaseMock();
  mockDispatch.mockReset();
});

describe("notifyVendedorLead", () => {
  it("NO escribe al vendedor si las alertas están apagadas (default)", async () => {
    h.mock.queue.push({ data: { structured: {} } }); // business_info sin flag

    const ok = await notifyVendedorLead(WS, VENDEDOR, LEAD);

    expect(ok).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    // No debe tocar contacts ni conversations del vendedor
    expect(h.mock.calls.find((c) => c.table === "contacts")).toBeUndefined();
  });

  it("NO escribe si business_info no existe", async () => {
    h.mock.queue.push({ data: null });

    const ok = await notifyVendedorLead(WS, VENDEDOR, LEAD);

    expect(ok).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("con el flag encendido manda el resumen del lead por WhatsApp", async () => {
    h.mock.queue.push(
      { data: { structured: { vendor_alerts_enabled: true } } },
      { data: { id: "contact-v1" } }, // upsert contacto del vendedor
      { data: { id: "conv-v1" } }, // upsert conversacion
    );
    mockDispatch.mockResolvedValue({ ok: true, wamid: "w1" });

    const ok = await notifyVendedorLead(WS, VENDEDOR, LEAD);

    expect(ok).toBe(true);
    expect(mockDispatch).toHaveBeenCalledOnce();
    const body = mockDispatch.mock.calls[0][0].body;
    expect(body).toContain("Ferretería El Tornillo SRL");
    expect(body).toContain("20123456786");
    expect(body).toContain("+5493764111222");
  });

  it("vendedor sin teléfono → false, sin consultar nada", async () => {
    const ok = await notifyVendedorLead(WS, { ...VENDEDOR, telefono: null }, LEAD);

    expect(ok).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("si el envío falla, devuelve false sin lanzar", async () => {
    h.mock.queue.push(
      { data: { structured: { vendor_alerts_enabled: true } } },
      { data: { id: "contact-v1" } },
      { data: { id: "conv-v1" } },
    );
    mockDispatch.mockResolvedValue({ ok: false, error: "WINDOW_EXPIRED" });

    const ok = await notifyVendedorLead(WS, VENDEDOR, LEAD);

    expect(ok).toBe(false);
  });
});
