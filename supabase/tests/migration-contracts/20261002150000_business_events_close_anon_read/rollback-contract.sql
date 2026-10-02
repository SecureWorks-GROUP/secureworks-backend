-- After the down migration the pre-change read surface is back exactly:
-- select_all for PUBLIC, anon SELECT, no staff policy or helper, insert
-- policies untouched.
DO $$
BEGIN
  IF NOT has_table_privilege('anon', 'public.business_events', 'SELECT') THEN
    RAISE EXCEPTION 'be-close rollback: anon SELECT not restored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events'
                 AND policyname = 'select_all' AND cmd = 'SELECT' AND roles = ARRAY['public']::name[]
                 AND qual = 'true') THEN
    RAISE EXCEPTION 'be-close rollback: select_all not restored';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events'
             AND policyname = 'business_events_staff_read') THEN
    RAISE EXCEPTION 'be-close rollback: staff policy remains';
  END IF;
  IF to_regprocedure('public.business_events_staff_reader()') IS NOT NULL THEN
    RAISE EXCEPTION 'be-close rollback: staff helper remains';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events'
      AND policyname IN ('insert_only', 'Allow scope decision inserts from tools')) <> 2 THEN
    RAISE EXCEPTION 'be-close rollback: insert policies changed';
  END IF;
END $$;

BEGIN;
INSERT INTO public.business_events (id, event_type, source, entity_type, entity_id, payload)
VALUES ('be0e0000-0000-4000-8000-0000000000a1', 'sms.received', 'ghl', 'contact', 'c1', '{}');
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.business_events WHERE id = 'be0e0000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'be-close rollback: anon cannot read again';
  END IF;
END $$;
ROLLBACK;
