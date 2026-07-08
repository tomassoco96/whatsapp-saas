import { isValidCuit } from "./cuit";

// Campos obligatorios del formulario mayorista. El servicio es la autoridad de
// que falta, no el LLM. Portado del motor v1.

export const CAMPOS_OBLIGATORIOS = [
  "nombreContacto",
  "razonSocial",
  "cuit",
  "provincia",
  "localidad",
  "email",
  "telefono",
  "rubro",
  "formatoVenta",
] as const;

export type CampoObligatorio = (typeof CAMPOS_OBLIGATORIOS)[number];

/** Etiquetas en espanol para repreguntar de forma natural. */
export const CAMPO_LABEL: Record<CampoObligatorio, string> = {
  nombreContacto: "nombre y apellido",
  razonSocial: "razón social",
  cuit: "CUIT",
  provincia: "provincia",
  localidad: "localidad",
  email: "correo electrónico",
  telefono: "teléfono",
  rubro: "rubro del comercio",
  formatoVenta: "si distribuís o vendés al público",
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
 * Devuelve los campos obligatorios que faltan. El CUIT cuenta como faltante si
 * esta vacio O si su digito verificador es invalido (gate fiscal del mayorista).
 */
export function computeMissing(lead: LeadFields): CampoObligatorio[] {
  const missing: CampoObligatorio[] = [];
  for (const campo of CAMPOS_OBLIGATORIOS) {
    const value = lead[campo];
    if (isEmpty(value)) {
      missing.push(campo);
    } else if (campo === "cuit" && !isValidCuit(value as string)) {
      missing.push("cuit");
    }
  }
  return missing;
}

/** Traduce los campos faltantes a etiquetas legibles para el agente. */
export function missingLabels(missing: CampoObligatorio[]): string[] {
  return missing.map((c) => CAMPO_LABEL[c]);
}
