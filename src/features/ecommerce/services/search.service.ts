import {
  searchProductsByTerm,
  getProductsBySlug,
  getCategoryBySlug,
  searchCategoriesByName,
  getProductsByCategoryId,
} from "./wc-client";
import type { WcWorkspaceConfig } from "./wc-config";
import { sanitizeText } from "../lib/sanitize";
import type { WooProduct, WooCategory, ProductSearchResult } from "../types";

const NAME_MAX = 120;
const DESC_MAX = 200;

export interface ProductSearchQuery {
  query?: string;
  categorySlug?: string;
  productSlug?: string;
  productUrl?: string;
  /** Marca pedida por el cliente (Brogas, Broksol...). Reordena marca-primero. */
  brand?: string;
  limit: number;
}

/**
 * Stopwords base del motor: conectores + ruido genérico ("talle"/"modelo").
 * El `search` de WooCommerce exige TODAS las palabras, así que en el fallback
 * por-palabra las salteamos para quedarnos con el sustantivo relevante.
 * Cada workspace agrega las suyas vía config (search_stopwords).
 */
const BASE_STOPWORDS = new Set([
  "de",
  "del",
  "la",
  "las",
  "el",
  "los",
  "un",
  "una",
  "unos",
  "unas",
  "para",
  "con",
  "que",
  "y",
  "o",
  "mi",
  "tu",
  "su",
  "algo",
  "alguno",
  "alguna",
  "algun",
  "tenes",
  "tenés",
  "tienen",
  "hay",
  "busco",
  "buscando",
  "quiero",
  "queria",
  "quería",
  "talle",
  "talles",
  "modelo",
  "modelos",
  "diseño",
  "diseños",
]);

/** Saca acentos/diacríticos (el `search` de WC suele ser sensible a tildes). */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Pasa una palabra a singular (heurística ES). El `search` de WC matchea el
 * nombre del producto, así que "perros" no encuentra "Patitas Perro" pero
 * "perro" sí.
 */
function singularize(w: string): string {
  const lw = w.toLowerCase();
  if (lw.length > 4 && lw.endsWith("es")) return w.slice(0, -2);
  if (lw.length > 3 && lw.endsWith("s")) return w.slice(0, -1);
  return w;
}

/**
 * Arma la lista de términos a intentar, en orden: frase completa → sin
 * acentos → cada palabra significativa (larga primero), y de cada palabra su
 * singular y su forma sin acentos. Exportada para test.
 */
export function buildSearchAttempts(
  query: string,
  extraStopwords: string[] = [],
): string[] {
  const stopwords = new Set([
    ...BASE_STOPWORDS,
    ...extraStopwords.map((w) => w.toLowerCase()),
  ]);
  const attempts: string[] = [];
  const add = (t: string) => {
    const v = t.trim();
    if (v.length >= 3 && !attempts.includes(v)) attempts.push(v);
  };

  add(query);
  add(stripAccents(query));

  const words = query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stopwords.has(w.toLowerCase()))
    .sort((a, b) => b.length - a.length);

  for (const w of words) {
    add(w);
    add(singularize(w));
    add(stripAccents(w));
    add(stripAccents(singularize(w)));
  }

  return attempts;
}

