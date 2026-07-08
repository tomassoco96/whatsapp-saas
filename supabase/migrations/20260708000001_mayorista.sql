-- Modulo MAYORISTA multi-tenant (portado del motor v1 de Brogas).
-- Calificacion conversacional de leads B2B: gate razon social + CUIT valido
-- (digito verificador), asignacion de vendedor por zona con prioridad, alerta
-- por WhatsApp al vendedor asignado, y cartera vendedor->cliente para autorizar
-- consultas de cuenta corriente por identidad del canal.

-- Enums (CREATE TYPE no soporta IF NOT EXISTS)
DO $$ BEGIN
  CREATE TYPE lead_estado AS ENUM (
    'incompleto',
    'pendiente_calificacion',
    'calificado',
    'asignado',
    'rechazado_sin_razon_social'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lista_precio AS ENUM ('distribuidor', 'mayorista');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Vendedores ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendedores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  -- telefono E.164 (con 9 para moviles AR); identidad para cuenta corriente y
  -- destino de la alerta de lead. NULL = sin alerta WhatsApp (solo dashboard).
  telefono        TEXT,
  email           TEXT,
  horario         TEXT,
  -- 'campo' (visita clientes) o 'telefonico' (atencion remota)
  tipo            TEXT NOT NULL DEFAULT 'campo',
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  crm_external_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, telefono)
);
CREATE INDEX IF NOT EXISTS idx_vendedores_ws ON vendedores (workspace_id);

-- Una zona puede tener >1 vendedor (ej. Buenos Aires): sin unique sobre zona.
-- `prioridad` desempata: 1 = principal de la zona; el resolver toma el menor.
CREATE TABLE IF NOT EXISTS vendedor_zonas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  vendedor_id  UUID NOT NULL REFERENCES vendedores (id) ON DELETE CASCADE,
  zona         TEXT NOT NULL,          -- token normalizado (ver mayorista/lib/zona.ts)
  prioridad    INT NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendedor_zonas_ws_zona ON vendedor_zonas (workspace_id, zona);
CREATE INDEX IF NOT EXISTS idx_vendedor_zonas_vendedor ON vendedor_zonas (vendedor_id);

-- Cartera vendedor -> cliente (ownership para autorizar cuenta corriente).
CREATE TABLE IF NOT EXISTS vendedor_clientes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  vendedor_id    UUID NOT NULL REFERENCES vendedores (id) ON DELETE CASCADE,
  cliente_cuit   TEXT NOT NULL,
  cliente_nombre TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendedor_id, cliente_cuit)
);
CREATE INDEX IF NOT EXISTS idx_vendedor_clientes_ws_cuit ON vendedor_clientes (workspace_id, cliente_cuit);

-- ── Leads mayoristas ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads_mayorista (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- clave de upsert: telefono del CANAL (anclado server-side, no del LLM).
  contacto_phone  TEXT NOT NULL,
  nombre_contacto TEXT,
  razon_social    TEXT,
  cuit            TEXT,
  provincia       TEXT,
  localidad       TEXT,
  email           TEXT,
  telefono        TEXT,
  rubro           TEXT,
  formato_venta   TEXT,             -- "Distribucion" | "Venta al publico" (texto libre)
  comentarios     TEXT,
  lista_precio    lista_precio,     -- derivada de formato_venta
  estado          lead_estado NOT NULL DEFAULT 'incompleto',
  incompleto      BOOLEAN NOT NULL DEFAULT TRUE,
  vendedor_id     UUID REFERENCES vendedores (id) ON DELETE SET NULL,
  -- timestamp de la alerta enviada al vendedor (para el escalamiento por no
  -- respuesta y para no notificar dos veces).
  vendedor_notificado_at TIMESTAMPTZ,
  form_raw        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, contacto_phone)
);
CREATE INDEX IF NOT EXISTS idx_leads_mayorista_ws_estado ON leads_mayorista (workspace_id, estado);
CREATE INDEX IF NOT EXISTS idx_leads_mayorista_vendedor ON leads_mayorista (vendedor_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE vendedores        ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedor_zonas    ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedor_clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads_mayorista   ENABLE ROW LEVEL SECURITY;

-- Lectura: miembros del workspace. Escritura: admin/manager (el service role
-- de los tools bypassa RLS).
CREATE POLICY "ws members read vendedores" ON vendedores FOR SELECT
  USING (workspace_id IN (SELECT auth_workspace_ids()));
CREATE POLICY "ws managers write vendedores" ON vendedores FOR ALL
  USING (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]))
  WITH CHECK (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]));

CREATE POLICY "ws members read vendedor_zonas" ON vendedor_zonas FOR SELECT
  USING (workspace_id IN (SELECT auth_workspace_ids()));
CREATE POLICY "ws managers write vendedor_zonas" ON vendedor_zonas FOR ALL
  USING (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]))
  WITH CHECK (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]));

CREATE POLICY "ws members read vendedor_clientes" ON vendedor_clientes FOR SELECT
  USING (workspace_id IN (SELECT auth_workspace_ids()));
CREATE POLICY "ws managers write vendedor_clientes" ON vendedor_clientes FOR ALL
  USING (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]))
  WITH CHECK (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]));

CREATE POLICY "ws members read leads_mayorista" ON leads_mayorista FOR SELECT
  USING (workspace_id IN (SELECT auth_workspace_ids()));
CREATE POLICY "ws managers write leads_mayorista" ON leads_mayorista FOR ALL
  USING (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]))
  WITH CHECK (workspace_id IN (SELECT auth_workspace_ids())
    AND auth_has_role(workspace_id, ARRAY['admin','manager']::workspace_role[]));

-- ── Tools del agente ──────────────────────────────────────────────────────────
INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('calificar_lead', 'Calificar lead mayorista',
   'Registers/updates a wholesale lead, validates CUIT check digit, assigns price list and zone vendor, and alerts the vendor',
   '{"type":"object","properties":{"nombre_contacto":{"type":"string"},"razon_social":{"type":"string"},"cuit":{"type":"string"},"provincia":{"type":"string"},"localidad":{"type":"string"},"email":{"type":"string"},"telefono":{"type":"string"},"rubro":{"type":"string"},"formato_venta":{"type":"string"},"comentarios":{"type":"string"},"rechaza_razon_social":{"type":"boolean"}},"required":[]}',
   'write'),
  ('consultar_cuenta_corriente', 'Cuenta corriente (vendedores)',
   'For INTERNAL vendors only: validates the sender phone against the vendor roster and the client CUIT against their portfolio before answering account questions',
   '{"type":"object","properties":{"cliente_cuit":{"type":"string"}},"required":["cliente_cuit"]}',
   'read')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE vendedores IS 'Vendedores mayoristas por workspace (zona/telefono/horario). 1 lead -> 1 vendedor por zona.';
COMMENT ON TABLE vendedor_clientes IS 'Cartera vendedor->cliente: ownership para autorizar cuenta corriente.';
COMMENT ON TABLE leads_mayorista IS 'Leads mayoristas calificados por el agente (gate razon social + CUIT, asignacion por zona).';
