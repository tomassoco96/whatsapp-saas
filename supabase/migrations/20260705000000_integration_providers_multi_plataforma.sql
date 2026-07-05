-- Providers de e-commerce en el enum integration_provider.
--
-- 'woocommerce' ya se usa desde el código (wc-config.ts, recovery.service.ts)
-- pero ninguna migración lo había agregado al enum de foundation — en las DB
-- existentes se alteró a mano. Esta migración lo formaliza y suma los dos
-- providers nuevos: Tiendanube y Shopify.
--
-- Nota Postgres: ADD VALUE no puede usarse en la misma transacción donde se
-- consume el valor nuevo; acá solo se agregan (idempotente con IF NOT EXISTS).

ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'woocommerce';
ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'tiendanube';
ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'shopify';

-- Convenciones de filas en integrations (mismo patrón que woocommerce):
--   tiendanube: credentials = { tn_access_token }
--               config      = { store_id, store_url?, search_stopwords?, status_messages? }
--   shopify:    credentials = { shopify_access_token }
--               config      = { shop_domain, search_stopwords?, status_messages? }

-- Las tools buscar_producto / estado_pedido ahora despachan por provider:
-- refresco de la descripción display del catálogo (la real vive en el Zod).
UPDATE public.tools
SET description = 'Busca productos reales en el catálogo de la tienda conectada (WooCommerce, Tiendanube o Shopify): precio, stock y link.'
WHERE key = 'buscar_producto';

UPDATE public.tools
SET description = 'Consulta el estado real de un pedido en la tienda conectada (WooCommerce, Tiendanube o Shopify) por número de orden o teléfono.'
WHERE key = 'estado_pedido';
