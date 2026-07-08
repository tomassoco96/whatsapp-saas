-- Evolution API como proveedor de canal WhatsApp (no oficial, via Baileys).
-- Para pruebas con clientes antes de conectar su numero oficial (BSP/YCloud)
-- y como canal economico para clientes chicos.
--
-- Fila en integrations para provider='evolution':
--   credentials: { evolution_api_key, webhook_token }
--   config:      { server_url, instance_name, phone_number?, buffer_silence_seconds? }
ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'evolution';
