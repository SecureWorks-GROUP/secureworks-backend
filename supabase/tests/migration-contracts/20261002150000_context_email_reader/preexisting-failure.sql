-- A live change nobody read: a reader flag row already present (it would be
-- inherited, possibly on) and the cron lane list replaced by another body. The
-- guard must refuse and name both.
INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('email_reader_v1',true,'preexisting');
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text) LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $fn$ SELECT 'x'::text,'capture'::text $fn$;
