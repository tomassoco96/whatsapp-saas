import { describe, it, expect } from "vitest";
import {
  normalizeArgentinePhone,
  argentinePhoneSearchVariants,
} from "./phone";

describe("normalizeArgentinePhone", () => {
  it("normaliza los formatos típicos argentinos a +549…", () => {
    expect(normalizeArgentinePhone("11 6286 6801")).toBe("+5491162866801");
    expect(normalizeArgentinePhone("011 15 6286-6801")).toBe("+5491162866801");
    expect(normalizeArgentinePhone("+54 9 11 6286 6801")).toBe(
      "+5491162866801",
    );
    expect(normalizeArgentinePhone("5491162866801")).toBe("+5491162866801");
  });

  it("devuelve null para inputs inválidos", () => {
    expect(normalizeArgentinePhone("")).toBeNull();
    expect(normalizeArgentinePhone(null)).toBeNull();
    expect(normalizeArgentinePhone("123")).toBeNull();
    expect(normalizeArgentinePhone("12345678901234")).toBeNull();
  });
});

describe("argentinePhoneSearchVariants", () => {
  it("devuelve variantes best-first: nacional → E.164 → sin '+'", () => {
    expect(argentinePhoneSearchVariants("+5492216208886")).toEqual([
      "2216208886",
      "+5492216208886",
      "5492216208886",
    ]);
  });

  it("agrega los dígitos crudos como fallback cuando no normaliza", () => {
    // 9 dígitos: no es un nacional AR válido, pero sirve como término crudo
    expect(argentinePhoneSearchVariants("221620888")).toEqual(["221620888"]);
  });

  it("deduplica preservando el orden", () => {
    const variants = argentinePhoneSearchVariants("2216208886");
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants[0]).toBe("2216208886");
  });

  it("input vacío devuelve lista vacía", () => {
    expect(argentinePhoneSearchVariants("")).toEqual([]);
    expect(argentinePhoneSearchVariants(null)).toEqual([]);
  });
});
