// Normalizacion de zonas para el ruteo de vendedores. Portado del motor v1 y
// extendido: los alias de conurbano/AMBA resuelven a la provincia que cubre el
// vendedor (las zonas se guardan como token normalizado en vendedor_zonas).

/** Alias frecuentes -> token canonico de zona. */
const ALIAS: Record<string, string> = {
  capital: "caba",
  "capital federal": "caba",
  caba: "caba",
  ciudad: "caba",
  "ciudad autonoma": "caba",
  "ciudad autonoma de buenos aires": "caba",
  "ciudad de buenos aires": "caba",
  conurbano: "buenos aires",
  gba: "buenos aires",
  "gran buenos aires": "buenos aires",
  "zona oeste": "buenos aires",
  "zona norte": "buenos aires",
  "zona sur": "buenos aires",
  amba: "buenos aires",
  "provincia de buenos aires": "buenos aires",
  "bs as": "buenos aires",
  bsas: "buenos aires",
  "sgo del estero": "santiago del estero",
};

export function canonicalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca acentos (combining marks)
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeZona(value: string | null | undefined): string | null {
  if (!value || value.trim() === "") return null;
  const c = canonicalize(value);
  return ALIAS[c] ?? c;
}
