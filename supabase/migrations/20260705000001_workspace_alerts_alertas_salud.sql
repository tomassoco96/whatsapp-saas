-- ============================================================
-- Migration: 20260705000001_workspace_alerts_alertas_salud
-- Alertas de salud por workspace (feature alertas-salud).
-- Las genera el cron /api/cron/health-check (service role) evaluando
-- reglas baratas sobre datos existentes (buffer trabado, silencio
-- anómalo, gasto LLM anómalo, errores de tools repetidos).
-- Dedupe: una sola alerta ABIERTA (resolved_at IS NULL) por
-- (workspace, type); la auto-resolución setea resolved_at.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.workspace_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Tipo de regla que disparó (texto libre, ej: 'buffer_trabado')
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  message TEXT NOT NULL,
  -- Detalle de la evaluación (contadores, ratios) para debugging
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = alerta abierta; se setea cuando la condición deja de cumplirse
  resolved_at TIMESTAMPTZ
);

-- Historial por workspace (listados ordenados por fecha)
CREATE INDEX IF NOT EXISTS idx_workspace_alerts_ws
  ON public.workspace_alerts(workspace_id, created_at DESC);

-- Alertas abiertas: dedupe por (workspace, type) y lecturas del panel
CREATE INDEX IF NOT EXISTS idx_workspace_alerts_open
  ON public.workspace_alerts(workspace_id, type)
  WHERE resolved_at IS NULL;

DROP TRIGGER IF EXISTS trg_workspace_alerts_updated_at ON public.workspace_alerts;
CREATE TRIGGER trg_workspace_alerts_updated_at
  BEFORE UPDATE ON public.workspace_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.workspace_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ws members read workspace alerts" ON public.workspace_alerts
  FOR SELECT USING (workspace_id IN (SELECT auth_workspace_ids()));

CREATE POLICY "ws admins manage workspace alerts" ON public.workspace_alerts
  FOR ALL USING (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  ) WITH CHECK (
    workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[])
  );

-- ============================================================
-- End of migration: 20260705000001_workspace_alerts_alertas_salud
-- ============================================================
