import { describe, it, expect } from "vitest";
import { normalizeStatus, isPaidStatus } from "./status-map";

describe("normalizeStatus", () => {
  it("mapea estados estándar de WooCommerce", () => {
    const r = normalizeStatus("processing");
    expect(r.known).toBe(true);
    expect(r.label).toBe("Procesando");
    expect(r.customerMsg).toContain("pago ya está confirmado");
  });

  it("acepta el prefijo wc- y mayúsculas", () => {
    expect(normalizeStatus("wc-completed").label).toBe("Completado");
    expect(normalizeStatus("  PENDING ").label).toBe("Pendiente de pago");
  });

  it("mapea los slugs custom del flujo de fábrica y comprobantes", () => {
    expect(normalizeStatus("en-produccion").label).toBe("En producción");
    expect(normalizeStatus("receipt-approval").label).toBe(
      "Revisando comprobante",
    );
  });

  it("estado desconocido: fallback seguro que ofrece derivar", () => {
    const r = normalizeStatus("estado-rarisimo");
    expect(r.known).toBe(false);
    expect(r.label).toBe("estado-rarisimo");
    expect(r.customerMsg).toContain("te derivo");
  });

  it("los overrides del workspace pisan el default y agregan slugs nuevos", () => {
    const overrides = {
      processing: { label: "En cocina", customerMsg: "lo estamos preparando" },
      "listo-retirar": { label: "Listo", customerMsg: "pasá a retirarlo" },
    };
    expect(normalizeStatus("processing", overrides).label).toBe("En cocina");
    expect(normalizeStatus("listo-retirar", overrides)).toEqual({
      label: "Listo",
      customerMsg: "pasá a retirarlo",
      known: true,
    });
    // los no pisados siguen saliendo del default
    expect(normalizeStatus("completed", overrides).label).toBe("Completado");
  });
});

describe("isPaidStatus", () => {
  it("true para estados post-pago", () => {
    for (const s of [
      "processing",
      "wc-completed",
      "en-produccion",
      "exportado",
      "demorado",
    ]) {
      expect(isPaidStatus(s)).toBe(true);
    }
  });

  it("false para pre-pago y ambiguos", () => {
    for (const s of [
      "pending",
      "on-hold",
      "receipt-approval",
      "cancelled",
      "failed",
    ]) {
      expect(isPaidStatus(s)).toBe(false);
    }
  });
});
