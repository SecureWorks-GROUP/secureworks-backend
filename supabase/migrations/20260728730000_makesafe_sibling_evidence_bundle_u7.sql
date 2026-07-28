-- SES U7 crack family 3: explicit sibling evidence bundles.
--
-- A sibling card may lend delivery, report, SWMS, or invoice evidence only
-- when both directional binding revisions are current, bound, share one
-- bundle_id, and the claiming direction has an exact positive evidence claim.
-- Freeform notes and address/reference similarity remain candidate hints only.

CREATE TABLE public.makesafe_sibling_bundle_binding_revisions (
  id uuid PRIMARY KEY,
  bundle_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  sibling_job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('bound', 'revoked')),
  supersedes_binding_revision_id uuid UNIQUE
    REFERENCES public.makesafe_sibling_bundle_binding_revisions(id)
    ON DELETE RESTRICT,
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  recorded_via text NOT NULL CHECK (length(btrim(recorded_via)) > 0),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND
    provenance <> '{}'::jsonb
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT makesafe_sibling_bundle_distinct_jobs
    CHECK (job_id <> sibling_job_id)
);

CREATE INDEX idx_makesafe_sibling_bundle_binding_current
  ON public.makesafe_sibling_bundle_binding_revisions
  (org_id, job_id, sibling_job_id, recorded_at DESC, id DESC);

CREATE INDEX idx_makesafe_sibling_bundle_binding_reverse
  ON public.makesafe_sibling_bundle_binding_revisions
  (org_id, sibling_job_id, job_id, recorded_at DESC, id DESC);

CREATE TABLE public.makesafe_sibling_evidence_claims (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
  binding_revision_id uuid NOT NULL UNIQUE
    REFERENCES public.makesafe_sibling_bundle_binding_revisions(id)
    ON DELETE RESTRICT,
  invoice_id uuid NOT NULL
    REFERENCES public.xero_invoices(id) ON DELETE RESTRICT,
  invoice_line_item_id text NOT NULL
    CHECK (length(btrim(invoice_line_item_id)) > 0),
  invoice_scope_phrase text NOT NULL
    CHECK (length(btrim(invoice_scope_phrase)) >= 8),
  delivery_email_post_id text NOT NULL
    REFERENCES public.emails(post_id) ON DELETE RESTRICT,
  delivery_email_content_sha256 text NOT NULL
    CHECK (delivery_email_content_sha256 ~ '^[0-9a-f]{64}$'),
  delivery_scope_phrase text NOT NULL
    CHECK (length(btrim(delivery_scope_phrase)) >= 8),
  report_document_id uuid NOT NULL
    REFERENCES public.job_documents(id) ON DELETE RESTRICT,
  swms_document_id uuid NOT NULL
    REFERENCES public.job_documents(id) ON DELETE RESTRICT,
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  recorded_via text NOT NULL CHECK (length(btrim(recorded_via)) > 0),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND
    provenance <> '{}'::jsonb
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.validate_makesafe_sibling_bundle_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.jobs claiming
    JOIN public.jobs sibling
      ON sibling.id = NEW.sibling_job_id
     AND sibling.org_id = NEW.org_id
    WHERE claiming.id = NEW.job_id
      AND claiming.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'bundle binding jobs must belong to org %', NEW.org_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supersedes_binding_revision_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.makesafe_sibling_bundle_binding_revisions prior
       WHERE prior.id = NEW.supersedes_binding_revision_id
         AND prior.bundle_id = NEW.bundle_id
         AND prior.org_id = NEW.org_id
         AND prior.job_id = NEW.job_id
         AND prior.sibling_job_id = NEW.sibling_job_id
     )
  THEN
    RAISE EXCEPTION 'superseded binding must be the same directed relationship'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_makesafe_sibling_evidence_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.makesafe_sibling_bundle_binding_revisions binding
    JOIN public.xero_invoices invoice
      ON invoice.id = NEW.invoice_id
     AND invoice.org_id = NEW.org_id
     AND invoice.job_id = binding.sibling_job_id
     AND upper(invoice.status) IN ('AUTHORISED', 'PAID')
    JOIN public.emails delivery
      ON delivery.post_id = NEW.delivery_email_post_id
     AND delivery.content_sha256 = NEW.delivery_email_content_sha256
     AND delivery.has_attachments IS TRUE
     AND position(
       lower(NEW.delivery_scope_phrase) IN lower(
         coalesce(delivery.subject, '') || ' ' ||
         coalesce(delivery.body_preview, '')
       )
     ) > 0
    JOIN public.job_documents report
      ON report.id = NEW.report_document_id
     AND report.job_id = binding.sibling_job_id
     AND lower(report.type) IN ('report', 'makesafe_report')
    JOIN public.job_documents swms
      ON swms.id = NEW.swms_document_id
     AND swms.job_id = binding.sibling_job_id
     AND lower(swms.type) = 'swms'
    WHERE binding.id = NEW.binding_revision_id
      AND binding.org_id = NEW.org_id
      AND binding.state = 'bound'
      AND EXISTS (
        SELECT 1
        FROM public.makesafe_sibling_bundle_binding_revisions reverse_binding
        WHERE reverse_binding.org_id = binding.org_id
          AND reverse_binding.bundle_id = binding.bundle_id
          AND reverse_binding.job_id = binding.sibling_job_id
          AND reverse_binding.sibling_job_id = binding.job_id
          AND reverse_binding.state = 'bound'
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(coalesce(invoice.line_items, '[]'::jsonb)) item
        WHERE coalesce(
            item->>'LineItemID',
            item->>'LineItemId',
            item->>'lineItemID',
            item->>'line_item_id',
            item->>'id'
          ) = NEW.invoice_line_item_id
          AND position(
            lower(NEW.invoice_scope_phrase) IN lower(coalesce(
              item->>'Description',
              item->>'description',
              ''
            ))
          ) > 0
      )
  ) THEN
    RAISE EXCEPTION
      'sibling evidence claim must positively match its bound sibling invoice line, delivery, report and SWMS'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_makesafe_sibling_bundle_binding_validate
  BEFORE INSERT
  ON public.makesafe_sibling_bundle_binding_revisions
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_makesafe_sibling_bundle_binding();

