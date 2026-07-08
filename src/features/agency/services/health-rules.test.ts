import { describe, expect, it } from "vitest";
import {
  countInbound,
  countRateLimited,
  countStuckBatches,
  computeLlmSpend,
  evaluateBufferStuck,
  evaluateLlmSpend,
  evaluateRateLimited,
  evaluateSilence,
  evaluateToolErrors,
  planAlertChanges,
  type AlertCandidate,
  type OpenAlertRow,
} from "./health-rules";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const TODAY_START = Date.parse("2026-07-05T00:00:00.000Z");

function minsAgo(mins: number): string {
  return new Date(NOW - mins * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------
// countStuckBatches / evaluateBufferStuck
// ---------------------------------------------------------------------------

describe("countStuckBatches", () => {
  it("cuenta solo batches con flush_at vencido hace más de 10 minutos", () => {
    const stats = countStuckBatches(
      [
        { flush_at: minsAgo(25) }, // trabado
        { flush_at: minsAgo(11) }, // trabado
        { flush_at: minsAgo(5) }, // reciente, todavía normal
        { flush_at: minsAgo(-3) }, // flush futuro (buffering vigente)
      ],
      NOW,
    );
    expect(stats.stuckCount).toBe(2);
    expect(stats.oldestMinutes).toBe(25);
  });

  it("sin flush_at usa created_at; sin fechas o inválidas no rompe", () => {
    const stats = countStuckBatches(
      [
        { flush_at: null, created_at: minsAgo(30) }, // trabado por created_at
        { flush_at: null, created_at: null },
        { flush_at: "no-es-fecha" },
      ],
      NOW,
    );
    expect(stats.stuckCount).toBe(1);
    expect(stats.oldestMinutes).toBe(30);
  });

  it("sin filas: cero trabados y oldestMinutes null", () => {
    expect(countStuckBatches([], NOW)).toEqual({
      stuckCount: 0,
      oldestMinutes: null,
    });
  });
});

describe("evaluateBufferStuck", () => {
  it("no dispara sin batches trabados", () => {
    expect(evaluateBufferStuck({ stuckCount: 0, oldestMinutes: null })).toBeNull();
  });

  it("dispara critical con detalle en payload", () => {
    const alert = evaluateBufferStuck({ stuckCount: 3, oldestMinutes: 42 })!;
    expect(alert.type).toBe("buffer_trabado");
    expect(alert.severity).toBe("critical");
    expect(alert.payload).toEqual({ stuck_count: 3, oldest_minutes: 42 });
    expect(alert.message).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// countInbound / evaluateSilence
// ---------------------------------------------------------------------------

describe("countInbound", () => {
  it("separa ventanas de 7 días y 24 horas", () => {
    const stats = countInbound(
      [
        { created_at: minsAgo(60) }, // 24h y 7d
        { created_at: daysAgo(2) }, // solo 7d
        { created_at: daysAgo(8) }, // fuera de ambas
        { created_at: null },
      ],
      NOW,
    );
    expect(stats).toEqual({ last7d: 2, last24h: 1 });
  });
});

describe("evaluateSilence", () => {
  it("sin historial de 7 días no dispara (workspace nuevo o inactivo)", () => {
    expect(evaluateSilence({ last7d: 0, last24h: 0 })).toBeNull();
  });

  it("con mensajes en las últimas 24h no dispara", () => {
    expect(evaluateSilence({ last7d: 10, last24h: 2 })).toBeNull();
  });

  it("hubo mensajes en 7 días pero cero en 24h → warning", () => {
    const alert = evaluateSilence({ last7d: 15, last24h: 0 })!;
    expect(alert.type).toBe("silencio_anomalo");
    expect(alert.severity).toBe("warning");
    expect(alert.payload).toEqual({ inbound_7d: 15, inbound_24h: 0 });
  });
});

// ---------------------------------------------------------------------------
// computeLlmSpend / evaluateLlmSpend
// ---------------------------------------------------------------------------

describe("computeLlmSpend", () => {
  it("separa gasto de hoy del promedio de los 7 días previos", () => {
    const stats = computeLlmSpend(
      [
        // hoy: 1.5M tokens = USD 3
        { created_at: new Date(TODAY_START + 3_600_000).toISOString(), payload: { total_tokens: 1_500_000 } },
        // previos: 3.5M tokens = USD 7 → promedio diario USD 1
        { created_at: daysAgo(2), payload: { total_tokens: 3_500_000 } },
        // fuera de la ventana de 7 días previos
        { created_at: daysAgo(9), payload: { total_tokens: 9_999_999 } },
        // payload nulo no rompe
        { created_at: daysAgo(1), payload: null },
      ],
      TODAY_START,
    );
    expect(stats.todayUsd).toBeCloseTo(3, 6);
    expect(stats.prevDailyAvgUsd).toBeCloseTo(1, 6);
  });

  it("sin eventos: todo en cero (sin división por cero)", () => {
    expect(computeLlmSpend([], TODAY_START)).toEqual({
      todayUsd: 0,
      prevDailyAvgUsd: 0,
    });
  });
});

describe("evaluateLlmSpend", () => {
  it("debajo del piso absoluto (USD 2) no dispara aunque el ratio sea alto", () => {
    expect(
      evaluateLlmSpend({ todayUsd: 1.5, prevDailyAvgUsd: 0.1 }),
    ).toBeNull();
  });

  it("ratio menor o igual a 3x no dispara", () => {
    expect(evaluateLlmSpend({ todayUsd: 6, prevDailyAvgUsd: 2 })).toBeNull();
  });

  it("mayor a 3x y sobre el piso → warning", () => {
    const alert = evaluateLlmSpend({ todayUsd: 4, prevDailyAvgUsd: 1 })!;
    expect(alert.type).toBe("gasto_llm_anomalo");
    expect(alert.severity).toBe("warning");
    expect(alert.payload).toMatchObject({
      today_usd: 4,
      prev_daily_avg_usd: 1,
      ratio: 4,
    });
  });

  it("mayor a 6x → critical", () => {
    const alert = evaluateLlmSpend({ todayUsd: 7, prevDailyAvgUsd: 1 })!;
    expect(alert.severity).toBe("critical");
  });

  it("sin historial (promedio 0) y gasto sobre el piso → critical con ratio null", () => {
    const alert = evaluateLlmSpend({ todayUsd: 2.5, prevDailyAvgUsd: 0 })!;
    expect(alert.severity).toBe("critical");
    expect(alert.payload.ratio).toBeNull();
  });

  it("sin historial y gasto bajo el piso no dispara", () => {
    expect(evaluateLlmSpend({ todayUsd: 0.5, prevDailyAvgUsd: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateToolErrors
// ---------------------------------------------------------------------------

describe("evaluateToolErrors", () => {
  it("menos de 3 errores en la hora no dispara", () => {
    expect(evaluateToolErrors(0)).toBeNull();
    expect(evaluateToolErrors(2)).toBeNull();
  });

  it("3 o más errores → warning", () => {
    const alert = evaluateToolErrors(3)!;
    expect(alert.type).toBe("errores_tools");
    expect(alert.severity).toBe("warning");
    expect(alert.payload).toEqual({ errors_last_hour: 3 });
  });
});

// ---------------------------------------------------------------------------
// planAlertChanges (dedupe + auto-resolución)
// ---------------------------------------------------------------------------

const CANDIDATE: AlertCandidate = {
  type: "buffer_trabado",
  severity: "critical",
  message: "2 mensajes trabados",
  payload: { stuck_count: 2 },
};

function openAlert(over: Partial<OpenAlertRow> = {}): OpenAlertRow {
  return {
    id: "alert-1",
    workspace_id: "ws-a",
    type: "buffer_trabado",
    severity: "critical",
    message: "1 mensaje trabado",
    ...over,
  };
}

describe("planAlertChanges", () => {
  it("candidato sin alerta abierta del mismo type → insertar", () => {
    const plan = planAlertChanges([CANDIDATE], []);
    expect(plan.toInsert).toEqual([CANDIDATE]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toResolve).toEqual([]);
  });

  it("dedupe: alerta abierta del mismo type → actualizar, no duplicar", () => {
    const plan = planAlertChanges([CANDIDATE], [openAlert()]);
    expect(plan.toInsert).toEqual([]);
    expect(plan.toUpdate).toEqual([
      {
        id: "alert-1",
        severity: "critical",
        message: CANDIDATE.message,
        payload: CANDIDATE.payload,
      },
    ]);
    expect(plan.toResolve).toEqual([]);
  });

  it("el refresco puede escalar la severidad (warning → critical)", () => {
    const plan = planAlertChanges(
      [{ ...CANDIDATE, type: "gasto_llm_anomalo", severity: "critical" }],
      [openAlert({ id: "alert-2", type: "gasto_llm_anomalo", severity: "warning" })],
    );
    expect(plan.toUpdate[0]).toMatchObject({ id: "alert-2", severity: "critical" });
  });

  it("auto-resolución: alerta abierta cuyo type ya no dispara → resolver", () => {
    const plan = planAlertChanges(
      [],
      [openAlert(), openAlert({ id: "alert-3", type: "silencio_anomalo" })],
    );
    expect(plan.toInsert).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toResolve).toEqual(["alert-1", "alert-3"]);
  });

  it("mezcla: inserta lo nuevo, refresca lo vigente y resuelve lo que dejó de disparar", () => {
    const nuevo: AlertCandidate = {
      type: "errores_tools",
      severity: "warning",
      message: "4 errores",
      payload: { errors_last_hour: 4 },
    };
    const plan = planAlertChanges(
      [CANDIDATE, nuevo],
      [openAlert(), openAlert({ id: "alert-4", type: "silencio_anomalo" })],
    );
    expect(plan.toInsert).toEqual([nuevo]);
    expect(plan.toUpdate.map((u) => u.id)).toEqual(["alert-1"]);
    expect(plan.toResolve).toEqual(["alert-4"]);
  });
});

describe("countRateLimited / evaluateRateLimited", () => {
  const rows = (reasons: (string | null)[]) =>
    reasons.map((reason) => ({ payload: reason ? { reason } : null }));

  it("cuenta los bloqueos por motivo", () => {
    expect(
      countRateLimited(
        rows([
          "rate_limit_contact_hour",
          "daily_token_budget_exceeded",
          "rate_limit_contact_hour",
          null,
        ]),
      ),
    ).toEqual({ contactHour: 2, dailyBudget: 1 });
  });

  it("sin bloqueos no dispara alerta", () => {
    expect(evaluateRateLimited({ contactHour: 0, dailyBudget: 0 })).toBeNull();
  });

  it("el presupuesto diario agotado es critical: el workspace queda mudo", () => {
    const alert = evaluateRateLimited({ contactHour: 0, dailyBudget: 3 });
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe("bot_limitado");
    expect(alert!.severity).toBe("critical");
    expect(alert!.message).toContain("presupuesto diario");
  });

  it("el techo por contacto es solo warning: afecta a una persona", () => {
    const alert = evaluateRateLimited({ contactHour: 5, dailyBudget: 0 });
    expect(alert!.severity).toBe("warning");
    expect(alert!.payload.contact_hour_blocks).toBe(5);
  });

  it("si hay de los dos, gana el presupuesto diario (critical)", () => {
    const alert = evaluateRateLimited({ contactHour: 9, dailyBudget: 1 });
    expect(alert!.severity).toBe("critical");
    expect(alert!.payload.contact_hour_blocks).toBe(9);
  });
});
