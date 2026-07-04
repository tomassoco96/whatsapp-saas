import { describe, it, expect } from "vitest";
import {
  aggregateCartMetrics,
  type CartMetricRow,
} from "./recovery-metrics";

function row(
  status: string,
  total: number | string | null = 1000,
  touches = 0,
): CartMetricRow {
  return { status, total, touches_sent: touches };
}

describe("aggregateCartMetrics", () => {
  it("agrega contadores, montos y toques por estado", () => {
    const m = aggregateCartMetrics([
      row("pending", 1000),
      row("contacted", 2000, 1),
      row("contacted", 500, 2),
      row("recovered", 3000, 1),
      row("recovered", 1500, 3),
      row("expired", 800, 3),
      row("opted_out", 400, 1),
      row("not_contactable", 900),
    ]);

    expect(m.totalCarts).toBe(8);
    expect(m.pending).toBe(1);
    expect(m.contacted).toBe(2);
    expect(m.recovered).toBe(2);
    expect(m.expired).toBe(1);
    expect(m.optedOut).toBe(1);
    expect(m.notContactable).toBe(1);
    // $ recuperado = solo recovered; $ en juego = pending + contacted
    expect(m.recoveredValue).toBe(4500);
    expect(m.inPlayValue).toBe(3500);
    expect(m.touchesSent).toBe(11);
    // tasa: 2 recuperados de 3 cerrados (2 recovered + 1 expired)
    expect(m.recoveryRate).toBeCloseTo(2 / 3);
  });

  it("sin carritos cerrados la tasa es null (no 0% engañoso)", () => {
    const m = aggregateCartMetrics([row("pending"), row("contacted")]);
    expect(m.recoveryRate).toBeNull();
  });

  it("tolera totales string (numeric de Postgres) y null", () => {
    const m = aggregateCartMetrics([
      row("recovered", "2500.50"),
      row("pending", null),
      row("contacted", "no-numerico"),
    ]);
    expect(m.recoveredValue).toBeCloseTo(2500.5);
    expect(m.inPlayValue).toBe(0);
  });

  it("lista vacía devuelve métricas en cero", () => {
    const m = aggregateCartMetrics([]);
    expect(m.totalCarts).toBe(0);
    expect(m.recoveredValue).toBe(0);
    expect(m.recoveryRate).toBeNull();
  });
});
