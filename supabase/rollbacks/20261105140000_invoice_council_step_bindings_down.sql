-- Preserve exact council bindings; restore installation-only claim admission.
DROP TRIGGER IF EXISTS pin_council_invoice_step_when_quote_released ON public.quote_revisions;
DROP FUNCTION IF EXISTS public.pin_quote_invoice_council_step();
CREATE OR REPLACE FUNCTION public.guard_invoice_milestone_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE binding record; review record; accepted record;
BEGIN
  SELECT * INTO review FROM public.invoice_milestone_reviews WHERE id=NEW.review_id;
  IF (TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.state='prepared' AND NEW.state='dispatching')) AND review.trigger_kind IS DISTINCT FROM 'scheduled' THEN RAISE EXCEPTION 'Council draft dispatch held after rollback'; END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.state='prepared' AND NEW.state='dispatching') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.org_id::text||':'||NEW.job_id::text,0));
    IF EXISTS(SELECT 1 FROM public.invoice_milestone_draft_claims c WHERE c.org_id=NEW.org_id AND c.job_id=NEW.job_id AND c.quote_revision_id<>NEW.quote_revision_id) THEN
      RAISE EXCEPTION 'Invoice claim from an earlier accepted revision requires office review';
    END IF;
    IF EXISTS(SELECT 1 FROM public.job_documents d WHERE d.job_id=NEW.job_id AND d.type='quote' AND d.accepted_at IS NOT NULL AND (d.id IS DISTINCT FROM (SELECT accepted_document_id FROM public.invoice_milestone_reviews WHERE id=NEW.review_id) OR d.quote_revision_id IS DISTINCT FROM NEW.quote_revision_id)) THEN
      RAISE EXCEPTION 'Accepted replacement quote requires office review';
    END IF;
    SELECT d.* INTO accepted FROM public.job_documents d
      JOIN public.quote_revisions q ON q.id=d.quote_revision_id AND q.job_document_id=d.id AND q.job_id=d.job_id
      WHERE d.job_id=NEW.job_id AND d.quote_revision_id=NEW.quote_revision_id
        AND d.type='quote' AND d.sent_at IS NOT NULL AND d.accepted_at IS NOT NULL
        AND d.superseded_at IS NULL AND d.job_contact_id IS NULL AND q.sent_at IS NOT NULL AND d.accepted_at>=q.sent_at
      FOR SHARE OF d;
    IF NOT FOUND OR (SELECT count(*) FROM public.job_documents d WHERE d.job_id=NEW.job_id
      AND d.type='quote' AND d.sent_at IS NOT NULL AND d.accepted_at IS NOT NULL AND d.superseded_at IS NULL)<>1 THEN
      RAISE EXCEPTION 'Invoice milestone accepted document changed before claim admission';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO binding FROM public.quote_invoice_billing_bindings WHERE quote_revision_id=NEW.quote_revision_id;
    SELECT * INTO review FROM public.invoice_milestone_reviews WHERE id=NEW.review_id;
    IF binding.state IS DISTINCT FROM 'eligible' OR binding.org_id IS DISTINCT FROM NEW.org_id
      OR binding.job_id IS DISTINCT FROM NEW.job_id OR binding.xero_contact_id IS DISTINCT FROM NEW.xero_contact_id
      OR review.job_id IS DISTINCT FROM NEW.job_id OR review.org_id IS DISTINCT FROM NEW.org_id
      OR review.accepted_quote_revision_id IS DISTINCT FROM NEW.quote_revision_id OR review.trigger_kind IS DISTINCT FROM 'scheduled'
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
