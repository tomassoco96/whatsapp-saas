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
