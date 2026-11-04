-- Explicit accepted schedule opt-in only. No provider calls or sends in SQL.
CREATE TABLE public.quote_invoice_billing_bindings (
  quote_revision_id uuid PRIMARY KEY REFERENCES public.quote_revisions(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  xero_contact_id uuid,
  state text NOT NULL CHECK (state IN ('eligible','held')),
  hold_reason text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'eligible' AND xero_contact_id IS NOT NULL AND hold_reason IS NULL)
    OR (state = 'held' AND hold_reason IS NOT NULL))
);
ALTER TABLE public.quote_invoice_billing_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_invoice_billing_bindings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.quote_invoice_billing_bindings TO service_role;

CREATE FUNCTION public.pin_quote_invoice_billing_payer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target record; reason text; payer uuid;
BEGIN
  IF NEW.sent_at IS NULL OR NEW.pricing_snapshot_json->'raw'->'billing_milestones' IS NULL THEN RETURN NEW; END IF;
  SELECT id,org_id,type,xero_contact_id,pricing_json INTO target FROM public.jobs WHERE id=NEW.job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  reason := NULL;
  IF target.type NOT IN ('patio','fencing') THEN reason := 'unsupported_job_kind';
  ELSIF NEW.job_document_id IS NULL THEN reason := 'quote_document_unbound';
  ELSIF EXISTS (SELECT 1 FROM public.job_contacts WHERE job_id=NEW.job_id) THEN reason := 'multiple_or_named_payers_require_review';
  ELSIF jsonb_typeof(target.pricing_json->'billing_contact') = 'object'
    AND target.pricing_json->'billing_contact' <> '{}'::jsonb THEN reason := 'billing_contact_override_requires_review';
  ELSIF target.xero_contact_id IS NULL OR target.xero_contact_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN reason := 'verified_xero_payer_missing';
  ELSE payer := target.xero_contact_id::text::uuid;
  END IF;
  INSERT INTO public.quote_invoice_billing_bindings(quote_revision_id,org_id,job_id,xero_contact_id,state,hold_reason)
    VALUES(NEW.id,target.org_id,NEW.job_id,payer,CASE WHEN reason IS NULL THEN 'eligible' ELSE 'held' END,reason)
    ON CONFLICT (quote_revision_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.pin_quote_invoice_billing_payer() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER pin_invoice_payer_when_quote_released
  AFTER INSERT OR UPDATE OF sent_at ON public.quote_revisions
  FOR EACH ROW EXECUTE FUNCTION public.pin_quote_invoice_billing_payer();

CREATE TABLE public.invoice_milestone_draft_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  quote_revision_id uuid NOT NULL REFERENCES public.quote_invoice_billing_bindings(quote_revision_id) ON DELETE RESTRICT,
  review_id uuid NOT NULL REFERENCES public.invoice_milestone_reviews(id) ON DELETE RESTRICT,
  stage_id text NOT NULL CHECK(length(stage_id) BETWEEN 1 AND 100),
  xero_contact_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents > 0 AND amount_cents < 9007199254740991),
  currency text NOT NULL CHECK(currency='AUD'),
  label text NOT NULL CHECK(length(label)>0),
  printed_terms text NOT NULL,
  due_date date NOT NULL,
  reference text NOT NULL UNIQUE,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK(state IN ('prepared','dispatching','unknown','draft_confirmed')),
  provider_invoice_id uuid,
  hold_reason text,
  last_reconciled_by text,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,job_id,quote_revision_id,stage_id),
  CHECK(state <> 'draft_confirmed' OR provider_invoice_id IS NOT NULL)
);
ALTER TABLE public.invoice_milestone_draft_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_milestone_draft_claims FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.invoice_milestone_draft_claims TO service_role;
CREATE FUNCTION public.guard_invoice_milestone_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE binding record; review record; accepted record;
BEGIN
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
REVOKE ALL ON FUNCTION public.guard_invoice_milestone_claim() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_invoice_milestone_claim BEFORE INSERT OR UPDATE ON public.invoice_milestone_draft_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_milestone_claim();
COMMENT ON TABLE public.invoice_milestone_draft_claims IS
  'One durable draft-only dispatch claim per exact accepted revision and stage. Unknown outcomes never reset or automatically create again. Staff reconciliation can only bind an existing matching DRAFT.';
