BEGIN;
SET LOCAL statement_timeout = '90s';
-- Rule 17: stand the door back up (its migration re-applies), then apply twice.
\ir ../../../migrations/20261118194100_work_order_cap_start_set.sql
\ir ../../../rollbacks/20261118999909_work_order_cap_settings_door_only_down.sql
\ir ../../../migrations/20261118999909_work_order_cap_settings_door_only.sql
\ir ../../../migrations/20261118999909_work_order_cap_settings_door_only.sql

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', label; END IF;
END $$;

DO $$ BEGIN
  PERFORM pg_temp.assert_ok(has_table_privilege('service_role', 'public.work_order_cap_settings', 'SELECT'), 'service role cannot read');
  PERFORM pg_temp.assert_ok(NOT has_table_privilege('service_role', 'public.work_order_cap_settings', 'UPDATE')
    AND NOT has_table_privilege('service_role', 'public.work_order_cap_settings', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.work_order_cap_settings', 'DELETE')
    AND NOT has_table_privilege('service_role', 'public.work_order_cap_settings', 'TRUNCATE'), 'service role can write the settings');
  PERFORM pg_temp.assert_ok(NOT has_table_privilege('authenticated', 'public.work_order_cap_settings', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.work_order_cap_settings', 'SELECT'), 'browser roles can read');
  PERFORM pg_temp.assert_ok((SELECT cap_start_on IS NULL FROM public.work_order_cap_settings WHERE id = 1), 'start date set on merge');
END $$;

UPDATE public.work_order_settings SET owner_user_ids = ARRAY['f1990900-0000-4000-8000-0000000000a1'::uuid] WHERE id = 1;
SET LOCAL ROLE service_role;
-- The key reads the date and changes it only through the door.
SELECT cap_start_on FROM public.work_order_cap_settings WHERE id = 1;
DO $$ BEGIN
  BEGIN
    UPDATE public.work_order_cap_settings SET cap_start_on = DATE '2026-11-24' WHERE id = 1;
    RAISE EXCEPTION 'ZZTEST service role updated the settings';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SELECT public.set_work_order_cap_start('f1990900-0000-4000-8000-0000000000a1', NULL, NULL, DATE '2026-11-24', 'ZZTEST door only');
RESET ROLE;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT cap_start_on FROM public.work_order_cap_settings WHERE id = 1) = DATE '2026-11-24', 'door did not write');
  PERFORM pg_temp.assert_ok((SELECT via || ':' || new_start FROM public.work_order_cap_start_changes ORDER BY id DESC LIMIT 1)
    = 'approver:2026-11-24', 'door change not recorded');
END $$;
ROLLBACK;
SELECT 'FU49-9b cap settings change only through the door: passed' AS result;
