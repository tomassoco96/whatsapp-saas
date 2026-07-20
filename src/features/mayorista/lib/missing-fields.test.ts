import { describe, it, expect } from "vitest";
import {
  computeMissing,
  nextBlockMissing,
  missingLabels,
} from "./missing-fields";

const FULL = {
  nombreContacto: "Juan Pérez",
  razonSocial: "Ferretería El Tornillo SRL",
  cuit: "20-12345678-6",
  provincia: "Mendoza",
  localidad: "Godoy Cruz",
  rubro: "ferretería",
  formatoVenta: "Venta al público",
};

describe("computeMissing", () => {
  it("lead completo con CUIT válido → sin faltantes", () => {
    expect(computeMissing(FULL)).toEqual([]);
  });

  it("campos vacíos o con solo espacios cuentan como faltantes", () => {
    const missing = computeMissing({ ...FULL, localidad: "  ", rubro: null });
    expect(missing).toContain("localidad");
    expect(missing).toContain("rubro");
  });

  it("email y teléfono NO son obligatorios (no aparecen como faltantes)", () => {
    // FULL ya no incluye email ni telefono y no debe faltar nada.
    expect(computeMissing(FULL)).toEqual([]);
  });

  it("CUIT con dígito verificador inválido cuenta como faltante (gate fiscal)", () => {
    const missing = computeMissing({ ...FULL, cuit: "20-12345678-0" });
    expect(missing).toEqual(["cuit"]);
  });

  it("formatoVenta que no resuelve a lista de precios cuenta como faltante", () => {
    // "ferretería" es un rubro, no un formato de venta → no resuelve.
    const missing = computeMissing({ ...FULL, formatoVenta: "ferretería" });
    expect(missing).toEqual(["formatoVenta"]);
  });

  it("acepta los sinónimos de formato de venta", () => {
    expect(computeMissing({ ...FULL, formatoVenta: "distribuidor" })).toEqual([]);
    expect(computeMissing({ ...FULL, formatoVenta: "al público" })).toEqual([]);
  });

  it("missingLabels traduce a etiquetas naturales", () => {
    expect(missingLabels(["cuit", "formatoVenta"])).toEqual([
      "CUIT",
      "si distribuís a comercios o vendés al público",
    ]);
  });
});

describe("nextBlockMissing (dos bloques)", () => {
  it("con todo vacío pide primero el bloque 1 (identificación), no el 2", () => {
    const block = nextBlockMissing({});
    expect(block).toEqual(["nombreContacto", "razonSocial", "cuit"]);
    expect(block).not.toContain("provincia");
  });

  it("con el bloque 1 completo pide el bloque 2 (negocio)", () => {
    const block = nextBlockMissing({
      nombreContacto: "Juan",
      razonSocial: "El Tornillo SRL",
      cuit: "20-12345678-6",
    });
    expect(block).toEqual(["provincia", "localidad", "rubro", "formatoVenta"]);
  });

  it("si falta un solo dato del bloque 1, pide solo ese", () => {
    const block = nextBlockMissing({
      razonSocial: "El Tornillo SRL",
      cuit: "20-12345678-6",
    });
    expect(block).toEqual(["nombreContacto"]);
  });

  it("lead completo: ningún bloque pendiente", () => {
    expect(nextBlockMissing(FULL)).toEqual([]);
  });
});
