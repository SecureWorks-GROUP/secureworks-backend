-- Follow-up 49 item 9(b), after 20261118194100: the cap's start date changes only through the
-- recorded approver's door (set_work_order_cap_start). The service role keeps SELECT on
-- work_order_cap_settings (ops-api reads it) and loses UPDATE, INSERT, DELETE and TRUNCATE, so
-- the API key can no longer change the date without a record. The door is SECURITY DEFINER and
-- still writes it. A hand change by the database owner (the Management API) is still possible
-- and is recorded once the director installs install_work_order_cap_start_record().
-- Placeholder version: the keeper stamps the real one.
-- Grants only: no table is created or altered, no trigger, timer, schedule or switch.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$ BEGIN
  IF to_regclass('public.work_order_cap_settings') IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_settings_door_only_pre_image' USING DETAIL = 'work_order_cap_settings';
  END IF;
  -- The door must exist and write as its owner before the key loses its own write.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE oid = to_regprocedure('public.set_work_order_cap_start(uuid,text,date,date,text)')
        AND prosecdef) THEN
    RAISE EXCEPTION 'work_order_cap_settings_door_only_pre_image' USING DETAIL = 'set_work_order_cap_start';
  END IF;
END $pre$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.work_order_cap_settings FROM service_role;
GRANT SELECT ON TABLE public.work_order_cap_settings TO service_role;
