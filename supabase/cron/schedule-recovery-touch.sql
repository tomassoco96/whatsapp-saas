-- ============================================================
-- Post-deploy cron: toques de recuperación de carritos cada 15' (pg_cron + pg_net)
--
-- Igual que schedule-buffer-flush.sql: necesita la URL de prod y el
-- CRON_SECRET, que existen recién después del primer deploy. Reemplazar los
-- placeholders y correr en Supabase -> SQL Editor. Idempotente: re-correrlo
-- actualiza el job 'recovery-touch' en su lugar.
--
--   __APP_URL__      -> NEXT_PUBLIC_APP_URL  (sin barra final)
--   __CRON_SECRET__  -> CRON_SECRET
--
-- IMPORTANTE (regla del kit v1): agendar este job NO enciende la
-- recuperación. Cada workspace la activa explícitamente con
-- config.recovery.enabled = true en su integración woocommerce, con el OK
-- del dueño del negocio — hay carritos de gente real en la tabla desde el
-- minuto uno.
-- ============================================================

select cron.schedule(
  'recovery-touch',
  '*/15 * * * *',
  $job$
    select net.http_get(
      url     := '__APP_URL__/api/cron/recovery-touch',
      headers := jsonb_build_object('Authorization', 'Bearer __CRON_SECRET__')
    );
  $job$
);

-- Verificar:  select jobname, schedule, active from cron.job where jobname = 'recovery-touch';
-- Remover:    select cron.unschedule('recovery-touch');
