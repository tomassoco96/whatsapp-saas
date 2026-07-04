import { describe, it, expect } from "vitest";
import {
  parseRecoveryConfig,
  isWithinQuietHours,
  nextTouchDue,
  isExpired,
  type RecoveryConfig,
} from "./recovery-config";

const BASE_CONFIG = {
  recovery: {
    enabled: true,
    touches: [
      { template_name: "carrito_1", delay_hours: 1 },
      { template_name: "carrito_2", delay_hours: 24 },
    ],
  },
};

function cfg(over: Partial<RecoveryConfig> = {}): RecoveryConfig {
  return {
    touches: [
      { templateName: "carrito_1", delayHours: 1, templateLanguage: "es" },
      { templateName: "carrito_2", delayHours: 24, templateLanguage: "es" },
    ],
    quietStart: null,
    quietEnd: null,
    timezone: "America/Argentina/Buenos_Aires",
    expireHours: 96,
    ...over,
  };
}

describe("parseRecoveryConfig", () => {
  it("parsea una config completa", () => {
    const r = parseRecoveryConfig({
      recovery: {
        ...BASE_CONFIG.recovery,
        quiet_hours: { start: "21:00", end: "09:00" },
        timezone: "America/Mexico_City",
        expire_hours: 48,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.touches).toHaveLength(2);
    expect(r!.touches[0]).toEqual({
      templateName: "carrito_1",
      delayHours: 1,
      templateLanguage: "es",
    });
    expect(r!.quietStart).toBe("21:00");
    expect(r!.timezone).toBe("America/Mexico_City");
    expect(r!.expireHours).toBe(48);
  });

  it("null si recovery no está habilitado o no existe (default seguro)", () => {
    expect(parseRecoveryConfig(null)).toBeNull();
    expect(parseRecoveryConfig({})).toBeNull();
    expect(
      parseRecoveryConfig({ recovery: { ...BASE_CONFIG.recovery, enabled: false } }),
    ).toBeNull();
    // enabled tiene que ser exactamente true, no truthy
    expect(
      parseRecoveryConfig({ recovery: { ...BASE_CONFIG.recovery, enabled: "yes" } }),
    ).toBeNull();
  });

  it("null sin toques válidos; ignora toques malformados", () => {
    expect(
      parseRecoveryConfig({ recovery: { enabled: true, touches: [] } }),
    ).toBeNull();
    const r = parseRecoveryConfig({
      recovery: {
        enabled: true,
        touches: [
          { template_name: "", delay_hours: 1 }, // sin nombre
          { template_name: "ok", delay_hours: "x" }, // delay no numérico
          { template_name: "valido", delay_hours: 2 },
        ],
      },
    });
    expect(r!.touches).toEqual([
      { templateName: "valido", delayHours: 2, templateLanguage: "es" },
    ]);
  });

  it("respeta template_language por toque (es_AR/es_MX) con default es", () => {
    const r = parseRecoveryConfig({
      recovery: {
        enabled: true,
        touches: [
          { template_name: "t1", delay_hours: 1, template_language: "es_AR" },
          { template_name: "t2", delay_hours: 24 },
        ],
      },
    });
    expect(r!.touches[0].templateLanguage).toBe("es_AR");
    expect(r!.touches[1].templateLanguage).toBe("es");
  });

  it("quiet hours con formato inválido se descartan", () => {
    const r = parseRecoveryConfig({
      recovery: {
        ...BASE_CONFIG.recovery,
        quiet_hours: { start: "25:00", end: "9am" },
      },
    });
    expect(r!.quietStart).toBeNull();
    expect(r!.quietEnd).toBeNull();
  });
});

describe("isWithinQuietHours", () => {
  // 2026-07-03T23:30:00-03:00 (Buenos Aires) = 02:30 UTC del 4/7
  const nocheBsAs = new Date("2026-07-04T02:30:00Z");
  // 12:00 en Buenos Aires = 15:00 UTC
  const mediodiaBsAs = new Date("2026-07-03T15:00:00Z");

  it("detecta la noche dentro de un rango que cruza medianoche", () => {
    const c = cfg({ quietStart: "21:00", quietEnd: "09:00" });
    expect(isWithinQuietHours(nocheBsAs, c)).toBe(true);
    expect(isWithinQuietHours(mediodiaBsAs, c)).toBe(false);
  });

  it("rango simple dentro del mismo día", () => {
    const c = cfg({ quietStart: "14:00", quietEnd: "16:00" });
    expect(isWithinQuietHours(mediodiaBsAs, c)).toBe(false); // 12:00
    const siesta = new Date("2026-07-03T18:00:00Z"); // 15:00 BsAs
    expect(isWithinQuietHours(siesta, c)).toBe(true);
  });

  it("sin quiet hours configuradas nunca bloquea", () => {
    expect(isWithinQuietHours(nocheBsAs, cfg())).toBe(false);
  });

  it("respeta la timezone del workspace", () => {
    // 02:30 UTC = 23:30 en BsAs (quiet) pero 20:30 en Mexico City (no quiet)
    const c = cfg({
      quietStart: "21:00",
      quietEnd: "09:00",
      timezone: "America/Mexico_City",
    });
    expect(isWithinQuietHours(nocheBsAs, c)).toBe(false);
  });
});

describe("nextTouchDue", () => {
  const now = new Date("2026-07-03T12:00:00Z");

  it("primer toque: debido cuando pasó delay_hours desde abandoned_at", () => {
    const due = nextTouchDue(
      { touchesSent: 0, abandonedAt: "2026-07-03T10:00:00Z", lastTouchAt: null },
      cfg(),
      now,
    );
    expect(due).toBe(0);
  });

  it("primer toque: todavía no si no pasó el delay", () => {
    const due = nextTouchDue(
      { touchesSent: 0, abandonedAt: "2026-07-03T11:30:00Z", lastTouchAt: null },
      cfg(),
      now,
    );
    expect(due).toBeNull();
  });

  it("segundo toque cuenta desde last_touch_at", () => {
    const base = {
      touchesSent: 1,
      abandonedAt: "2026-07-01T10:00:00Z",
      lastTouchAt: "2026-07-02T11:00:00Z",
    };
    // 24h desde el último toque: debido a partir del 3/7 11:00
    expect(nextTouchDue(base, cfg(), now)).toBe(1);
    expect(
      nextTouchDue({ ...base, lastTouchAt: "2026-07-02T13:00:00Z" }, cfg(), now),
    ).toBeNull();
  });

  it("secuencia agotada devuelve null", () => {
    expect(
      nextTouchDue(
        {
          touchesSent: 2,
          abandonedAt: "2026-07-01T10:00:00Z",
          lastTouchAt: "2026-07-02T10:00:00Z",
        },
        cfg(),
        now,
      ),
    ).toBeNull();
  });
});

describe("isExpired", () => {
  const now = new Date("2026-07-07T12:00:00Z");

  it("expira tras expire_hours desde el último toque con la secuencia agotada", () => {
    expect(
      isExpired(
        {
          touchesSent: 2,
          abandonedAt: "2026-07-01T10:00:00Z",
          lastTouchAt: "2026-07-03T10:00:00Z", // +96h = 7/7 10:00 < now
        },
        cfg(),
        now,
      ),
    ).toBe(true);
  });

  it("no expira si la secuencia sigue abierta o falta ventana", () => {
    expect(
      isExpired(
        {
          touchesSent: 1,
          abandonedAt: "2026-07-01T10:00:00Z",
          lastTouchAt: "2026-07-03T10:00:00Z",
        },
        cfg(),
        now,
      ),
    ).toBe(false);
    expect(
      isExpired(
        {
          touchesSent: 2,
          abandonedAt: "2026-07-01T10:00:00Z",
          lastTouchAt: "2026-07-04T10:00:00Z", // +96h = 8/7 > now
        },
        cfg(),
        now,
      ),
    ).toBe(false);
  });
});
