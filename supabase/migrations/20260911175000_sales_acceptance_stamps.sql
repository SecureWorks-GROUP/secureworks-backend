-- Acceptance dates are first-observed evidence, not the date of the latest status edit.
-- Deposit stamps and the already-shipped Xero deposit backfill are untouched.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS accepted_at_evidence jsonb;

-- Null-only historical repair. A witnessed acceptance event outranks updated_at.
-- No evidence means a labelled estimate, never an observed customer acceptance.
WITH evidence AS (
 SELECT j.id,j.updated_at,
   (SELECT jsonb_build_object('id',e.id,'at',e.created_at)
    FROM public.job_events e WHERE e.job_id=j.id AND e.created_at IS NOT NULL
      AND e.event_type IN ('status_changed','status_change','job.status_changed','quote_accepted')
      AND e.detail_json->>'new_status'='accepted'
    ORDER BY e.created_at,e.id LIMIT 1) AS witnessed
 FROM public.jobs j WHERE j.accepted_at IS NULL
), candidates AS (
 SELECT j.id,coalesce((e.witnessed->>'at')::timestamptz,e.updated_at) AS stamp,e.witnessed
 FROM evidence e JOIN public.jobs j ON j.id=e.id
 WHERE e.witnessed IS NOT NULL OR j.status IN
 ('accepted','approvals','deposit','awaiting_deposit','awaiting_supplier','processing','order_materials','schedule_install','scheduled','in_progress','complete','invoiced','rectification')
)
UPDATE public.jobs j SET accepted_at=c.stamp,
 accepted_at_evidence=jsonb_build_object(
   'quality',CASE WHEN c.witnessed IS NOT NULL THEN 'OBSERVED_EVENT' ELSE 'BACKFILLED' END,
   'timestamp_source',CASE WHEN c.witnessed IS NOT NULL THEN 'job_events.created_at' ELSE 'jobs.updated_at' END,
   'source_event_id',c.witnessed->>'id','migration','20260911175000',
   'recorded_at',now(),'customer_acceptance_verified',false)
FROM candidates c WHERE j.id=c.id AND j.accepted_at IS NULL AND c.stamp IS NOT NULL;

CREATE OR REPLACE FUNCTION public.preserve_first_acceptance_stamp()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.accepted_at IS NOT NULL THEN
   -- Status APIs historically resend NOW on an already accepted job. Keep the
   -- first stamp/provenance, including when that first stamp is labelled estimated.
   NEW.accepted_at:=OLD.accepted_at;
   NEW.accepted_at_evidence:=OLD.accepted_at_evidence;
 ELSIF NEW.status='accepted' OR NEW.accepted_at IS NOT NULL THEN
   NEW.accepted_at:=coalesce(NEW.accepted_at,now());
   NEW.accepted_at_evidence:=coalesce(NEW.accepted_at_evidence,jsonb_build_object(
     'quality','OBSERVED_WRITE','timestamp_source','jobs.accepted_at_write',
     'recorded_at',now(),'customer_acceptance_verified',false));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER jobs_preserve_first_acceptance_stamp
 BEFORE INSERT OR UPDATE OF status,accepted_at,accepted_at_evidence ON public.jobs
 FOR EACH ROW EXECUTE FUNCTION public.preserve_first_acceptance_stamp();
COMMENT ON COLUMN public.jobs.accepted_at_evidence IS
 'Acceptance timestamp evidence: OBSERVED_EVENT/OBSERVED_WRITE versus BACKFILLED estimate. A CRM status is not verified client acceptance.';
