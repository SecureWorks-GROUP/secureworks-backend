-- Existing submission/step identity is selected before the quote. Never infer a billing step from its name.
CREATE TABLE public.quote_invoice_council_bindings (
  quote_revision_id uuid NOT NULL REFERENCES public.quote_revisions(id) ON DELETE RESTRICT,
  stage_id text NOT NULL,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  submission_id uuid,
  step_id uuid,
  step_name text,
  state text NOT NULL CHECK(state IN('eligible','held')),
  hold_reason text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(quote_revision_id,stage_id),
  CHECK ((state='eligible' AND submission_id IS NOT NULL AND step_id IS NOT NULL AND step_name IS NOT NULL AND hold_reason IS NULL)
    OR (state='held' AND hold_reason IS NOT NULL))
);
ALTER TABLE public.quote_invoice_council_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_invoice_council_bindings FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.quote_invoice_council_bindings TO service_role;
CREATE FUNCTION public.pin_quote_invoice_council_step() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE stage jsonb; target record; submission record; sid uuid; stepid uuid; reason text;
BEGIN
  IF NEW.sent_at IS NULL OR jsonb_typeof(NEW.pricing_snapshot_json->'raw'->'billing_milestones'->'milestones') IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
  SELECT id,org_id INTO target FROM public.jobs WHERE id=NEW.job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  FOR stage IN SELECT value FROM jsonb_array_elements(NEW.pricing_snapshot_json->'raw'->'billing_milestones'->'milestones') LOOP
    IF stage->'trigger'->>'kind' IS DISTINCT FROM 'council_step_completed' OR nullif(stage->>'id','') IS NULL THEN CONTINUE; END IF;
    sid:=NULL; stepid:=NULL; reason:='quote_council_step_identity_missing';
    IF stage->'trigger'->>'submission_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND stage->'trigger'->>'step_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      sid:=(stage->'trigger'->>'submission_id')::uuid; stepid:=(stage->'trigger'->>'step_id')::uuid;
      SELECT * INTO submission FROM public.council_submissions WHERE id=sid AND job_id=NEW.job_id AND org_id=target.org_id FOR SHARE;
      IF FOUND AND (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(submission.steps)='array' THEN submission.steps ELSE '[]'::jsonb END) s WHERE s->>'step_id'=stepid::text)=1
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(submission.steps) s WHERE s->>'step_id'=stepid::text AND s->>'name'=stage->'trigger'->>'step_name' AND s->>'status' IS DISTINCT FROM 'complete') THEN reason:=NULL;
      ELSE reason:='quote_council_step_not_on_job_or_already_complete'; END IF;
    END IF;
    INSERT INTO public.quote_invoice_council_bindings(quote_revision_id,stage_id,org_id,job_id,submission_id,step_id,step_name,state,hold_reason)
    VALUES(NEW.id,stage->>'id',target.org_id,NEW.job_id,sid,stepid,stage->'trigger'->>'step_name',CASE WHEN reason IS NULL THEN 'eligible' ELSE 'held' END,reason)
    ON CONFLICT(quote_revision_id,stage_id) DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.pin_quote_invoice_council_step() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER pin_council_invoice_step_when_quote_released AFTER INSERT OR UPDATE OF sent_at ON public.quote_revisions FOR EACH ROW EXECUTE FUNCTION public.pin_quote_invoice_council_step();
CREATE OR REPLACE FUNCTION public.guard_invoice_milestone_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE binding record; review record; accepted record; council record; submission record;
BEGIN
  SELECT * INTO review FROM public.invoice_milestone_reviews WHERE id=NEW.review_id;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.state='prepared' AND NEW.state='dispatching') THEN
    SELECT d.* INTO accepted FROM public.job_documents d
      JOIN public.quote_revisions q ON q.id=d.quote_revision_id AND q.job_document_id=d.id AND q.job_id=d.job_id
      WHERE d.job_id=NEW.job_id AND d.quote_revision_id=NEW.quote_revision_id
        AND d.type='quote' AND d.sent_at IS NOT NULL AND d.accepted_at IS NOT NULL
        AND d.superseded_at IS NULL AND d.job_contact_id IS NULL AND q.sent_at IS NOT NULL
      FOR SHARE OF d;
    IF NOT FOUND OR (SELECT count(*) FROM public.job_documents d WHERE d.job_id=NEW.job_id
      AND d.type='quote' AND d.sent_at IS NOT NULL AND d.accepted_at IS NOT NULL AND d.superseded_at IS NULL)<>1 THEN
      RAISE EXCEPTION 'Invoice milestone accepted document changed before claim admission';
    END IF;
    IF review.trigger_kind='council_step_complete' THEN
      SELECT * INTO council FROM public.quote_invoice_council_bindings WHERE quote_revision_id=NEW.quote_revision_id AND stage_id=NEW.stage_id;
      SELECT * INTO submission FROM public.council_submissions WHERE id=council.submission_id AND job_id=NEW.job_id FOR SHARE;
      IF council.state IS DISTINCT FROM 'eligible' OR council.org_id IS DISTINCT FROM NEW.org_id OR council.job_id IS DISTINCT FROM NEW.job_id
        OR review.source->>'submission_id' IS DISTINCT FROM council.submission_id::text OR review.source->>'step_id' IS DISTINCT FROM council.step_id::text
        OR (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(submission.steps)='array' THEN submission.steps ELSE '[]'::jsonb END) s WHERE s->>'step_id'=council.step_id::text AND s->>'name'=council.step_name AND s->>'status'='complete' AND s->>'completion_source'='explicit_status_update')<>1 THEN
        RAISE EXCEPTION 'Council billing milestone lacks exact released explicit completion';
      END IF;
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO binding FROM public.quote_invoice_billing_bindings WHERE quote_revision_id=NEW.quote_revision_id;
    SELECT * INTO review FROM public.invoice_milestone_reviews WHERE id=NEW.review_id;
    IF binding.state IS DISTINCT FROM 'eligible' OR binding.org_id IS DISTINCT FROM NEW.org_id
      OR binding.job_id IS DISTINCT FROM NEW.job_id OR binding.xero_contact_id IS DISTINCT FROM NEW.xero_contact_id
      OR review.job_id IS DISTINCT FROM NEW.job_id OR review.org_id IS DISTINCT FROM NEW.org_id
      OR review.accepted_quote_revision_id IS DISTINCT FROM NEW.quote_revision_id OR review.trigger_kind NOT IN ('scheduled','council_step_complete')
      OR NEW.state <> 'prepared' OR NEW.provider_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'Invoice milestone identity is not bound to its released payer and source';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','provider_invoice_id','hold_reason','updated_at','last_reconciled_by','last_reconciled_at'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','provider_invoice_id','hold_reason','updated_at','last_reconciled_by','last_reconciled_at']) THEN
      RAISE EXCEPTION 'Invoice milestone commercial payload is immutable';
    END IF;
    IF OLD.provider_invoice_id IS NOT NULL AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id THEN
      RAISE EXCEPTION 'Invoice milestone provider identity cannot be replaced';
    END IF;
    IF NEW.state='prepared' OR (OLD.state='draft_confirmed' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id)) THEN
      RAISE EXCEPTION 'Invoice milestone dispatch cannot be reset or confirmed result changed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
