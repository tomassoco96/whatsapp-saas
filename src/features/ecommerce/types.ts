/**
 * Tipos de la feature ecommerce (WooCommerce), portados del motor v1.
 */

/** Variante de tamaño de un producto (WC variable product). */
export interface WooSize {
  /** Etiqueta legible, ej "4 cm" o "M". */
  label: string;
  /** Precio de esa variante en string, ej "1430". */
  price: string;
}

/** Producto del catálogo de WooCommerce, normalizado para el agente. */
export interface WooProduct {
  id: number;
  name: string;
  /** Precio base (el más bajo si es variable). Precio de venta al público. */
  price: string;
  /**
   * true si `price` es el mínimo de un producto variable → se comunica como
   * "desde $X" (no como precio único).
   */
  priceFrom?: boolean;
  inStock: boolean;
  permalink: string;
  shortDescription: string;
  categories: string[];
  /** Marca del producto (atributo "Marca"), si está cargada. */
  brand?: string;
  /**
   * Variantes de tamaño con su precio (productos variables). Ausente si el
   * producto es simple / sin variantes.
   */
  sizes?: WooSize[];
}

/** Categoría del catálogo, normalizada para el agente. */
export interface WooCategory {
  id: number;
  name: string;
  slug: string;
  /** Cantidad de productos publicados en la categoría. */
  count: number;
}

/** Resultado de una búsqueda de productos, listo para el agente. */
export interface ProductSearchResult {
  found: boolean;
  count: number;
  products: WooProduct[];
  /** Categoría que matcheó la búsqueda, con su link directo. */
  category?: { name: string; slug: string; url: string };
  /** Mensaje sugerido para el agente. */
  message: string;
}

/** Orden normalizada que devuelve el cliente WooCommerce. */
export interface WooOrder {
  id: number;
  status: string; // slug crudo de WooCommerce (ej. 'processing', 'en-produccion')
  total: string;
  currency: string;
  dateCreated: string;
  paymentMethodTitle?: string;
  items: Array<{ name: string; qty: number }>;
  /**
   * Datos de facturación — SOLO para verificar la propiedad del pedido antes de
   * revelar su estado. NUNCA se muestran al cliente ni se pasan al LLM.
   */
  billingPhone?: string;
  billingEmail?: string;
}

/** Estado normalizado a lenguaje del cliente. */
export interface NormalizedStatus {
  label: string;
  customerMsg: string;
  known: boolean; // false si el slug no estaba mapeado
}

/** Respuesta del lookup de pedidos (consumida por el agente). */
export interface OrderLookupResult {
  found: boolean;
  order?: {
    id: number;
    statusRaw: string;
    statusLabel: string;
    statusCustomerMsg: string;
    total: number;
    currency: string;
    createdAt: string;
    items: Array<{ name: string; qty: number }>;
    paymentMethod?: string;
  };
  message: string;
}

/** Mensaje custom de estado, configurable por workspace. */
export interface StatusMessage {
  label: string;
  customerMsg: string;
}
