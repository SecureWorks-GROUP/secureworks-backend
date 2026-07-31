-- Fix the historical PDF drain's service-to-service auth and make pg_net
-- failures visible to pg_cron.
--
-- ops-api runs with --no-verify-jwt and classifies its server callers by an
-- exact x-api-key match. The watchdog workflow and monitor-ses-makesafes use
-- the Edge runtime's SW_API_KEY through this contract. The cron reads the same
-- current key from Vault; old embedded helpers are deliberately not fallbacks.

CREATE TABLE IF NOT EXISTS public.makesafe_pdf_extraction_drain_requests (
  request_id bigint PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz
);

ALTER TABLE public.makesafe_pdf_extraction_drain_requests
  ADD COLUMN IF NOT EXISTS checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_makesafe_pdf_extraction_drain_requests_requested
  ON public.makesafe_pdf_extraction_drain_requests (requested_at DESC);

ALTER TABLE public.makesafe_pdf_extraction_drain_requests
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_pdf_extraction_drain_requests
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.makesafe_pdf_extraction_drain_requests
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.trigger_makesafe_pdf_extraction_drain()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  api_key text;
  queued_request_id bigint;
BEGIN
  -- pg_net keeps responses for six hours by default. Remove tracking rows that
  -- can no longer be checked before consulting the operational cron gate.
  DELETE FROM public.makesafe_pdf_extraction_drain_requests
   WHERE requested_at < now() - interval '6 hours';

  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_pdf_extraction_drain: cron gate disabled; skipping drain';
    RETURN;
  END IF;

  SELECT regexp_replace(decrypted_secret, '\s', '', 'g')
    INTO api_key
    FROM vault.decrypted_secrets
   WHERE name = 'sw_api_key'
   LIMIT 1;

  IF api_key IS NULL OR api_key = '' THEN
    RAISE EXCEPTION
      'trigger_makesafe_pdf_extraction_drain: vault secret "sw_api_key" is missing or empty';
  END IF;

  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_pdf_extraction_drain',
    headers := jsonb_build_object(
      'x-api-key', api_key,
      'Content-Type', 'application/json'
    ),
    body := '{"max_items":1,"lane":"historical"}'::jsonb
  )
  INTO queued_request_id;

  IF queued_request_id IS NULL THEN
    RAISE EXCEPTION
      'trigger_makesafe_pdf_extraction_drain: pg_net returned no request id';
  END IF;

  INSERT INTO public.makesafe_pdf_extraction_drain_requests (
    request_id, requested_at
  )
  VALUES (queued_request_id, now())
  ON CONFLICT (request_id) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.trigger_makesafe_pdf_extraction_drain IS
  'Queues one historical PDF drain request with the vault-backed ops-api x-api-key contract and records the pg_net request id for asynchronous response verification.';

CREATE OR REPLACE FUNCTION public.check_makesafe_pdf_extraction_drain_response()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  drain_request record;
BEGIN
  -- pg_net keeps responses for six hours by default. Cleanup must run even
  -- while the operational cron gate is disabled so expired rows cannot cause
  -- permanent missing-response alarms if the gate is enabled again.
  DELETE FROM public.makesafe_pdf_extraction_drain_requests
   WHERE requested_at < now() - interval '6 hours';

  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'check_makesafe_pdf_extraction_drain_response: cron gate disabled; skipping response check';
    RETURN;
  END IF;

  -- pg_net is asynchronous. Consume retained requests oldest-first so a later
  -- successful request can never hide an earlier failure.
  LOOP
    SELECT q.request_id,
           q.requested_at,
           r.id AS response_id,
           r.status_code,
           r.timed_out,
           r.error_msg
      INTO drain_request
      FROM public.makesafe_pdf_extraction_drain_requests q
      LEFT JOIN net._http_response r ON r.id = q.request_id
     WHERE q.checked_at IS NULL
       AND q.requested_at >= now() - interval '6 hours'
       AND q.requested_at < now() - interval '10 seconds'
     ORDER BY q.requested_at ASC
     LIMIT 1;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    IF drain_request.response_id IS NULL THEN
      IF drain_request.requested_at < now() - interval '2 minutes' THEN
        RAISE EXCEPTION
          'makesafe PDF drain request % has no pg_net response after 2 minutes',
          drain_request.request_id;
      END IF;
      RETURN;
    END IF;

    IF COALESCE(drain_request.timed_out, false)
       OR drain_request.error_msg IS NOT NULL
       OR drain_request.status_code IS NULL
       OR drain_request.status_code <> 200 THEN
      RAISE EXCEPTION
        'makesafe PDF drain request % failed: status=% timed_out=% error=%',
        drain_request.request_id,
        drain_request.status_code,
        COALESCE(drain_request.timed_out, false),
        COALESCE(drain_request.error_msg, '<none>');
    END IF;

    UPDATE public.makesafe_pdf_extraction_drain_requests
       SET checked_at = now()
     WHERE request_id = drain_request.request_id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.check_makesafe_pdf_extraction_drain_response IS
  'Checks retained asynchronous pg_net drain responses and makes its cron job fail loudly on non-200, timeout, network error, or a missing response.';

REVOKE ALL ON FUNCTION public.trigger_makesafe_pdf_extraction_drain()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_pdf_extraction_drain()
  TO service_role, postgres;

REVOKE ALL ON FUNCTION public.check_makesafe_pdf_extraction_drain_response()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_makesafe_pdf_extraction_drain_response()
  TO service_role, postgres;

DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-pdf-extraction-drain-response-check')
    FROM cron.job
   WHERE jobname = 'makesafe-pdf-extraction-drain-response-check';
END $$;

SELECT cron.schedule(
  'makesafe-pdf-extraction-drain-response-check',
  '* * * * *',
  $$SELECT public.check_makesafe_pdf_extraction_drain_response()$$
);
