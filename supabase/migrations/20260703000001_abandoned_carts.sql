-- ============================================================
-- Migration: 20260703000001_abandoned_carts
-- Feature ecommerce — ingesta de carritos abandonados (Flujo A del motor v1,
-- multi-tenant). El webhook del plugin (BotSailor/CartBounty) entra por
-- /api/webhooks/cart-abandoned/[workspaceId] con secret por workspace
-- (integrations provider 'woocommerce', config.cart_webhook_secret).
-- La secuencia de toques se resuelve aparte (automation_rules / cron).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.abandoned_carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Contacto vinculado si el teléfono matchea uno existente del workspace
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  -- ID del carrito en el plugin de origen (dedupe fuerte)
  external_id TEXT,
  -- E.164 normalizado; NULL = carrito sin teléfono contactable
  phone TEXT,
  email TEXT,
  customer_name TEXT,
  -- Ítems sanitizados: [{ name, qty, price, sku?, url? }]
  items JSONB NOT NULL DEFAULT '[]',
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT,
  checkout_url TEXT,
  abandoned_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',          -- ingresado, sin contactar
    'contacted',        -- al menos un toque enviado
    'recovered',        -- el cliente completó la compra
    'expired',          -- se agotó la secuencia sin recuperar
    'not_contactable',  -- sin teléfono normalizable
    'opted_out'         -- el contacto pidió no recibir mensajes
  )),
  touches_sent INT NOT NULL DEFAULT 0,
  last_touch_at TIMESTAMPTZ,
  recovered_order_id BIGINT,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedupe fuerte por ID del plugin (cuando lo manda)
CREATE UNIQUE INDEX IF NOT EXISTS uq_abandoned_carts_ws_external
  ON public.abandoned_carts(workspace_id, external_id)
  WHERE external_id IS NOT NULL;

-- Dedupe blando + dashboard: búsquedas por workspace/estado/fecha y por teléfono
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_ws_status
  ON public.abandoned_carts(workspace_id, status, abandoned_at DESC);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_ws_phone
  ON public.abandoned_carts(workspace_id, phone)
  WHERE phone IS NOT NULL;

CREATE TRIGGER trg_abandoned_carts_updated_at
  BEFORE UPDATE ON public.abandoned_carts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.abandoned_carts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ws members read abandoned carts" ON public.abandoned_carts
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

CREATE POLICY "ws admins manage abandoned carts" ON public.abandoned_carts
  FOR ALL USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  ) WITH CHECK (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  );

-- ============================================================
-- End of migration: 20260703000001_abandoned_carts
-- ============================================================
