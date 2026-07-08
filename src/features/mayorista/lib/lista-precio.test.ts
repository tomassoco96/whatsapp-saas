import { describe, it, expect } from "vitest";
import { resolveListaPrecio } from "./lista-precio";

describe("resolveListaPrecio", () => {
  it("distribución → distribuidor", () => {
    expect(resolveListaPrecio("Distribución")).toBe("distribuidor");
    expect(resolveListaPrecio("revendo a comercios")).toBe("distribuidor");
    expect(resolveListaPrecio("reventa")).toBe("distribuidor");
  });

  it("venta al público → mayorista", () => {
    expect(resolveListaPrecio("Venta al público")).toBe("mayorista");
    expect(resolveListaPrecio("vendo al publico")).toBe("mayorista");
    expect(resolveListaPrecio("consumidor final")).toBe("mayorista");
  });

  it("indeterminado → null (el agente repregunta, nunca adivina)", () => {
    expect(resolveListaPrecio("no sé")).toBeNull();
    expect(resolveListaPrecio(null)).toBeNull();
    expect(resolveListaPrecio(undefined)).toBeNull();
  });
});
