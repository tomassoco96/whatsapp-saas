import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSupabaseMock,
  type SupabaseMock,
} from "@/test/supabase-mock";

const h = vi.hoisted(() => ({ mock: null as unknown as SupabaseMock }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => h.mock.client,
}));

vi.mock("./resolve.service", () => ({
  resolveVendedor: vi.fn(),
}));

vi.mock("./vendor-alert.service", () => ({
  notifyVendedorLead: vi.fn(),
}));

import { qualifyLead } from "./qualify.service";
import { resolveVendedor } from "./resolve.service";
import { notifyVendedorLead } from "./vendor-alert.service";

const mockResolve = vi.mocked(resolveVendedor);
const mockNotify = vi.mocked(notifyVendedorLead);

const WS = "ws-brogas";
const PHONE = "+5493764111222";

const FULL_INPUT = {
  workspaceId: WS,
  contactoPhone: PHONE,
  nombreContacto: "Juan Pérez",
  razonSocial: "Ferretería El Tornillo SRL",
  cuit: "20-12345678-6",
  provincia: "Mendoza",
  localidad: "Godoy Cruz",
  email: "juan@tornillo.com",
  telefono: "+5492611234567",
  rubro: "ferretería",
  formatoVenta: "Venta al público",
};

beforeEach(() => {
  h.mock = createSupabaseMock();
  mockResolve.mockReset();
  mockNotify.mockReset();
});

