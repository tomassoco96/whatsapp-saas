import { isValidCuit } from "./cuit";
import { resolveListaPrecio } from "./lista-precio";

// Campos obligatorios del formulario mayorista. El servicio es la autoridad de
// que falta, no el LLM. Portado del motor v1.
//
// telefono y email NO son obligatorios: ya tenemos el WhatsApp del contacto
// (contacto_phone) para que el vendedor lo ubique, y el cliente pidió no sumar
// pasos (feedback 17/7, item 11). Si el cliente los da, se guardan igual.

export const CAMPOS_OBLIGATORIOS = [
  "nombreContacto",
  "razonSocial",
  "cuit",
  "provincia",
  "localidad",
  "rubro",
  "formatoVenta",
] as const;

export type CampoObligatorio = (typeof CAMPOS_OBLIGATORIOS)[number];

// Los datos se piden en DOS bloques (feedback 17/7): primero identificación,
// después el negocio. El bot pide un bloque por mensaje, nunca de a uno ni los
// siete de golpe.
export const BLOQUE_1: readonly CampoObligatorio[] = [
  "nombreContacto",
  "razonSocial",
  "cuit",
];
export const BLOQUE_2: readonly CampoObligatorio[] = [
  "provincia",
  "localidad",
  "rubro",
  "formatoVenta",
];

/** Etiquetas en espanol para repreguntar de forma natural. */
export const CAMPO_LABEL: Record<CampoObligatorio, string> = {
  nombreContacto: "nombre y apellido",
  razonSocial: "razón social",
  cuit: "CUIT",
  provincia: "provincia",
  localidad: "localidad",
  rubro: "rubro del comercio",
  formatoVenta: "si distribuís a comercios o vendés al público",
};

/** Vista parcial de un lead (los campos que importan para calcular faltantes). */
export type LeadFields = Partial<
  Record<CampoObligatorio, string | null | undefined>
>;

function isEmpty(v: unknown): boolean {
  return (
    v === null || v === undefined || (typeof v === "string" && v.trim() === "")
  );
}

/**
 * Devuelve los campos obligatorios que faltan. Reglas especiales:
 * - CUIT: cuenta como faltante si está vacío O si su dígito verificador es
 *   inválido (gate fiscal del mayorista).
 * - formatoVenta: cuenta como faltante si está vacío O si no se puede mapear a
 *   una lista de precios (ej. el cliente puso el rubro ahí). Así el bot
 *   repregunta específicamente "distribuís o vendés al público" en vez de dar
 *   el lead por completo con la lista sin resolver.
 */
export function computeMissing(lead: LeadFields): CampoObligatorio[] {
  const missing: CampoObligatorio[] = [];
  for (const campo of CAMPOS_OBLIGATORIOS) {
    const value = lead[campo];
    if (isEmpty(value)) {
      missing.push(campo);
    } else if (campo === "cuit" && !isValidCuit(value as string)) {
      missing.push("cuit");
    } else if (campo === "formatoVenta" && resolveListaPrecio(value) === null) {
      missing.push("formatoVenta");
    }
  }
  return missing;
}

/**
 * De los campos faltantes, devuelve solo los del PRIMER bloque incompleto:
 * el bot pide identificación (bloque 1) y, cuando está, el negocio (bloque 2).
 * Máximo dos mensajes de repregunta.
 */
export function nextBlockMissing(lead: LeadFields): CampoObligatorio[] {
  const missing = new Set(computeMissing(lead));
  const bloque1 = BLOQUE_1.filter((c) => missing.has(c));
  if (bloque1.length > 0) return bloque1;
  return BLOQUE_2.filter((c) => missing.has(c));
}

/** Traduce los campos faltantes a etiquetas legibles para el agente. */
export function missingLabels(missing: CampoObligatorio[]): string[] {
  return missing.map((c) => CAMPO_LABEL[c]);
}