/** Normaliza una marca para comparar: minúsculas, sin acentos, sin espacios extra. */
function normalizeBrand(s?: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function brandMatches(productBrand: string | undefined, wanted: string): boolean {
  return normalizeBrand(productBrand) === normalizeBrand(wanted);
}

/**
 * Reordena poniendo primero los productos de la marca pedida, SIN descartar el
 * resto (para poder ofrecer una alternativa si la marca está sin stock). La
 * marca en la tienda de Brogas está cargada de forma inconsistente (atributo
 * global vs local), por eso se filtra sobre el `brand` ya extraído del producto
 * y no con el filtro server-side de WooCommerce, que se pierde los locales.
 */
function brandFirst(products: WooProduct[], brand: string): WooProduct[] {
  const wanted = products.filter((p) => brandMatches(p.brand, brand));
  const rest = products.filter((p) => !brandMatches(p.brand, brand));
  return [...wanted, ...rest];
}

/**
 * Saca los tokens de la marca del término de búsqueda. La marca NO está en el
 * nombre de los productos (vive en un atributo), así que si queda en el query,
 * la búsqueda de la frase completa falla y cae a una palabra suelta genérica
 * (ej. "cartucho") que no trae el producto buscado. El filtro por marca se
 * aplica aparte, sobre el `brand` de cada resultado.
 */
function stripBrandTokens(query: string, brand: string): string {
  const b = normalizeBrand(brand);
  return query
    .split(/\s+/)
    .filter((w) => normalizeBrand(w) !== b)
    .join(" ")
    .trim();
}

async function searchWithFallback(
  cfg: WcWorkspaceConfig,
  query: string,
  limit: number,
  brand?: string,
): Promise<WooProduct[]> {
  // Con marca pedida: (1) sacar la marca del término (no está en los nombres),
  // (2) traer más y reordenar marca-primero, así el producto de la marca
  // (aunque esté sin stock o ranquee bajo) siempre le llega al agente.
  const effectiveQuery = brand ? stripBrandTokens(query, brand) : query;
  if (brand && effectiveQuery === "") return []; // el query era solo la marca
  const fetchLimit = brand ? Math.max(limit, 15) : limit;
  for (const term of buildSearchAttempts(effectiveQuery, cfg.extraStopwords)) {
    const r = await searchProductsByTerm(cfg, term, fetchLimit);
    if (r.length > 0) {
      return (brand ? brandFirst(r, brand) : r).slice(0, limit);
    }
  }
  return [];
}

/**
 * Extrae el slug de un link de la tienda.
 * - `/producto/<slug>/`  → { productSlug }
 * - `/categoria/<slug>/` → { categorySlug }
 * - cualquier otro       → { } (el caller cae al término de búsqueda)
 */
export function extractSlugFromUrl(url: string): {
  productSlug?: string;
  categorySlug?: string;
} {
  try {
    const path = new URL(url).pathname;
    const prod = path.match(/\/producto\/([^/]+)/i);
    if (prod) return { productSlug: decodeURIComponent(prod[1]) };
    const cat = path.match(/\/categoria\/([^/]+)/i);
    if (cat) return { categorySlug: decodeURIComponent(cat[1]) };
    return {};
  } catch {
    return {};
  }
}

/** Sanitiza los campos de texto de los productos (vienen de WC = dato externo). */
function sanitizeProduct(p: WooProduct): WooProduct {
  return {
    ...p,
    name: sanitizeText(p.name, NAME_MAX),
    shortDescription: sanitizeText(p.shortDescription, DESC_MAX),
    categories: p.categories.map((c) => sanitizeText(c, NAME_MAX)),
    ...(p.brand ? { brand: sanitizeText(p.brand, NAME_MAX) } : {}),
  };
}

/** Formatea un precio en pesos con separador de miles (es-AR): "154599" → "$154.599". */
function pesos(price: string): string {
  const digits = String(price).replace(/\D/g, "");
  if (!digits) return "";
  return "$" + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function buildMessage(
  storeUrl: string,
  products: WooProduct[],
  truncated: boolean,
  category?: { name: string; url: string },
): string {
  if (products.length === 0) {
    return `No encontré ese producto en el catálogo. Podés ver todo en ${storeUrl}`;
  }
  const header = category
    ? `Sí, tenemos la categoría ${category.name}: ${category.url}\nAlgunos ejemplos:\n`
    : "";
  const lines = products.map((p) => {
    // Partes del renglón: precio (si lo hay) y "sin stock" (si aplica).
    let priceTxt = "";
    if (p.sizes && p.sizes.length > 0) {
      const distintos = new Set(p.sizes.map((s) => s.price));
      priceTxt =
        distintos.size === 1
          ? `${pesos(p.sizes[0].price)}, talles ${p.sizes.map((s) => s.label).join(", ")}`
          : p.sizes.map((s) => `${s.label} ${pesos(s.price)}`).join(" / ");
    } else if (p.price) {
      // "desde $X" para productos variables (price = variante más barata).
      priceTxt = p.priceFrom ? `desde ${pesos(p.price)}` : pesos(p.price);
    }
    const parts = [priceTxt, p.inStock ? "" : "sin stock"].filter(Boolean);
    const suffix = parts.length ? ` (${parts.join(", ")})` : "";
    return `${p.name}${suffix}: ${p.permalink}`;
  });
  const extra = category
    ? `\nHay más en la categoría completa: ${category.url}`
    : truncated
      ? `\nHay más opciones, mirá la categoría completa en la web.`
      : "";
  return header + lines.join("\n") + extra;
}

/**
 * Busca productos en WooCommerce por término, categoría, slug o link.
 * Prioridad: productSlug/productUrl(producto) → categoría → término.
 * Siempre resuelve sin tirar error: ante fallo de WC devuelve `found:false`.
 */
export async function searchProducts(
  cfg: WcWorkspaceConfig,
  q: ProductSearchQuery,
): Promise<ProductSearchResult> {
  const fromUrl = q.productUrl ? extractSlugFromUrl(q.productUrl) : {};
  const productSlug = q.productSlug ?? fromUrl.productSlug;
  const categorySlug = q.categorySlug ?? fromUrl.categorySlug;

  try {
    let products: WooProduct[];
    let matched: WooCategory | null = null;

    // Con marca pedida, en los paths de categoría se trae más para reordenar
    // marca-primero sin perder el producto de la marca.
    const catFetch = q.brand ? Math.max(q.limit, 15) : q.limit;

    if (productSlug) {
      products = await getProductsBySlug(cfg, productSlug);
    } else if (categorySlug) {
      matched = await getCategoryBySlug(cfg, categorySlug);
      products = matched
        ? await getProductsByCategoryId(cfg, matched.id, catFetch)
        : [];
      if (q.brand) products = brandFirst(products, q.brand).slice(0, q.limit);
    } else if (q.query) {
      products = await searchWithFallback(cfg, q.query, q.limit, q.brand);
      // El término puede ser una CATEGORÍA (ej "peliculas y series"), no un
      // producto. Si no matcheó ningún producto, lo resolvemos como categoría.
      if (products.length === 0) {
        const cats = await searchCategoriesByName(cfg, q.query);
        matched = cats.find((c) => c.count > 0) ?? null;
        if (matched) {
          products = await getProductsByCategoryId(cfg, matched.id, catFetch);
          if (q.brand) products = brandFirst(products, q.brand).slice(0, q.limit);
        }
      }
    } else {
      // Solo llegamos acá con un productUrl sin slug útil.
      products = await searchProductsByTerm(cfg, q.productUrl ?? "", q.limit);
    }

    const category = matched
      ? {
          name: sanitizeText(matched.name, NAME_MAX),
          slug: matched.slug,
          url: `${cfg.storeUrl}/categoria/${matched.slug}/`,
        }
      : undefined;

    const truncated = products.length >= q.limit;
    const limited = products.slice(0, q.limit).map(sanitizeProduct);
    return {
      found: limited.length > 0,
      count: limited.length,
      products: limited,
      ...(category ? { category } : {}),
      message: buildMessage(cfg.storeUrl, limited, truncated, category),
    };
  } catch (e) {
    console.error(
      "[ecommerce] product search: error de WooCommerce:",
      (e as Error).message,
    );
    return {
      found: false,
      count: 0,
      products: [],
      message: `No pude consultar el catálogo en este momento. Podés ver los productos en ${cfg.storeUrl}`,
    };
  }
}
