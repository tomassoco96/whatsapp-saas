/**
 * Sanitización de texto que viene de WooCommerce (dato externo, SEC-3 del motor v1).
 *
 * Los nombres de producto son controlables por quien carga el catálogo y terminan
 * incrustados en el contexto del LLM. Para mitigar prompt-injection:
 *  - se colapsan saltos de línea / tabs (rompen el delimitado de datos),
 *  - se quitan caracteres de markup/template (`< > { }`),
 *  - se truncan a una longitud razonable.
 * El contenido se trata SIEMPRE como dato, nunca como instrucción.
 */
export function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const MAX_NAME_LENGTH = 120;
const MAX_SKU_LENGTH = 64;

/** Ítem de carrito ya sanitizado, listo para persistir como JSONB. */
export interface CartItem {
  name: string;
  qty: number;
  price: number;
  sku?: string;
  url?: string;
}

/**
 * Normaliza los ítems del webhook de carritos a `CartItem[]` sanitizados.
 * Los nombres de producto terminan incrustados en mensajes que procesa el
 * LLM — se tratan SIEMPRE como dato, nunca como instrucción.
 */
export function sanitizeCartItems(
  items: Array<{
    name: string;
    qty: number;
    price: number;
    sku?: string;
    url?: string;
  }>,
): CartItem[] {
  return items.map((item) => {
    const clean: CartItem = {
      name: sanitizeText(item.name, MAX_NAME_LENGTH),
      qty: item.qty,
      price: item.price,
    };
    if (item.sku) clean.sku = sanitizeText(item.sku, MAX_SKU_LENGTH);
    if (item.url) clean.url = item.url;
    return clean;
  });
}
