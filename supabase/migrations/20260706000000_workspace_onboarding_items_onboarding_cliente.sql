-- ============================================================
-- Migration: 20260706000000_workspace_onboarding_items_onboarding_cliente
-- Tracking del onboarding del cliente por workspace (feature onboarding-cliente).
-- Cada fila es un requisito del onboarding estandarizado:
--   kind='pregunta_hecha' → pregunta que el operador hace en la reunión
--   kind='entregable'     → acceso/credencial/material que debe llegar
--   kind='envio'          → texto que le mandamos al cliente (copiable en detail)
-- El template de ítems vive en código
-- (src/features/onboarding-cliente/services/seed-items.ts) y se inserta
-- lazy la primera vez que se consulta el onboarding del workspace.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.workspace_onboarding_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Sección del checklist (ej: 'Negocio e identidad', 'Para enviar al cliente')
  section TEXT NOT NULL,
  label TEXT NOT NULL,
  -- Texto largo copiable (mensajes listos para WhatsApp en ítems kind='envio')
  detail TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('pregunta_hecha', 'entregable', 'envio')),
  status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'enviado', 'recibido', 'no_aplica')),
  owner TEXT NOT NULL DEFAULT 'cliente' CHECK (owner IN ('nosotros', 'cliente')),
  due_date DATE,
  notes TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Listado de la página: ítems del workspace en el orden del template
CREATE INDEX IF NOT EXISTS idx_workspace_onboarding_items_ws
  ON public.workspace_onboarding_items(workspace_id, sort_order);

DROP TRIGGER IF EXISTS trg_workspace_onboarding_items_updated_at
  ON public.workspace_onboarding_items;
CREATE TRIGGER trg_workspace_onboarding_items_updated_at
  BEFORE UPDATE ON public.workspace_onboarding_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.workspace_onboarding_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ws members read onboarding items" ON public.workspace_onboarding_items
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

CREATE POLICY "ws admins manage onboarding items" ON public.workspace_onboarding_items
  FOR ALL USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  ) WITH CHECK (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  );

-- ============================================================
-- End of migration: 20260706000000_workspace_onboarding_items_onboarding_cliente
-- ============================================================
