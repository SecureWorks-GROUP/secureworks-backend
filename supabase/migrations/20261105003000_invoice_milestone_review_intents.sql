-- Capture and source write are atomic: enqueue failure rejects the source write.
-- WS6 note 41, preparation only. Schedule/council events preserve one held
-- office review intent. No amount, Xero write, authorisation or send is derived.
-- Only an explicitly bound released revision is retained. Existing printed
-- terms lack machine billing triggers. Never use latest/current pricing as authority.
CREATE TABLE public.invoice_milestone_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  accepted_document_id uuid REFERENCES public.job_documents(id) ON DELETE RESTRICT,
  job_contact_id uuid,
  accepted_quote_revision_id uuid REFERENCES public.quote_revisions(id) ON DELETE RESTRICT,
  milestone_key text NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('scheduled', 'council_step_complete')),
  state text NOT NULL DEFAULT 'held' CHECK (state = 'held'),
  hold_reasons text[] NOT NULL CHECK (cardinality(hold_reasons) > 0),
  source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_milestone_reviews_identity UNIQUE NULLS NOT DISTINCT
    (job_id, accepted_document_id, milestone_key)
);
ALTER TABLE public.invoice_milestone_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_milestone_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.invoice_milestone_reviews TO service_role;
CREATE INDEX invoice_milestone_reviews_job_idx
  ON public.invoice_milestone_reviews (org_id, job_id, created_at DESC);

CREATE FUNCTION public.enqueue_invoice_milestone_review(
  p_job_id uuid, p_trigger_kind text, p_milestone_key text, p_source jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  target_job record;
  accepted_doc record;
  found_document boolean := false;
  bound_revision uuid;
  reasons text[];
BEGIN
  SELECT id, org_id, type INTO target_job FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND OR target_job.type NOT IN ('patio', 'fencing') THEN RETURN; END IF;
  FOR accepted_doc IN
    SELECT id, job_contact_id, accepted_at, quote_revision_id FROM public.job_documents
    WHERE job_id = p_job_id AND type = 'quote' AND accepted_at IS NOT NULL
      AND sent_at IS NOT NULL AND superseded_at IS NULL
  LOOP
    found_document := true;
    bound_revision := NULL;
    SELECT id INTO bound_revision FROM public.quote_revisions
    WHERE id = accepted_doc.quote_revision_id AND job_id = p_job_id
      AND job_document_id = accepted_doc.id AND sent_at IS NOT NULL;
    reasons := ARRAY['machine_billing_terms_missing'];
    IF bound_revision IS NULL THEN reasons := reasons || 'accepted_revision_binding_missing'::text; END IF;
    INSERT INTO public.invoice_milestone_reviews
      (org_id, job_id, accepted_document_id, job_contact_id, accepted_quote_revision_id, milestone_key,
       trigger_kind, hold_reasons, source)
    VALUES
      (target_job.org_id, p_job_id, accepted_doc.id, accepted_doc.job_contact_id,
       bound_revision, p_milestone_key, p_trigger_kind, reasons,
       p_source || jsonb_build_object('accepted_at', accepted_doc.accepted_at,
         'accepted_document_is_review_context_only', true))
    ON CONFLICT ON CONSTRAINT invoice_milestone_reviews_identity DO NOTHING;
  END LOOP;
  IF NOT found_document THEN
    INSERT INTO public.invoice_milestone_reviews
      (org_id, job_id, milestone_key, trigger_kind, hold_reasons, source)
    VALUES (target_job.org_id, p_job_id, p_milestone_key, p_trigger_kind,
      ARRAY['accepted_document_missing', 'accepted_revision_binding_missing', 'machine_billing_terms_missing'],
      p_source)
    ON CONFLICT ON CONSTRAINT invoice_milestone_reviews_identity DO NOTHING;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_invoice_milestone_review(uuid,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.capture_scheduled_invoice_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'scheduled' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.enqueue_invoice_milestone_review(NEW.id, 'scheduled', 'scheduled',
      jsonb_build_object('writer', 'jobs.status', 'from_status', OLD.status, 'to_status', NEW.status));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_scheduled_invoice_review() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER invoice_review_when_scheduled AFTER UPDATE OF status ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.capture_scheduled_invoice_review();

CREATE FUNCTION public.capture_council_invoice_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE step jsonb; key text;
BEGIN
  IF NEW.job_id IS NULL OR jsonb_typeof(NEW.steps) IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
  FOR step IN SELECT value FROM jsonb_array_elements(NEW.steps)
  LOOP
    -- A named, completed step is evidence for review, never billing approval.
    -- A workflow jump that only changes current_step_index has no effect.
    IF step->>'status' = 'complete' AND step->>'completion_source' IS DISTINCT FROM 'workflow_jump' AND nullif(btrim(step->>'step_id'), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(OLD.steps) = 'array' THEN OLD.steps ELSE '[]'::jsonb END
        ) old_step
        WHERE old_step->>'step_id' = step->>'step_id' AND old_step->>'status' = 'complete'
          AND old_step->>'completion_source' IS DISTINCT FROM 'workflow_jump'
      ) THEN
      key := 'council_step:' || (step->>'step_id');
      PERFORM public.enqueue_invoice_milestone_review(NEW.job_id, 'council_step_complete', key,
        jsonb_build_object('writer', 'council_submissions.steps', 'submission_id', NEW.id,
          'step_id', step->>'step_id'));
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_council_invoice_review() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER invoice_review_when_council_step_complete AFTER UPDATE OF steps ON public.council_submissions
  FOR EACH ROW EXECUTE FUNCTION public.capture_council_invoice_review();
COMMENT ON TABLE public.invoice_milestone_reviews IS
  'Held office billing-review intents only. No provider draft exists. Exact accepted revision and machine billing terms are required before a future draft consumer may act.';

-- The first-party calendar writes assignments and may leave jobs.status at
-- processing. Capture its live install booking too, sharing the scheduled key.
CREATE FUNCTION public.capture_booking_invoice_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.job_id IS NOT NULL AND NEW.scheduled_date IS NOT NULL
    AND COALESCE(NEW.is_ghost, false) = false
    AND lower(COALESCE(NEW.role, '')) NOT IN ('observer', 'ghost')
    AND lower(COALESCE(NULLIF(NEW.assignment_type, ''), 'install')) = 'install'
    AND NEW.status IN ('scheduled', 'confirmed') THEN
    PERFORM public.enqueue_invoice_milestone_review(NEW.job_id, 'scheduled', 'scheduled',
      jsonb_build_object('writer', 'job_assignments', 'assignment_id', NEW.id));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_booking_invoice_review() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER invoice_review_when_install_booked
  AFTER INSERT OR UPDATE OF status, assignment_type, is_ghost, role, scheduled_date ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.capture_booking_invoice_review();
