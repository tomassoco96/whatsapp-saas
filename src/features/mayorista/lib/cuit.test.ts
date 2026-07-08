import { describe, it, expect } from "vitest";
import { isValidCuit, normalizeCuit, formatCuit } from "./cuit";

describe("isValidCuit", () => {
  it("acepta CUIT con dígito verificador válido", () => {
    expect(isValidCuit("20123456786")).toBe(true);
    expect(isValidCuit("30712345671")).toBe(true);
  });

  it("acepta CUIT con guiones, puntos o espacios", () => {
    expect(isValidCuit("20-12345678-6")).toBe(true);
    expect(isValidCuit("20.12345678.6")).toBe(true);
    expect(isValidCuit("20 12345678 6")).toBe(true);
  });

  it("rechaza dígito verificador incorrecto", () => {
    expect(isValidCuit("20123456785")).toBe(false);
    expect(isValidCuit("20-12345678-0")).toBe(false);
  });

  it("rechaza largos distintos de 11 dígitos", () => {
    expect(isValidCuit("2012345678")).toBe(false);
    expect(isValidCuit("201234567861")).toBe(false);
    expect(isValidCuit("")).toBe(false);
  });

  it("rechaza 11 dígitos iguales", () => {
    expect(isValidCuit("11111111111")).toBe(false);
    expect(isValidCuit("00000000000")).toBe(false);
  });
});

describe("normalizeCuit / formatCuit", () => {
  it("normaliza dejando solo dígitos", () => {
    expect(normalizeCuit("20-12345678-6")).toBe("20123456786");
  });

  it("formatea como XX-XXXXXXXX-X", () => {
    expect(formatCuit("20123456786")).toBe("20-12345678-6");
  });

  it("devuelve tal cual si no son 11 dígitos", () => {
    expect(formatCuit("123")).toBe("123");
  });
});