CREATE TRIGGER trg_makesafe_sibling_evidence_claim_validate
  BEFORE INSERT
  ON public.makesafe_sibling_evidence_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_makesafe_sibling_evidence_claim();

CREATE OR REPLACE FUNCTION public.reject_makesafe_sibling_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER trg_makesafe_sibling_bundle_binding_append_only
  BEFORE UPDATE OR DELETE
  ON public.makesafe_sibling_bundle_binding_revisions
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_makesafe_sibling_evidence_mutation();

CREATE TRIGGER trg_makesafe_sibling_evidence_claim_append_only
  BEFORE UPDATE OR DELETE
  ON public.makesafe_sibling_evidence_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_makesafe_sibling_evidence_mutation();

ALTER TABLE public.makesafe_sibling_bundle_binding_revisions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.makesafe_sibling_evidence_claims
  ENABLE ROW LEVEL SECURITY;

CREATE POLICY makesafe_sibling_bundle_binding_service_role_only
  ON public.makesafe_sibling_bundle_binding_revisions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY makesafe_sibling_evidence_claim_service_role_only
  ON public.makesafe_sibling_evidence_claims
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.makesafe_sibling_bundle_binding_revisions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_sibling_evidence_claims
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.makesafe_sibling_bundle_binding_revisions
  TO service_role;
GRANT SELECT, INSERT ON public.makesafe_sibling_evidence_claims
  TO service_role;

COMMENT ON TABLE public.makesafe_sibling_bundle_binding_revisions IS
  'Append-only directed bundle bindings. U4 accepts sharing only when the current reverse direction is also bound under the same bundle_id.';
COMMENT ON TABLE public.makesafe_sibling_evidence_claims IS
  'Exact positive delivery, invoice-line, report, and SWMS evidence for one directed bundle binding. Similar addresses or loose notes are never claims.';

