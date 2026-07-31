-- Fix the historical PDF drain's service-to-service auth and make pg_net
-- failures visible to pg_cron.
--
-- ops-api runs with --no-verify-jwt and classifies its server callers by an
-- exact x-api-key match. A vault service-role JWT that does not byte-match the
-- Edge runtime's injected key falls through to user-session validation and
-- produces "Session expired". The production _sw_api_key() helper is the same
-- internal key source used by the working ops-api server-call convention.

CREATE TABLE IF NOT EXISTS public.makesafe_pdf_extraction_drain_requests (
  request_id bigint PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);

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
  queued_request_id bigint;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_pdf_extraction_drain: cron gate disabled; skipping drain';
    RETURN;
  END IF;

  DELETE FROM public.makesafe_pdf_extraction_drain_requests
   WHERE requested_at < now() - interval '24 hours';

  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_pdf_extraction_drain',
    headers := jsonb_build_object(
      'x-api-key', public._sw_api_key(),
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
  'Queues one historical PDF drain request with the ops-api x-api-key contract and records the pg_net request id for asynchronous response verification.';

CREATE OR REPLACE FUNCTION public.check_makesafe_pdf_extraction_drain_response()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  drain_request record;
BEGIN
  -- pg_net is asynchronous. Check every retained request after its settle
  -- grace so a later successful request cannot hide an earlier failure.
  FOR drain_request IN
    SELECT q.request_id,
           q.requested_at,
           r.status_code,
           r.timed_out,
           r.error_msg
      FROM public.makesafe_pdf_extraction_drain_requests q
      LEFT JOIN net._http_response r ON r.id = q.request_id
     WHERE q.requested_at < now() - interval '10 seconds'
     ORDER BY q.requested_at ASC
  LOOP
    IF drain_request.status_code IS NULL THEN
      IF drain_request.requested_at < now() - interval '2 minutes' THEN
        RAISE EXCEPTION
          'makesafe PDF drain request % has no pg_net response after 2 minutes',
          drain_request.request_id;
      END IF;
      CONTINUE;
    END IF;

    IF COALESCE(drain_request.timed_out, false)
       OR drain_request.error_msg IS NOT NULL
       OR drain_request.status_code <> 200 THEN
      RAISE EXCEPTION
        'makesafe PDF drain request % failed: status=% timed_out=% error=%',
        drain_request.request_id,
        drain_request.status_code,
        COALESCE(drain_request.timed_out, false),
        COALESCE(drain_request.error_msg, '<none>');
    END IF;
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
