import { describe, it, expect } from "vitest";
import { normalizeZona, canonicalize } from "./zona";

describe("canonicalize", () => {
  it("baja a minúsculas, quita acentos y colapsa espacios", () => {
    expect(canonicalize("  CÓRDOBA  ")).toBe("cordoba");
    expect(canonicalize("Tucumán")).toBe("tucuman");
    expect(canonicalize("Entre   Ríos")).toBe("entre rios");
  });
});

describe("normalizeZona", () => {
  it("mapea alias de CABA", () => {
    expect(normalizeZona("Capital Federal")).toBe("caba");
    expect(normalizeZona("CABA")).toBe("caba");
    expect(normalizeZona("Ciudad Autónoma de Buenos Aires")).toBe("caba");
  });

  it("mapea alias del conurbano/AMBA a buenos aires", () => {
    expect(normalizeZona("GBA")).toBe("buenos aires");
    expect(normalizeZona("zona sur")).toBe("buenos aires");
    expect(normalizeZona("AMBA")).toBe("buenos aires");
    expect(normalizeZona("Provincia de Buenos Aires")).toBe("buenos aires");
    expect(normalizeZona("Bs As")).toBe("buenos aires");
  });

  it("devuelve el token canónico para provincias sin alias", () => {
    expect(normalizeZona("Mendoza")).toBe("mendoza");
    expect(normalizeZona("Santiago del Estero")).toBe("santiago del estero");
    expect(normalizeZona("Sgo del Estero")).toBe("santiago del estero");
  });

  it("devuelve null para vacío o null", () => {
    expect(normalizeZona("")).toBeNull();
    expect(normalizeZona("   ")).toBeNull();
    expect(normalizeZona(null)).toBeNull();
    expect(normalizeZona(undefined)).toBeNull();
  });
});