-- Reviewed production repair for MLB-26393 at 71 Peppermint Way:
-- SWMS-26832's Hardie stacking work was delivered and billed in the
-- SWMS-26837 bundle. Both directions establish the relationship; only the
-- SWMS-26832 -> SWMS-26837 direction claims the sibling-held evidence.
INSERT INTO public.makesafe_sibling_bundle_binding_revisions (
  id,
  bundle_id,
  org_id,
  job_id,
  sibling_job_id,
  state,
  recorded_by,
  recorded_via,
  provenance,
  recorded_at
) VALUES
(
  '7dcf8954-5f8c-412b-898e-bc92987e44fc',
  '1cd35292-1eb7-438f-bf6e-8dbcdf3fb135',
  '00000000-0000-0000-0000-000000000001',
  'c3afc061-0d4a-43ff-8309-0b8b512e307a',
  '02f614a4-09a7-422e-9381-c89a44aceccd',
  'bound',
  'ses-sibling-evidence-v1',
  'reviewed_migration:20260728730000',
  jsonb_build_object(
    'source', 'ses-u7-whole-board-sweep-v1',
    'reason', 'SWMS-26832 delivery and billing are held on SWMS-26837',
    'verified_at', '2026-07-28T04:00:00Z'
  ),
  '2026-07-28T04:00:00Z'
),
(
  'a2ebb22e-6f46-463d-87c8-7e7ec71cd399',
  '1cd35292-1eb7-438f-bf6e-8dbcdf3fb135',
  '00000000-0000-0000-0000-000000000001',
  '02f614a4-09a7-422e-9381-c89a44aceccd',
  'c3afc061-0d4a-43ff-8309-0b8b512e307a',
  'bound',
  'ses-sibling-evidence-v1',
  'reviewed_migration:20260728730000',
  jsonb_build_object(
    'source', 'ses-u7-whole-board-sweep-v1',
    'reason', 'Reciprocal binding for the SWMS-26832 and SWMS-26837 bundle',
    'verified_at', '2026-07-28T04:00:00Z'
  ),
  '2026-07-28T04:00:00Z'
);

INSERT INTO public.makesafe_sibling_evidence_claims (
  id,
  org_id,
  binding_revision_id,
  invoice_id,
  invoice_line_item_id,
  invoice_scope_phrase,
  delivery_email_post_id,
  delivery_email_content_sha256,
  delivery_scope_phrase,
  report_document_id,
  swms_document_id,
  recorded_by,
  recorded_via,
  provenance,
  recorded_at
) VALUES (
  '50413165-579d-40d6-9cc6-bff4f518e4e3',
  '00000000-0000-0000-0000-000000000001',
  '7dcf8954-5f8c-412b-898e-bc92987e44fc',
  '3be46700-4d5d-4b91-b96e-8baf43ac9d7c',
  'edcaa56c-84d5-4a12-be0d-032bd1d422f3',
  'Hardie panel stacking',
  'AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAbMo76AAA=',
  '0be5b5d7d6c7d921a3976a5332b326989e83cf36cb2653b6c349ac68ef4bceba',
  'displaced Hardie panels stacked safely',
  '513cb62a-4f9f-4fd5-ae5c-66b0ce053448',
  '878641fc-99ba-4f5f-a0a6-d64708394b6a',
  'ses-sibling-evidence-v1',
  'reviewed_migration:20260728730000',
  jsonb_build_object(
    'source', 'ses-u7-whole-board-sweep-v1',
    'invoice_number', 'INV-0835',
    'delivery_subject', 'MLB-26393 - 71 Peppermint Way, Eaton',
    'claiming_card_scope', 'Stack displaced Hardie panels neatly and safely on site',
    'coverage_basis', 'Invoice line and delivery email both expressly name the Hardie stacking work',
    'verified_at', '2026-07-28T04:00:00Z'
  ),
  '2026-07-28T04:00:00Z'
);
