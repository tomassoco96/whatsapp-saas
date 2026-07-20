-- Idempotencia y anti-merge del buffer (feedback Brogas 17/7, items 5 y 7).
--
-- Sintomas reportados:
--   5) el bot mandaba mensajes espontaneos (re-envio de un turno ya respondido).
--   7) contestaba una consulta vieja al preguntar una nueva (un reintento revivia
--      el batch como 'buffering' y un mensaje nuevo se le pegaba, mezclando la
--      pregunta vieja con la nueva; consolidateBatch ordena por created_at asc).
--
-- Fixes:
--   1. dispatched_at: marca de "este turno ya se respondio" -> nunca re-envia.
--   2. retry_after: el reintento se queda en 'processing' (no vuelve a
--      'buffering'), asi un mensaje nuevo NO se mezcla con el turno viejo; se
--      abre un batch nuevo aparte.
--   3. indice unico parcial: a lo sumo un batch 'buffering' por conversacion ->
--      mata la race de dos webhooks concurrentes creando dos batches para una
--      misma rafaga.

ALTER TABLE message_batches ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE message_batches ADD COLUMN IF NOT EXISTS retry_after   TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_batches_one_buffering
  ON message_batches (conversation_id) WHERE status = 'buffering';

-- claim_next_batch: ademas de buffering-listos y processing-colgados (>5min),
-- reclama batches en reintento (processing + retry_after vencido) y limpia
-- retry_after al tomarlos.
CREATE OR REPLACE FUNCTION claim_next_batch()
RETURNS SETOF public.message_batches
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT id FROM public.message_batches
    WHERE status IN ('buffering', 'processing')
      AND (
        (status = 'buffering' AND flush_at < NOW())
        OR (status = 'processing' AND retry_after IS NOT NULL AND retry_after < NOW())
        OR (status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes')
      )
    ORDER BY flush_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.message_batches
    SET status = 'processing',
        updated_at = NOW(),
        retry_after = NULL
  FROM candidate
  WHERE public.message_batches.id = candidate.id
  RETURNING public.message_batches.*;
END;
$$;

-- upsert_batch: crea o extiende el batch abierto de una conversacion de forma
-- atomica. Reemplaza el SELECT-then-INSERT de buffer-enqueue.ts, que dejaba una
-- ventana para que dos webhooks concurrentes crearan dos batches.
CREATE OR REPLACE FUNCTION upsert_batch(
  p_workspace_id    UUID,
  p_conversation_id UUID,
  p_silence_ms      INT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_id UUID;
  v_flush    TIMESTAMPTZ := NOW() + (p_silence_ms || ' milliseconds')::INTERVAL;
BEGIN
  -- Extiende el batch abierto si existe.
  UPDATE public.message_batches
    SET flush_at = v_flush,
        message_count = message_count + 1,
        updated_at = NOW()
    WHERE conversation_id = p_conversation_id AND status = 'buffering'
    RETURNING id INTO v_batch_id;

  IF v_batch_id IS NOT NULL THEN
    RETURN v_batch_id;
  END IF;

  -- Ninguno abierto -> crea uno. El indice unico parcial hace la insercion
  -- race-safe: si otro worker lo creo en el medio, extiende ese (ON CONFLICT).
  INSERT INTO public.message_batches AS mb
    (workspace_id, conversation_id, status, silence_ms, flush_at, message_count, meta)
  VALUES
    (p_workspace_id, p_conversation_id, 'buffering', p_silence_ms, v_flush, 1, '{}'::jsonb)
  ON CONFLICT (conversation_id) WHERE (status = 'buffering')
  DO UPDATE SET flush_at = v_flush,
                message_count = mb.message_count + 1,
                updated_at = NOW()
  RETURNING mb.id INTO v_batch_id;

  RETURN v_batch_id;
END;
$$;