describe("qualifyLead", () => {
  it("lead completo: asigna vendedor único, lo nombra y le manda la alerta", async () => {
    h.mock.queue.push(
      { data: null }, // select lead existente
      { error: null }, // upsert lead
      { error: null }, // update estado asignado
    );
    mockResolve.mockResolvedValue({
      id: "v1",
      nombre: "Juan Martin Munoz Fossati",
      telefono: "+5491178537001",
      zona: "mendoza",
      multiple: false,
    });
    mockNotify.mockResolvedValue(true);

    const result = await qualifyLead(FULL_INPUT);

    expect(result.estado).toBe("asignado");
    expect(result.message).toContain("Juan Martin Munoz Fossati");
    expect(mockNotify).toHaveBeenCalledOnce();
    const update = h.mock.calls.find(
      (c) => c.table === "leads_mayorista" && c.method === "update",
    );
    expect(update!.args[0]).toMatchObject({
      estado: "asignado",
      vendedor_id: "v1",
    });
  });

  it("zona con múltiples vendedores: asigna pero NO nombra al vendedor", async () => {
    h.mock.queue.push({ data: null }, { error: null }, { error: null });
    mockResolve.mockResolvedValue({
      id: "v2",
      nombre: "Fernando Dalli",
      telefono: "+5491151125521",
      zona: "buenos aires",
      multiple: true,
    });
    mockNotify.mockResolvedValue(true);

    const result = await qualifyLead(FULL_INPUT);

    expect(result.estado).toBe("asignado");
    expect(result.vendedor).toBeNull();
    expect(result.message).not.toContain("Dalli");
    expect(result.message).toContain("Un vendedor de tu zona");
  });

  it("bloque 1: pide primero identificación (nombre), no los datos del negocio", async () => {
    h.mock.queue.push({ data: null }, { error: null });

    // Da razón social + CUIT pero le falta el nombre (bloque 1 incompleto).
    const result = await qualifyLead({
      workspaceId: WS,
      contactoPhone: PHONE,
      razonSocial: "El Tornillo SRL",
      cuit: "20-12345678-6",
    });

    expect(result.estado).toBe("incompleto");
    // Pide el nombre (bloque 1), NO la provincia (bloque 2) todavía.
    expect(result.camposFaltantes).toContain("nombre y apellido");
    expect(result.camposFaltantes).not.toContain("provincia");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("bloque 2: con identificación completa, pide los datos del negocio juntos", async () => {
    h.mock.queue.push({ data: null }, { error: null });

    // Bloque 1 completo; falta todo el bloque 2.
    const result = await qualifyLead({
      workspaceId: WS,
      contactoPhone: PHONE,
      nombreContacto: "Juan Pérez",
      razonSocial: "El Tornillo SRL",
      cuit: "20-12345678-6",
    });

    expect(result.estado).toBe("incompleto");
    expect(result.camposFaltantes).toContain("provincia");
    expect(result.camposFaltantes).toContain("localidad");
    expect(result.camposFaltantes).toContain("rubro del comercio");
  });

  it("no pide teléfono ni email: no son obligatorios", async () => {
    h.mock.queue.push({ data: null }, { error: null }, { error: null });
    mockResolve.mockResolvedValue({
      id: "v1",
      nombre: "Juan Martin Munoz Fossati",
      telefono: "+5491178537001",
      zona: "mendoza",
      multiple: false,
    });
    mockNotify.mockResolvedValue(false);

    // Todo menos email y telefono → debe quedar completo igual.
    const result = await qualifyLead({
      workspaceId: WS,
      contactoPhone: PHONE,
      nombreContacto: "Juan Pérez",
      razonSocial: "El Tornillo SRL",
      cuit: "20-12345678-6",
      provincia: "Mendoza",
      localidad: "Godoy Cruz",
      rubro: "ferretería",
      formatoVenta: "Venta al público",
    });

    expect(result.estado).toBe("asignado");
  });

  it("CUIT inválido: mensaje específico, no 'necesito CUIT'", async () => {
    h.mock.queue.push({ data: null }, { error: null });

    const result = await qualifyLead({
      workspaceId: WS,
      contactoPhone: PHONE,
      nombreContacto: "Juan Pérez",
      razonSocial: "El Tornillo SRL",
      cuit: "20-12345678-0",
    });

    expect(result.estado).toBe("incompleto");
    expect(result.camposFaltantes).toContain("CUIT");
    expect(result.message).toContain("no me figura como válido");
  });

  it("formato_venta que no resuelve a lista (puso el rubro) cuenta como faltante", async () => {
    h.mock.queue.push({ data: null }, { error: null });

    const result = await qualifyLead({
      ...FULL_INPUT,
      formatoVenta: "ferretería", // puso el rubro en el campo equivocado
    });

    expect(result.estado).toBe("incompleto");
    expect(result.camposFaltantes).toContain(
      "si distribuís a comercios o vendés al público",
    );
  });

  it("propaga error si el upsert del lead falla (no sigue como si nada)", async () => {
    h.mock.queue.push(
      { data: null }, // select
      { error: { message: "db caída" } }, // upsert falla
    );

    const result = await qualifyLead(FULL_INPUT);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("coordino con el equipo");
  });

  it("rechaza sin razón social cuando el cliente dice que no tiene", async () => {
    h.mock.queue.push({ data: null }, { error: null });

    const result = await qualifyLead({
      workspaceId: WS,
      contactoPhone: PHONE,
      rechazaRazonSocial: true,
    });

    expect(result.estado).toBe("rechazado_sin_razon_social");
    expect(result.message).toContain("razón social");
  });

  it("merge no destructivo: un dato nuevo vacío no pisa el ya guardado", async () => {
    h.mock.queue.push(
      {
        data: {
          contacto_phone: PHONE,
          razon_social: "El Tornillo SRL",
          cuit: "20123456786",
          nombre_contacto: "Juan Pérez",
          provincia: "Mendoza",
          localidad: "Godoy Cruz",
          email: "juan@tornillo.com",
          telefono: "+5492611234567",
          rubro: "ferretería",
          formato_venta: "Venta al público",
        },
      },
      { error: null },
      { error: null },
    );
    mockResolve.mockResolvedValue({
      id: "v1",
      nombre: "Juan Martin Munoz Fossati",
      telefono: null,
      zona: "mendoza",
      multiple: false,
    });
    mockNotify.mockResolvedValue(false);

    // Solo aporta comentarios; el resto ya estaba y no debe perderse.
    const result = await qualifyLead({
      workspaceId: WS,
      contactoPhone: PHONE,
      comentarios: "quiere arrancar con un pedido chico",
    });

    expect(result.estado).toBe("asignado");
    const upsert = h.mock.calls.find(
      (c) => c.table === "leads_mayorista" && c.method === "upsert",
    );
    expect(upsert!.args[0]).toMatchObject({
      razon_social: "El Tornillo SRL",
      comentarios: "quiere arrancar con un pedido chico",
    });
  });

  it("sin vendedor de zona: queda calificado y registra alerta interna", async () => {
    h.mock.queue.push(
      { data: null }, // select
      { error: null }, // upsert
      { error: null }, // insert event (lead_sin_vendedor)
    );
    mockResolve.mockResolvedValue(null);

    const result = await qualifyLead({ ...FULL_INPUT, provincia: "Formosa" });

    expect(result.estado).toBe("calificado");
    expect(result.vendedor).toBeNull();
    expect(result.message).toContain("representante de la empresa");
    const event = h.mock.calls.find(
      (c) => c.table === "events" && c.method === "insert",
    );
    expect(event).toBeDefined();
  });
});
