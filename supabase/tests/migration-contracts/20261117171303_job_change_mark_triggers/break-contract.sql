-- Stand the historical mark/build contract back up; the successor has its own proofs.
\ir ../../../rollbacks/20261117172503_job_pages_queue_safety_down.sql
-- Break the trigger function so an explicit install cannot restore message marking.
CREATE OR REPLACE FUNCTION public.job_mark_changed_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN RETURN NULL; END $fn$;
