-- Restore the over-broad hold verify V-1 found: block every placement change on a decided row.
CREATE OR REPLACE FUNCTION public.context_recon_hold_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.context_reconciliation_decisions x WHERE x.subject_kind = 'event' AND x.subject_id = OLD.id) THEN
    NEW.job_id := OLD.job_id;
    NEW.attribution_status := OLD.attribution_status;
  END IF;
  RETURN NEW;
END $$;
