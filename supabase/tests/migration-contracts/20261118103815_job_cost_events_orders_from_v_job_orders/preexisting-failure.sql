-- A reader that is not main's must stop the migration, never be overwritten.
DO $drift$ DECLARE d text;
/* block */ BEGIN
 d:=pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true);
 EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS '||replace(d,'''installer_bill_unconfirmed''::text','''ZZTEST-drift''::text');
END $drift$;
