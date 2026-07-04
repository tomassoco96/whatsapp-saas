/**
 * recovery-config.ts — lógica pura de la secuencia de recuperación de
 * carritos. La config vive en la integración woocommerce del workspace:
 *
 * config.recovery = {
 *   enabled: boolean,                  // false por default: activación CONSCIENTE
 *   touches: [                         // secuencia de toques (plantillas Meta
 *     { template_name, delay_hours,    //   aprobadas: bypasean la ventana 24h)
 *       template_language? },          // default "es"; Meta suele registrar
 *     ...                              //   es_AR / es_MX — usar el exacto
 *   ],
 *   quiet_hours: { start: "21:00", end: "09:00" },  // opcional
 *   timezone: "America/Argentina/Buenos_Aires",     // para quiet hours
 *   expire_hours: 96                   // tras el último toque → expired
 * }
 */

export interface RecoveryTouch {
  templateName: string;
  delayHours: number;
  templateLanguage: string;
}

export interface RecoveryConfig {
  touches: RecoveryTouch[];
  quietStart: string | null; // "HH:MM"
  quietEnd: string | null;
  timezone: string;
  expireHours: number;
}

const DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires";
const DEFAULT_EXPIRE_HOURS = 96;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parsea config.recovery. Devuelve null si la recuperación no está habilitada
 * o no hay ningún toque válido (sin config no se contacta a nadie).
 */
export function parseRecoveryConfig(
  config: Record<string, unknown> | null,
): RecoveryConfig | null {
  const recovery = config?.recovery as Record<string, unknown> | undefined;
  if (!recovery || recovery.enabled !== true) return null;

  const rawTouches = Array.isArray(recovery.touches) ? recovery.touches : [];
  const touches: RecoveryTouch[] = [];
  for (const t of rawTouches) {
    if (typeof t !== "object" || t === null) continue;
    const tt = t as Record<string, unknown>;
    const name =
      typeof tt.template_name === "string" ? tt.template_name.trim() : "";
    const delay = Number(tt.delay_hours);
    const language =
      typeof tt.template_language === "string" && tt.template_language.trim()
        ? tt.template_language.trim()
        : "es";
    if (name && Number.isFinite(delay) && delay >= 0) {
      touches.push({
        templateName: name,
        delayHours: delay,
        templateLanguage: language,
      });
    }
  }
  if (touches.length === 0) return null;

  const quiet = recovery.quiet_hours as Record<string, unknown> | undefined;
  const quietStart =
    typeof quiet?.start === "string" && HHMM.test(quiet.start)
      ? quiet.start
      : null;
  const quietEnd =
    typeof quiet?.end === "string" && HHMM.test(quiet.end) ? quiet.end : null;

  const expire = Number(recovery.expire_hours);

  return {
    touches,
    quietStart,
    quietEnd,
    timezone:
      typeof recovery.timezone === "string" && recovery.timezone
        ? recovery.timezone
        : DEFAULT_TIMEZONE,
    expireHours:
      Number.isFinite(expire) && expire > 0 ? expire : DEFAULT_EXPIRE_HOURS,
  };
}

/** Minutos desde medianoche de `date` en la zona horaria dada. */
function minutesInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Intl puede devolver "24" para medianoche en algunos runtimes
  return ((hour % 24) * 60 + minute) % 1440;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * True si `date` cae dentro de las quiet hours del workspace (no se envían
 * toques). Soporta rangos que cruzan medianoche (ej. 21:00 → 09:00).
 * Sin quiet hours configuradas devuelve false.
 */
export function isWithinQuietHours(date: Date, cfg: RecoveryConfig): boolean {
  if (!cfg.quietStart || !cfg.quietEnd) return false;
  const now = minutesInTimezone(date, cfg.timezone);
  const start = hhmmToMinutes(cfg.quietStart);
  const end = hhmmToMinutes(cfg.quietEnd);
  if (start === end) return false; // rango vacío = sin quiet hours
  if (start < end) return now >= start && now < end;
  // Cruza medianoche: 21:00 → 09:00
  return now >= start || now < end;
}

export interface CartTouchState {
  touchesSent: number;
  abandonedAt: string; // ISO
  lastTouchAt: string | null; // ISO
}

/**
 * Devuelve el índice del toque que corresponde enviar AHORA, o null si
 * todavía no es momento o la secuencia está agotada.
 * El primer toque cuenta desde abandoned_at; los siguientes desde last_touch_at.
 */
export function nextTouchDue(
  cart: CartTouchState,
  cfg: RecoveryConfig,
  now: Date,
): number | null {
  const idx = cart.touchesSent;
  if (idx >= cfg.touches.length) return null;

  const baseIso = idx === 0 ? cart.abandonedAt : (cart.lastTouchAt ?? cart.abandonedAt);
  const baseMs = Date.parse(baseIso);
  if (Number.isNaN(baseMs)) return null;

  const dueMs = baseMs + cfg.touches[idx].delayHours * 3_600_000;
  return now.getTime() >= dueMs ? idx : null;
}

/**
 * True si el carrito agotó la secuencia y ya pasó la ventana de expiración
 * desde el último toque → corresponde marcarlo expired.
 */
export function isExpired(
  cart: CartTouchState,
  cfg: RecoveryConfig,
  now: Date,
): boolean {
  if (cart.touchesSent < cfg.touches.length) return false;
  const lastMs = Date.parse(cart.lastTouchAt ?? cart.abandonedAt);
  if (Number.isNaN(lastMs)) return false;
  return now.getTime() >= lastMs + cfg.expireHours * 3_600_000;
}
