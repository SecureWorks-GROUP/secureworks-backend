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
REVOKE ALL ON public.quote_invoice_billing_bindings FROM service_role;
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
REVOKE ALL ON public.invoice_milestone_draft_claims FROM service_role;
GRANT SELECT,INSERT,UPDATE ON public.invoice_milestone_draft_claims TO service_role;
CREATE FUNCTION public.guard_invoice_milestone_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE binding record; review record; accepted record;
BEGIN
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
        AND d.type='quote' AND d.run_label IS NULL AND d.sent_at IS NOT NULL AND d.accepted_at IS NOT NULL
        AND d.superseded_at IS NULL AND d.job_contact_id IS NULL AND q.sent_at IS NOT NULL AND d.accepted_at>=q.sent_at AND d.accepted_at>=d.sent_at
      FOR SHARE OF d;
    IF NOT FOUND OR (SELECT count(*) FROM public.job_documents d WHERE d.job_id=NEW.job_id
      AND d.type='quote' AND d.run_label IS NULL AND d.sent_at IS NOT NULL AND d.accepted_at IS NOT NULL AND d.superseded_at IS NULL)<>1 THEN
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

-- Admission holds are durable review context, never a payable obligation.
CREATE FUNCTION public.record_invoice_milestone_admission_hold(p_review_id uuid,p_org_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_reason NOT IN ('previous_revision_invoice_claim_requires_review','existing_invoice_requires_review','invoice_inventory_unavailable','accepted_replacement_requires_review') THEN RAISE EXCEPTION 'Unknown invoice admission hold'; END IF;
 UPDATE public.invoice_milestone_reviews SET hold_reasons=ARRAY(SELECT DISTINCT unnest(hold_reasons||ARRAY[p_reason])) WHERE id=p_review_id AND org_id=p_org_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invoice admission review missing'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.record_invoice_milestone_admission_hold(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_milestone_admission_hold(uuid,uuid,text) TO service_role;

CREATE TABLE public.quote_invoice_deposit_receipts (
 org_id uuid NOT NULL,
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
 quote_revision_id uuid NOT NULL REFERENCES public.quote_revisions(id) ON DELETE RESTRICT,
 accepted_document_id uuid NOT NULL REFERENCES public.job_documents(id) ON DELETE RESTRICT,
 provider_invoice_id uuid NOT NULL,
 xero_contact_id uuid NOT NULL,
 stage_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<9007199254740991),
 reference text NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,provider_invoice_id),
 UNIQUE(org_id,job_id,quote_revision_id,accepted_document_id,stage_id)
);
ALTER TABLE public.quote_invoice_deposit_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_invoice_deposit_receipts FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.quote_invoice_deposit_receipts FROM service_role;
GRANT SELECT,INSERT ON public.quote_invoice_deposit_receipts TO service_role;
CREATE FUNCTION public.guard_quote_invoice_deposit_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE binding record; doc record; revision record; payment jsonb;
BEGIN
 SELECT * INTO binding FROM public.quote_invoice_billing_bindings WHERE quote_revision_id=NEW.quote_revision_id;
 SELECT * INTO doc FROM public.job_documents WHERE id=NEW.accepted_document_id;
 SELECT * INTO revision FROM public.quote_revisions WHERE id=NEW.quote_revision_id;
 payment:=revision.pricing_snapshot_json->'raw'->'payment_schedule'->'payments'->0;
 IF binding.state IS DISTINCT FROM 'eligible' OR binding.org_id IS DISTINCT FROM NEW.org_id OR binding.job_id IS DISTINCT FROM NEW.job_id OR binding.xero_contact_id IS DISTINCT FROM NEW.xero_contact_id
  OR doc.type IS DISTINCT FROM 'quote' OR doc.run_label IS NOT NULL OR doc.job_id IS DISTINCT FROM NEW.job_id OR doc.quote_revision_id IS DISTINCT FROM NEW.quote_revision_id OR doc.accepted_at IS NULL OR doc.sent_at IS NULL OR doc.superseded_at IS NOT NULL OR doc.job_contact_id IS NOT NULL OR doc.accepted_at<revision.sent_at OR doc.accepted_at<doc.sent_at
  OR revision.job_id IS DISTINCT FROM NEW.job_id OR revision.job_document_id IS DISTINCT FROM NEW.accepted_document_id OR revision.sent_at IS NULL
  OR payment->>'id' IS DISTINCT FROM NEW.stage_id OR jsonb_typeof(payment->'amount_inc_gst') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'Accepted deposit receipt lacks exact released first-stage binding';
 END IF;
 IF (payment->>'amount_inc_gst')::numeric*100 IS DISTINCT FROM NEW.amount_cents::numeric THEN RAISE EXCEPTION 'Accepted deposit receipt amount differs from printed first stage'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_quote_invoice_deposit_receipt() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_quote_invoice_deposit_receipt BEFORE INSERT ON public.quote_invoice_deposit_receipts FOR EACH ROW EXECUTE FUNCTION public.guard_quote_invoice_deposit_receipt();

CREATE FUNCTION public.reject_invoice_evidence_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Invoice evidence is immutable and cannot be erased'; END $$;
REVOKE ALL ON FUNCTION public.reject_invoice_evidence_mutation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER immutable_quote_invoice_billing_binding BEFORE UPDATE OR DELETE ON public.quote_invoice_billing_bindings FOR EACH ROW EXECUTE FUNCTION public.reject_invoice_evidence_mutation();
CREATE TRIGGER immutable_quote_invoice_deposit_receipt BEFORE UPDATE OR DELETE ON public.quote_invoice_deposit_receipts FOR EACH ROW EXECUTE FUNCTION public.reject_invoice_evidence_mutation();
CREATE TRIGGER preserve_invoice_milestone_claim BEFORE DELETE ON public.invoice_milestone_draft_claims FOR EACH ROW EXECUTE FUNCTION public.reject_invoice_evidence_mutation();

REVOKE ALL ON public.invoice_milestone_reviews FROM service_role;
GRANT SELECT,INSERT ON public.invoice_milestone_reviews TO service_role;
CREATE TRIGGER preserve_invoice_milestone_review BEFORE DELETE ON public.invoice_milestone_reviews FOR EACH ROW EXECUTE FUNCTION public.reject_invoice_evidence_mutation();
