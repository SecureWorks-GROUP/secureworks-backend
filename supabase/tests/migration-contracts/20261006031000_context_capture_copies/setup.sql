-- Earlier registered context fixtures supply jobs, business_events, the
-- ladder, the admission rule (20261002170000), the catch-up set and the GHL
-- history door (20260925031500). Prove the two functions this migration
-- replaces are still their repository bodies (production's pre-image, read
-- 6 Oct 2026), so the contract runs from production's starting point.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_event_source_admissible(public.business_events)','fefd29131583c8e2afef18eca885b4d7'),
  ('public.capture_ghl_history_event(jsonb)','3e51278532e7c92a64b0cc9935ce2652')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'capture copies setup: % is not the pre-image (%)',x.sig,live; END IF;
 END LOOP;
 IF to_regprocedure('public.context_ghl_message_copies(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'capture copies setup: copies function already exists'; END IF;
END $$;
