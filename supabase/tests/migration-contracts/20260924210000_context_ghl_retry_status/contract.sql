-- The status block and composed heartbeat expose the latest stored retry coordinate.
BEGIN;
DO $$
DECLARE r jsonb; s jsonb; composed jsonb; expected text:='2026-09-24T06:00:00+00:00';
BEGIN
 r:=public.record_capture_run(jsonb_build_object(
  'source','ghl_message_reconcile',
  'status','partial',
  'watermark',expected,
  'cursor',jsonb_build_object('v',1,'complete',true,'retry_from',expected),
  'counts','{}'::jsonb));
 s:=public.context_ghl_capture_status();
 composed:=public.context_pipeline_status();
 IF s#>>'{reconciler,retry_from}' IS DISTINCT FROM expected
  OR composed#>>'{ghl_capture,reconciler,retry_from}' IS DISTINCT FROM expected
 THEN RAISE EXCEPTION 'ghl retry status projection did not expose latest cursor value: block %, composer %',s->'reconciler',composed->'ghl_capture'; END IF;
 IF s#>>'{reconciler,last_run,status}' IS DISTINCT FROM 'partial'
 THEN RAISE EXCEPTION 'ghl retry status latest run %',s->'{reconciler,last_run}'; END IF;
END $$;
ROLLBACK;
