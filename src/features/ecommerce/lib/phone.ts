/**
 * Normalización de teléfonos argentinos a E.164 (+549...) y variantes de
 * búsqueda para WooCommerce. Portado del motor v1.
 *
 * Reglas AR:
 *  - Código de país: 54
 *  - Móviles: prefijo 9 después del país (+549) — requerido por WhatsApp
 *  - El "15" local y el "0" de área se descartan
 *
 * Ejemplos:
 *  "11 6286 6801"        -> "+5491162866801"
 *  "011 15 6286-6801"    -> "+5491162866801"
 *  "+54 9 11 6286 6801"  -> "+5491162866801"
 *  "5491162866801"       -> "+5491162866801"
 */
export function normalizeArgentinePhone(
  input: string | null | undefined,
): string | null {
  if (!input) return null;

  // Solo dígitos (descarta +, espacios, guiones, paréntesis)
  let digits = input.replace(/\D/g, "");
  if (digits.length < 8) return null;

  // Quitar código de país si ya viene
  if (digits.startsWith("54")) digits = digits.slice(2);

  // Quitar el 9 de móvil si viene pegado al país (lo re-agregamos al final)
  if (digits.startsWith("9")) digits = digits.slice(1);

  // Quitar 0 inicial de área (ej. 011 -> 11)
  if (digits.startsWith("0")) digits = digits.slice(1);

  // Quitar "15" local: aparece entre el código de área y el número.
  // Caso típico CABA: 11 15 6286 6801 (12 dígitos) -> 11 6286 6801 (10).
  if (digits.length > 10) {
    for (const areaLen of [2, 3, 4]) {
      if (
        digits.length - 2 === 10 &&
        digits.slice(areaLen, areaLen + 2) === "15"
      ) {
        digits = digits.slice(0, areaLen) + digits.slice(areaLen + 2);
        break;
      }
    }
  }

  // Un número nacional AR válido (sin país ni 9) tiene 10 dígitos
  if (digits.length !== 10) return null;

  return `+549${digits}`;
}

/**
 * Variantes de búsqueda para el `search` de WooCommerce, en orden de probabilidad.
 *
 * WooCommerce guarda el teléfono tal cual lo tipeó el cliente en el checkout —
 * en Argentina lo más común es el nacional de 10 dígitos, sin país ni el 9 de
 * móvil. El `search` de WC matchea por substring exacto, así que buscar el
 * E.164 NO matchea ese formato local.
 *
 * Devuelve candidatos best-first: nacional 10 dígitos → E.164 → 549… sin "+".
 * El caller prueba cada uno hasta encontrar el pedido.
 */
export function argentinePhoneSearchVariants(
  input: string | null | undefined,
): string[] {
  const e164 = normalizeArgentinePhone(input);
  const variants: string[] = [];
  if (e164) {
    const national = e164.slice(4); // saca "+549" → 10 dígitos nacionales
    variants.push(national, e164, e164.slice(1)); // 549… sin "+"
  }
  // Fallback: los dígitos crudos del input (por si no se pudo normalizar)
  const rawDigits = (input ?? "").replace(/\D/g, "");
  if (rawDigits.length >= 8) variants.push(rawDigits);
  // Dedup preservando orden
  return [...new Set(variants)];
}
