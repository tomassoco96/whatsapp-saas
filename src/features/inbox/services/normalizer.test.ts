import { describe, it, expect } from "vitest";
import { normalizePhone, DEFAULT_COUNTRY_CODE } from "./normalizer";

describe("normalizePhone", () => {
  it("respeta números que ya vienen en E.164", () => {
    expect(normalizePhone("+5491112345678")).toBe("+5491112345678");
  });

  it("limpia espacios, guiones y paréntesis", () => {
    expect(normalizePhone("+54 9 11 1234-5678")).toBe("+5491112345678");
    expect(normalizePhone("(55) 1234 5678", "52")).toBe("+525512345678");
  });

  it("antepone el código de país del workspace a números nacionales (≤10 dígitos)", () => {
    expect(normalizePhone("5512345678", "52")).toBe("+525512345678");
    expect(normalizePhone("1112345678", "549")).toBe("+5491112345678");
  });

  it("no antepone código si el número ya tiene más de 10 dígitos", () => {
    expect(normalizePhone("5215512345678", "52")).toBe("+5215512345678");
  });

  it("sin defaultCountryCode solo antepone '+'", () => {
    expect(normalizePhone("5512345678")).toBe("+5512345678");
  });

  it("el default del sistema es México (52)", () => {
    expect(DEFAULT_COUNTRY_CODE).toBe("52");
  });
});
