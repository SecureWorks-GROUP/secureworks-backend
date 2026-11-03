-- Stamp whenever a write carries a job: the sync's upsert rewrites the same job on
-- every pass, so a link made before the column existed would read as linked now.
-- The contract must catch it.
CREATE OR REPLACE FUNCTION public.xero_invoices_stamp_job_linked_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.job_linked_at := CASE WHEN NEW.job_id IS NOT NULL THEN now() END;
  ELSE
    NEW.job_linked_at := CASE WHEN NEW.job_id IS NOT NULL THEN now() ELSE OLD.job_linked_at END;
  END IF;
  RETURN NEW;
END
$fn$;
