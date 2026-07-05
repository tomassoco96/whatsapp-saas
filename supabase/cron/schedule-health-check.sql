-- ============================================================
-- Post-deploy cron: alertas de salud por workspace cada 15' (pg_cron + pg_net)
--
-- Igual que schedule-buffer-flush.sql / schedule-recovery-touch.sql: necesita
-- la URL de prod y el CRON_SECRET, que existen recién después del primer
-- deploy. Reemplazar los placeholders y correr en Supabase -> SQL Editor.
-- Idempotente: re-correrlo actualiza el job 'health-check' en su lugar.
--
--   __APP_URL__      -> NEXT_PUBLIC_APP_URL  (sin barra final)
--   __CRON_SECRET__  -> CRON_SECRET
--
-- El endpoint es POST (a diferencia de los otros crons que usan GET), por eso
-- acá se usa net.http_post. Requiere la migración
-- 20260705000001_workspace_alerts_alertas_salud.sql aplicada.
-- Notificación saliente opcional: setear ALERT_WEBHOOK_URL en el deploy
-- (ver .env.local.example).
-- ============================================================

select cron.schedule(
  'health-check',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url     := '__APP_URL__/api/cron/health-check',
      body    := '{}'::jsonb,
      headers := jsonb_build_object(
        'Authorization', 'Bearer __CRON_SECRET__',
        'Content-Type', 'application/json'
      )
    );
  $job$
);

-- Verificar:  select jobname, schedule, active from cron.job where jobname = 'health-check';
-- Remover:    select cron.unschedule('health-check');
