// Mapea el "Formato de venta" del formulario mayorista a la lista de precios.
//   Distribucion (revende a comercios) -> lista `distribuidor`
//   Venta al publico                   -> lista `mayorista`
// Devuelve null si no se puede determinar (el agente repregunta; nunca adivina).
// Portado del motor v1.

export type ListaPrecio = "distribuidor" | "mayorista";

export function resolveListaPrecio(
  formatoVenta: string | null | undefined,
): ListaPrecio | null {
  if (!formatoVenta) return null;
  const v = formatoVenta.toLowerCase();
  if (/(distrib|reventa|revende|a comercios|mayoreo)/.test(v)) {
    return "distribuidor";
  }
  if (/(p[uú]blico|minorista|consumidor|al p[uú]blico|venta al p)/.test(v)) {
    return "mayorista";
  }
  return null;
}
