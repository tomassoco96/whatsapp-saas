-- ============================================================
-- Migration: 20260703000000_seed_ecommerce_tools
-- Feature ecommerce (WooCommerce) — seed de buscar_producto y estado_pedido
--
-- Las tools están implementadas y registradas en código
-- (src/features/tools/tools/{buscar-producto,estado-pedido}.ts → registry).
-- Se siembran en public.tools para que aparezcan en el catálogo de Settings
-- y puedan habilitarse por workspace vía tool_configs.
--
-- La columna schema es solo para catálogo/display — el agente arma el schema
-- LLM desde la definición zod del código. Idempotente vía ON CONFLICT.
--
-- Las credenciales/config van en integrations (provider = 'woocommerce'):
--   credentials: { wc_consumer_key, wc_consumer_secret }   -- solo pedidos
--   config:      { store_url, search_stopwords?, status_messages? }
-- ============================================================

INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('buscar_producto', 'Buscar producto (WooCommerce)',
   'Searches the store WooCommerce catalog by term, category, slug or URL; returns price, stock, sizes and link',
   '{"type":"object","properties":{"query":{"type":"string"},"category_slug":{"type":"string"},"product_slug":{"type":"string"},"product_url":{"type":"string"},"limit":{"type":"integer"}},"required":[]}',
   'read'),
  ('estado_pedido', 'Estado de pedido (WooCommerce)',
   'Looks up a WooCommerce order status by order id or customer phone; returns a customer-ready status message',
   '{"type":"object","properties":{"order_id":{"type":"integer"},"phone":{"type":"string"}},"required":[]}',
   'read')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      schema = EXCLUDED.schema,
      sensitivity = EXCLUDED.sensitivity;

-- ============================================================
-- End of migration: 20260703000000_seed_ecommerce_tools
-- ============================================================
