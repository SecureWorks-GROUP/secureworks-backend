-- After the down: the service role may update the cap settings again, as before.
DO $$ BEGIN
  IF NOT has_table_privilege('service_role', 'public.work_order_cap_settings', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.work_order_cap_settings', 'SELECT') THEN
    RAISE EXCEPTION 'ZZTEST rollback left the service role without its update';
  END IF;
END $$;
BEGIN;
\ir ../../../migrations/20261118999909_work_order_cap_settings_door_only.sql
ROLLBACK;
SELECT 'FU49-9b cap settings door only rollback passed' AS result;
