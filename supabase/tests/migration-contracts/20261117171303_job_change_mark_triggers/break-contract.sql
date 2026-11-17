-- Break the trigger function so an explicit install cannot restore message marking.
CREATE OR REPLACE FUNCTION public.job_mark_changed_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN RETURN NULL; END $fn$;
