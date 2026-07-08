import { describe, it, expect } from "vitest";
import { computeMissing, missingLabels } from "./missing-fields";

const FULL = {
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

describe("computeMissing", () => {
  it("lead completo con CUIT válido → sin faltantes", () => {
    expect(computeMissing(FULL)).toEqual([]);
  });

  it("campos vacíos o con solo espacios cuentan como faltantes", () => {
    const missing = computeMissing({ ...FULL, email: "  ", rubro: null });
    expect(missing).toContain("email");
    expect(missing).toContain("rubro");
  });

  it("CUIT con dígito verificador inválido cuenta como faltante (gate fiscal)", () => {
    const missing = computeMissing({ ...FULL, cuit: "20-12345678-0" });
    expect(missing).toEqual(["cuit"]);
  });

  it("missingLabels traduce a etiquetas naturales", () => {
    expect(missingLabels(["cuit", "formatoVenta"])).toEqual([
      "CUIT",
      "si distribuís o vendés al público",
    ]);
  });
});
