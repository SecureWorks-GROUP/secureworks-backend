-- Additive authority correction for the 2026-07-24 deterministic make-safe
-- lineage incident. The old source/case ledgers remain immutable audit truth.
-- Runtime reads the effective source authority from the new append-only ledger.
--
-- This migration is deliberately production-data-specific and aborts the whole
-- transaction unless every observed footprint, manifest, AJ source and existing
-- job invariant still matches the reviewed snapshot. It never updates or deletes
-- a source, case, job, assignment, draft, status or communication row.

CREATE TABLE public.makesafe_intake_case_authority_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  legacy_case_id uuid NOT NULL,
  effective_case_id uuid,
  correction_kind text NOT NULL CHECK (
    correction_kind = 'false_po_box'
  ),
  expected_identity_key text,
  legacy_source_count integer NOT NULL CHECK (legacy_source_count >= 0),
  source_manifest_sha256 text NOT NULL CHECK (
    source_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  legacy_instruction_key text NOT NULL,
  legacy_lineage_id uuid NOT NULL,
  legacy_parent_case_id uuid,
  legacy_parent_relation text,
  legacy_cycle integer NOT NULL CHECK (legacy_cycle > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_intake_case_authority_corrections_legacy_fk
    FOREIGN KEY (org_id, legacy_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_authority_corrections_effective_fk
    FOREIGN KEY (org_id, effective_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_case_authority_corrections_shape CHECK (
    (effective_case_id IS NULL) = (expected_identity_key IS NULL)
    AND (legacy_parent_case_id IS NULL) =
      (legacy_parent_relation IS NULL)
  )
);

CREATE UNIQUE INDEX
  uq_makesafe_case_authority_correction_effective
  ON public.makesafe_intake_case_authority_corrections (
    org_id, legacy_case_id, effective_case_id
  )
  WHERE effective_case_id IS NOT NULL;
CREATE UNIQUE INDEX
  uq_makesafe_case_authority_correction_sourceless
  ON public.makesafe_intake_case_authority_corrections (
    org_id, legacy_case_id
  )
  WHERE effective_case_id IS NULL;
CREATE INDEX idx_makesafe_case_authority_correction_effective
  ON public.makesafe_intake_case_authority_corrections (
    org_id, effective_case_id
  )
  WHERE effective_case_id IS NOT NULL;

CREATE TABLE public.makesafe_intake_source_authority_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  source_post_id text NOT NULL
    REFERENCES public.emails(post_id) ON DELETE RESTRICT,
  legacy_case_id uuid,
  effective_case_id uuid,
  target_job_id uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
  correction_kind text NOT NULL CHECK (
    correction_kind IN ('false_po_box', 'existing_job_binding')
  ),
  expected_identity_key text NOT NULL CHECK (
    btrim(expected_identity_key) <> ''
  ),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_intake_source_authority_corrections_source_key
    UNIQUE (org_id, source_post_id),
  CONSTRAINT makesafe_intake_source_authority_corrections_legacy_fk
    FOREIGN KEY (org_id, legacy_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_source_authority_corrections_effective_fk
    FOREIGN KEY (org_id, effective_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_source_authority_corrections_shape CHECK (
    (
      correction_kind = 'false_po_box'
      AND legacy_case_id IS NOT NULL
      AND effective_case_id IS NOT NULL
      AND target_job_id IS NULL
    )
    OR (
      correction_kind = 'existing_job_binding'
      AND legacy_case_id IS NULL
      AND effective_case_id IS NULL
      AND target_job_id IS NOT NULL
    )
  )
);

CREATE INDEX idx_makesafe_source_authority_correction_effective
  ON public.makesafe_intake_source_authority_corrections (
    org_id, effective_case_id
  )
  WHERE effective_case_id IS NOT NULL;
CREATE INDEX idx_makesafe_source_authority_correction_target_job
  ON public.makesafe_intake_source_authority_corrections (
    org_id, target_job_id
  )
  WHERE target_job_id IS NOT NULL;

ALTER TABLE public.makesafe_intake_case_authority_corrections
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.makesafe_intake_source_authority_corrections
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_intake_case_authority_corrections
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.makesafe_intake_source_authority_corrections
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_intake_case_authority_corrections
  TO service_role;
GRANT SELECT ON public.makesafe_intake_source_authority_corrections
  TO service_role;

CREATE POLICY service_role_read_makesafe_case_authority_corrections
  ON public.makesafe_intake_case_authority_corrections
  FOR SELECT TO service_role USING (true);
CREATE POLICY service_role_read_makesafe_source_authority_corrections
  ON public.makesafe_intake_source_authority_corrections
  FOR SELECT TO service_role USING (true);

CREATE TRIGGER trg_makesafe_case_authority_corrections_append_only
  BEFORE UPDATE OR DELETE
  ON public.makesafe_intake_case_authority_corrections
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();
CREATE TRIGGER trg_makesafe_source_authority_corrections_append_only
  BEFORE UPDATE OR DELETE
  ON public.makesafe_intake_source_authority_corrections
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

COMMENT ON TABLE public.makesafe_intake_case_authority_corrections IS
  'Append-only supersession evidence for immutable legacy make-safe case authority. Typed legacy ancestry is retained here when several false-PO authorities converge on one corrected source partition.';
COMMENT ON TABLE public.makesafe_intake_source_authority_corrections IS
  'Append-only runtime overlay from immutable source ownership to one effective case authority or one guarded pre-existing operational job.';

CREATE TEMP TABLE _ms_box_cases ON COMMIT DROP AS
SELECT
  intake_case.id,
  intake_case.org_id,
  intake_case.instruction_key,
  intake_case.lineage_id,
  intake_case.parent_case_id,
  intake_case.parent_relation,
  intake_case.cycle,
  intake_case.company_id,
  intake_case.company_key,
  intake_case.company_slug_raw,
  intake_case.deliverable_ref_canonical,
  intake_case.job_id
FROM public.makesafe_intake_cases intake_case
WHERE intake_case.org_id =
    '00000000-0000-0000-0000-000000000001'::uuid
  AND upper(coalesce(intake_case.builder_po_canonical, '')) = 'BOX';

CREATE TEMP TABLE _ms_box_sources ON COMMIT DROP AS
WITH source_rows AS (
  SELECT
    legacy.id AS legacy_case_id,
    legacy.company_id,
    legacy.company_key,
    legacy.company_slug_raw,
    coalesce(
      legacy.deliverable_ref_canonical,
      'GENERAL_MAKESAFE'
    ) AS deliverable,
    source.post_id,
    email.received_at,
    coalesce(email.subject, '') || E'\n' ||
      coalesce(email.body_content, '') AS hay,
    EXISTS (
      SELECT 1
      FROM public.email_attachments attachment
      WHERE attachment.email_id = source.post_id
        AND attachment.status = 'uploaded'
        AND (
          coalesce(attachment.content_type, '') ~* 'pdf'
          OR coalesce(attachment.name, '') ~* '\.pdf$'
        )
        AND coalesce(attachment.name, '') ~*
          '(work[[:space:]]*order|works[[:space:]]*order|(^|[^A-Z])WO([^A-Z]|$))'
    ) AS designated_attachment
  FROM _ms_box_cases legacy
  JOIN public.makesafe_intake_case_sources source
    ON source.org_id = legacy.org_id
   AND source.case_id = legacy.id
  JOIN public.emails email
    ON email.post_id = source.post_id
),
extracted AS (
  SELECT
    source_rows.*,
    (
      regexp_match(
        hay,
        '\mMLB[-[:space:]#]*(\d{3,})\M',
        'i'
      )
    )[1] AS family_digits,
    (
      regexp_match(
        hay,
        '\mMLB[-[:space:]]*MW[-[:space:]#]*(\d{3,})\M',
        'i'
      )
    )[1] AS mw_digits,
    (
      regexp_match(
        hay,
        '\m(?:work[[:space:]]*order|works[[:space:]]*order|w[[:space:]]*[./]?[[:space:]]*o[[:space:]]*\.?)\s*(?:(?:number|no\.?)\s*[:#-]?|[:#-])\s*([A-Z]{1,10}[[:space:].#_/-]*\d{3,}(?:[.#_/-][A-Z0-9]+)*|\d{3,}(?:[.#_/-][A-Z0-9]+)*)\M',
        'i'
      )
    )[1] AS labelled_wo
  FROM source_rows
),
identities AS (
  SELECT
    extracted.*,
    CASE
      WHEN family_digits IS NOT NULL THEN 'MLB-' || family_digits
      ELSE NULL
    END AS external_ref,
    CASE
      WHEN labelled_wo IS NOT NULL THEN upper(
        regexp_replace(
          regexp_replace(
            labelled_wo,
            '[[:space:]#_/.]+',
            '-',
            'g'
          ),
          '-+',
          '-',
          'g'
        )
      )
      WHEN designated_attachment AND family_digits IS NOT NULL
        THEN 'MLB-' || family_digits
      WHEN mw_digits IS NOT NULL
        AND hay ~* '\m(?:new[[:space:]]+)?work[[:space:]]+order\M'
        THEN 'MLB-MW-' || mw_digits
      ELSE NULL
    END AS builder_wo
  FROM extracted
)
SELECT
  legacy_case_id,
  company_id,
  company_key,
  company_slug_raw,
  deliverable,
  post_id,
  received_at,
  external_ref,
  builder_wo,
  coalesce(
    'wo:' || builder_wo,
    'ref:' || external_ref
  ) AS expected_identity_key
FROM identities;

CREATE TEMP TABLE _ms_box_partitions ON COMMIT DROP AS
SELECT
  gen_random_uuid() AS effective_case_id,
  company_id,
  company_key,
  company_slug_raw,
  external_ref,
  builder_wo,
  deliverable,
  expected_identity_key,
  min(received_at) AS received_at,
  min(post_id) AS primary_post_id,
  count(*)::integer AS source_count,
  encode(
    extensions.digest(
      string_agg(post_id, ',' ORDER BY post_id),
      'sha256'
    ),
    'hex'
  ) AS source_manifest_sha256
FROM _ms_box_sources
GROUP BY
  company_id,
  company_key,
  company_slug_raw,
  external_ref,
  builder_wo,
  deliverable,
  expected_identity_key;

ALTER TABLE _ms_box_partitions
  ADD COLUMN instruction_key text;
UPDATE _ms_box_partitions
SET instruction_key =
  'fingerprint:' || source_manifest_sha256 ||
  '/deliverable:' ||
  CASE
    WHEN builder_wo IS NOT NULL
      THEN 'wo%3A' || builder_wo
    ELSE external_ref || '%3A' || deliverable
  END ||
  '/cycle:1';

CREATE TEMP TABLE _ms_aj_sources (
  post_id text PRIMARY KEY,
  content_sha256 text NOT NULL
) ON COMMIT DROP;
INSERT INTO _ms_aj_sources (post_id, content_sha256) VALUES
  (
    'AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAr9x7QAAA=',
    '1e8f911e5be3b86de64cad02864ae21a9ea3c43052d7ca7d7cc46ffb313b648f'
  ),
  (
    'mailbox_264b5ecbedc4e9de97560c373f5fb9941936cc42186dab6d5336d7bb6fd9650d',
    'e51c82a7d37ca6f866390bb0299cc005fda11d8968fd32222c0aed05ee8cfa7b'
  );

DO $guard$
DECLARE
  v_hash text;
  v_count bigint;
  v_jobs_count bigint;
  v_assignments_count bigint;
  v_drafts_count bigint;
  v_documents_count bigint;
  v_notify_count bigint;
  v_outbound_count bigint;
  v_aj_jobs_hash text;
  v_aj_assignment_hash text;
  v_aj_drafts_hash text;
  v_aj_document_hash text;
BEGIN
  -- A migration-provisioned database has neither the historical BOX footprint
  -- nor the production-only AJ incident rows. Install the correction schema but
  -- do not manufacture production data there. Any environment containing even
  -- one incident coordinate must satisfy the complete guarded snapshot below.
  IF NOT EXISTS (SELECT 1 FROM _ms_box_cases)
    AND NOT EXISTS (
      SELECT 1
      FROM public.emails email
      JOIN _ms_aj_sources expected
        ON expected.post_id = email.post_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.jobs
      WHERE id IN (
        '401b97c8-b5e8-49ff-8202-5be5bb0a1135'::uuid,
        '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
      )
    )
  THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_count FROM _ms_box_cases;
  IF v_count <> 335 THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: expected 335 cases, found %',
      v_count;
  END IF;
  IF (SELECT count(*) FROM _ms_box_cases WHERE job_id IS NOT NULL) <> 0
    OR (
      SELECT count(*)
      FROM _ms_box_cases
      WHERE company_id <>
        '12c26cdb-d1a5-404f-973f-c3dbaff37285'::uuid
        OR company_key <>
          'company:12c26cdb-d1a5-404f-973f-c3dbaff37285'
        OR company_slug_raw <> 'mlb'
    ) <> 0
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: job/company authority changed';
  END IF;
  IF (
    SELECT count(*)
    FROM _ms_box_cases
    WHERE instruction_key !~ '/deliverable:(?:wo%3A[^/]+%2F)?po%3ABOX/cycle:[0-9]+$'
  ) <> 0
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: BOX instruction shape changed';
  END IF;

  SELECT encode(
    extensions.digest(
      string_agg(id::text, ',' ORDER BY id),
      'sha256'
    ),
    'hex'
  )
  INTO v_hash
  FROM _ms_box_cases;
  IF v_hash <>
    'a68ca7336898b806ba09e7343ed0afa0977560e42c737e4def935015da2f686d'
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: case manifest mismatch';
  END IF;

  IF (SELECT count(*) FROM _ms_box_sources) <> 600
    OR (
      SELECT count(*)
      FROM _ms_box_cases legacy
      WHERE NOT EXISTS (
        SELECT 1
        FROM _ms_box_sources source
        WHERE source.legacy_case_id = legacy.id
      )
    ) <> 46
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: expected 600 sources and 46 sourceless cases';
  END IF;
  SELECT encode(
    extensions.digest(
      string_agg(post_id, ',' ORDER BY post_id),
      'sha256'
    ),
    'hex'
  )
  INTO v_hash
  FROM _ms_box_sources;
  IF v_hash <>
    '7d2697dca8a87df9b06d674a0bafac8086435abf77133085000d2b927a5d7697'
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: source manifest mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM _ms_box_sources
    WHERE expected_identity_key IS NULL
      OR builder_wo = 'BOX'
      OR external_ref = 'BOX'
  ) THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: corrected identity missing or still BOX';
  END IF;
  SELECT encode(
    extensions.digest(
      string_agg(
        post_id || '|' || legacy_case_id::text || '|' ||
        coalesce(external_ref, '') || '|' ||
        coalesce(builder_wo, '') || '|' || deliverable,
        ',' ORDER BY post_id
      ),
      'sha256'
    ),
    'hex'
  )
  INTO v_hash
  FROM _ms_box_sources;
  IF v_hash <>
    '07ba10f78e94e98e0b7039c4ca6e487c727d121a3be7708b996d20776a76b808'
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: parsed source identity manifest mismatch';
  END IF;

  IF (SELECT count(*) FROM _ms_box_partitions) <> 294
    OR (SELECT sum(source_count) FROM _ms_box_partitions) <> 600
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: expected 294 corrected partitions over 600 sources';
  END IF;
  SELECT encode(
    extensions.digest(
      string_agg(
        coalesce(company_id::text, '') || '|' ||
        coalesce(external_ref, '') || '|' ||
        coalesce(builder_wo, '') || '|' ||
        deliverable || '|' || source_count::text || '|' ||
        source_manifest_sha256,
        ',' ORDER BY company_id, external_ref, builder_wo, deliverable
      ),
      'sha256'
    ),
    'hex'
  )
  INTO v_hash
  FROM _ms_box_partitions;
  IF v_hash <>
    '2b15f65eea187bbcb60d37ab99574d8dac5629408659fa8fe333ab404cfb5926'
  THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: corrected partition manifest mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM _ms_box_partitions partition
    JOIN public.makesafe_intake_cases existing
      ON existing.org_id =
        '00000000-0000-0000-0000-000000000001'::uuid
     AND existing.instruction_key = partition.instruction_key
  ) THEN
    RAISE EXCEPTION
      'false-PO reconciliation refused: corrected instruction already exists';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_case_authority_corrections
  ) OR EXISTS (
    SELECT 1
    FROM public.makesafe_intake_source_authority_corrections
  ) THEN
    RAISE EXCEPTION
      'lineage reconciliation refused: correction ledger is not empty';
  END IF;

  IF (
    SELECT count(*)
    FROM public.emails email
    JOIN _ms_aj_sources expected
      ON expected.post_id = email.post_id
    WHERE email.mailbox = 'ses@secureworkswa.com.au'
      AND lower(email.from_email) = 'workorders@ajs.build'
      AND email.subject = 'Make Safe - Dianella - Job No 70062'
      AND email.content_sha256 = expected.content_sha256
      AND email.makesafe_scanned_at IS NULL
  ) <> 2
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: SES source manifest changed';
  END IF;
  IF (
    SELECT count(*)
    FROM public.email_attachments attachment
    JOIN _ms_aj_sources expected
      ON expected.post_id = attachment.email_id
    WHERE attachment.name = 'Works Order.pdf'
      AND attachment.status = 'uploaded'
      AND attachment.sha256 =
        'd76df8ef7248120bdb9c4356259234b92fe293df94eb8bdbcb42cbcb7f32e7b0'
  ) <> 2
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: work-order attachment manifest changed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_case_sources source
    JOIN _ms_aj_sources expected
      ON expected.post_id = source.post_id
    WHERE source.org_id =
      '00000000-0000-0000-0000-000000000001'::uuid
  ) THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: source is already accounted';
  END IF;
  IF (
    SELECT count(*)
    FROM public.jobs job
    JOIN public.makesafe_job_details details
      ON details.job_id = job.id
    WHERE job.id = '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
      AND job.org_id =
        '00000000-0000-0000-0000-000000000001'::uuid
      AND job.job_number = 'SWMS-261055'
      AND job.type = 'makesafe'
      AND lower(coalesce(job.status, '')) NOT IN (
        'cancelled', 'canceled', 'void', 'voided', 'superseded'
      )
      AND job.client_name = 'Emma Clingan'
      AND job.client_phone = '0448855228'
      AND regexp_replace(
        lower(coalesce(job.site_address, '')),
        '[^a-z0-9]+',
        '',
        'g'
      ) = '12railtonplacedianellawa6059'
      AND job.metadata ->> 'external_ref' = '70062'
      AND job.metadata ->> 'builder_email_subject' =
        'Make Safe - Dianella - Job No 70062'
      AND details.external_ref = '70062'
      AND lower(coalesce(details.requesting_company_slug, '')) = 'aj'
  ) <> 1
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: SWMS-261055 identity changed';
  END IF;
  IF (
    SELECT count(*)
    FROM public.jobs job
    JOIN public.makesafe_job_details details
      ON details.job_id = job.id
    WHERE job.id = '401b97c8-b5e8-49ff-8202-5be5bb0a1135'::uuid
      AND job.org_id =
        '00000000-0000-0000-0000-000000000001'::uuid
      AND job.job_number = 'SWMS-261054'
      AND job.type = 'makesafe'
      AND lower(coalesce(job.status, '')) IN ('cancelled', 'canceled')
      AND job.metadata ->> 'external_ref' = '70062'
      AND details.external_ref = '70062'
      AND lower(coalesce(details.requesting_company_slug, '')) = 'ajbr'
  ) <> 1
    OR EXISTS (
      SELECT 1
      FROM public.job_assignments assignment
      WHERE assignment.job_id =
        '401b97c8-b5e8-49ff-8202-5be5bb0a1135'::uuid
    )
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: cancelled SWMS-261054 duplicate changed or regained an assignment';
  END IF;
  IF (
    SELECT count(*)
    FROM public.makesafe_intake_drafts draft
    WHERE draft.id =
        'bc114af1-92c1-4f29-adef-2c2b136ea2de'::uuid
      AND draft.org_id =
        '00000000-0000-0000-0000-000000000001'::uuid
      AND draft.graph_message_id =
        'AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAr9x7QAAA='
      AND draft.status = 'approved'
      AND draft.approved_job_id =
        '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
      AND draft.external_ref = '70062'
      AND draft.client_name = 'Emma Clingan'
      AND draft.client_phone = '0448855228'
      AND regexp_replace(
        lower(coalesce(draft.site_address, '')),
        '[^a-z0-9]+',
        '',
        'g'
      ) = '12railtonplacedianellawa6059'
  ) <> 1
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: approved draft bc114af1 no longer proves SWMS-261055';
  END IF;
  IF (
    SELECT count(*)
    FROM public.makesafe_intake_drafts draft
    WHERE draft.id =
        'd2e8a790-f177-4ec1-97ec-258357ff7f14'::uuid
      AND draft.org_id =
        '00000000-0000-0000-0000-000000000001'::uuid
      AND draft.graph_message_id =
        'mailbox_264b5ecbedc4e9de97560c373f5fb9941936cc42186dab6d5336d7bb6fd9650d'
      AND draft.status = 'needs_review'
      AND draft.approved_job_id IS NULL
      AND draft.from_email = 'workorders@ajs.build'
      AND draft.subject = 'Make Safe - Dianella - Job No 70062'
      AND draft.missing_fields @> ARRAY['extraction_down_key_dead']::text[]
  ) <> 1
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: mailbox twin review draft changed';
  END IF;
  IF (
    SELECT count(*)
    FROM public.job_documents document
    WHERE document.job_id =
        '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
      AND document.type = 'work_order'
      AND document.file_name = 'Works Order.pdf'
      AND document.storage_url =
        'makesafe-intake/00a15ca1d98389b5b3584982-b3b242db636a7ec1/Works_Order.pdf'
  ) <> 1
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: SWMS-261055 work-order PDF changed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_cases
    WHERE org_id =
      '00000000-0000-0000-0000-000000000001'::uuid
      AND job_id =
        '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
  ) THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: intake case already links the job';
  END IF;
  IF (
    SELECT count(*)
    FROM public.job_assignments assignment
    WHERE assignment.id =
        'd413fb96-f442-40c0-bdfd-782f54c096fd'::uuid
      AND assignment.job_id =
        '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
      AND assignment.user_id =
        'b353f39a-b3cc-495d-a016-50ebf4a8497d'::uuid
      AND lower(coalesce(assignment.status, '')) NOT IN ('cancelled', 'canceled')
  ) <> 1
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation refused: Hugo assignment changed';
  END IF;

  SELECT count(*) INTO v_jobs_count FROM public.jobs;
  SELECT count(*) INTO v_assignments_count FROM public.job_assignments;
  SELECT count(*) INTO v_drafts_count
    FROM public.makesafe_intake_drafts;
  SELECT count(*) INTO v_documents_count
    FROM public.job_documents;
  SELECT count(*) INTO v_notify_count
    FROM public.makesafe_notify_log;
  SELECT count(*) INTO v_outbound_count
    FROM public.outbound_message_queue;
  SELECT md5(string_agg(
    (
      to_jsonb(job) - 'scope_json' - 'pricing_json'
    )::text || to_jsonb(details)::text,
    ',' ORDER BY job.id
  ))
  INTO v_aj_jobs_hash
  FROM public.jobs job
  JOIN public.makesafe_job_details details
    ON details.job_id = job.id
  WHERE job.id IN (
    '401b97c8-b5e8-49ff-8202-5be5bb0a1135'::uuid,
    '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
  );
  SELECT md5(string_agg(to_jsonb(assignment)::text, ',' ORDER BY assignment.id))
  INTO v_aj_assignment_hash
  FROM public.job_assignments assignment
  WHERE assignment.job_id IN (
    '401b97c8-b5e8-49ff-8202-5be5bb0a1135'::uuid,
    '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
  );
  SELECT md5(string_agg(to_jsonb(draft)::text, ',' ORDER BY draft.id))
  INTO v_aj_drafts_hash
  FROM public.makesafe_intake_drafts draft
  WHERE draft.id IN (
    'bc114af1-92c1-4f29-adef-2c2b136ea2de'::uuid,
    'd2e8a790-f177-4ec1-97ec-258357ff7f14'::uuid
  );
  SELECT md5(string_agg(to_jsonb(document)::text, ',' ORDER BY document.id))
  INTO v_aj_document_hash
  FROM public.job_documents document
  WHERE document.job_id =
    '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid;

  INSERT INTO public.makesafe_intake_cases (
    id,
    org_id,
    instruction_key,
    lineage_id,
    cycle,
    company_id,
    company_slug_raw,
    company_key,
    external_ref_raw,
    external_ref_canonical,
    builder_wo_raw,
    builder_wo_canonical,
    builder_po_raw,
    builder_po_canonical,
    deliverable_ref_raw,
    deliverable_ref_canonical,
    wo_po_identity_key,
    normaliser_version,
    raw_identity_json,
    field_provenance,
    state,
    reason_code,
    is_authoritative,
    side_effects_suppressed,
    last_decision_provenance,
    last_decision_actor,
    last_decision_reason,
    received_at,
    source_fingerprint
  )
  SELECT
    partition.effective_case_id,
    '00000000-0000-0000-0000-000000000001'::uuid,
    partition.instruction_key,
    partition.effective_case_id,
    1,
    partition.company_id,
    partition.company_slug_raw,
    partition.company_key,
    partition.external_ref,
    partition.external_ref,
    partition.builder_wo,
    partition.builder_wo,
    NULL,
    NULL,
    partition.deliverable,
    partition.deliverable,
    CASE
      WHEN partition.builder_wo IS NOT NULL
        THEN 'wo:' || partition.builder_wo
      ELSE NULL
    END,
    'makesafe_refs.normaliseRef+wo_po_precedence@v2+po_box_reconciliation@v1',
    jsonb_strip_nulls(jsonb_build_object(
      'external_ref', partition.external_ref,
      'builder_wo', partition.builder_wo,
      'builder_po', NULL,
      'deliverable', partition.deliverable,
      'correction', 'false_po_box'
    )),
    jsonb_build_object(
      'lineage_reconciliation',
      jsonb_build_object(
        'method', 'backfill',
        'sourcePostId', partition.primary_post_id
      )
    ),
    'exception',
    'adapter_parse_failure',
    true,
    true,
    'backfill',
    'migration:20260724025815',
    'supersede false PO BOX authority without side effects',
    partition.received_at,
    partition.source_manifest_sha256
  FROM _ms_box_partitions partition;

  INSERT INTO public.makesafe_intake_source_authority_corrections (
    org_id,
    source_post_id,
    legacy_case_id,
    effective_case_id,
    correction_kind,
    expected_identity_key,
    evidence
  )
  SELECT
    '00000000-0000-0000-0000-000000000001'::uuid,
    source.post_id,
    source.legacy_case_id,
    partition.effective_case_id,
    'false_po_box',
    source.expected_identity_key,
    jsonb_build_object(
      'legacy_builder_po', 'BOX',
      'effective_source_manifest_sha256',
      partition.source_manifest_sha256,
      'migration', '20260724025815'
    )
  FROM _ms_box_sources source
  JOIN _ms_box_partitions partition
    ON partition.company_id = source.company_id
   AND partition.external_ref IS NOT DISTINCT FROM source.external_ref
   AND partition.builder_wo IS NOT DISTINCT FROM source.builder_wo
   AND partition.deliverable = source.deliverable;

  INSERT INTO public.makesafe_intake_case_authority_corrections (
    org_id,
    legacy_case_id,
    effective_case_id,
    correction_kind,
    expected_identity_key,
    legacy_source_count,
    source_manifest_sha256,
    legacy_instruction_key,
    legacy_lineage_id,
    legacy_parent_case_id,
    legacy_parent_relation,
    legacy_cycle,
    evidence
  )
  SELECT
    '00000000-0000-0000-0000-000000000001'::uuid,
    legacy.id,
    partition.effective_case_id,
    'false_po_box',
    partition.expected_identity_key,
    count(source.post_id)::integer,
    encode(
      extensions.digest(
        string_agg(source.post_id, ',' ORDER BY source.post_id),
        'sha256'
      ),
      'hex'
    ),
    legacy.instruction_key,
    legacy.lineage_id,
    legacy.parent_case_id,
    legacy.parent_relation,
    legacy.cycle,
    jsonb_build_object(
      'legacy_typed_ancestry',
      jsonb_build_object(
        'lineage_id', legacy.lineage_id,
        'parent_case_id', legacy.parent_case_id,
        'parent_relation', legacy.parent_relation,
        'cycle', legacy.cycle
      ),
      'effective_partition_manifest_sha256',
      partition.source_manifest_sha256,
      'migration', '20260724025815'
    )
  FROM _ms_box_cases legacy
  JOIN _ms_box_sources source
    ON source.legacy_case_id = legacy.id
  JOIN _ms_box_partitions partition
    ON partition.company_id = source.company_id
   AND partition.external_ref IS NOT DISTINCT FROM source.external_ref
   AND partition.builder_wo IS NOT DISTINCT FROM source.builder_wo
   AND partition.deliverable = source.deliverable
  GROUP BY
    legacy.id,
    legacy.instruction_key,
    legacy.lineage_id,
    legacy.parent_case_id,
    legacy.parent_relation,
    legacy.cycle,
    partition.effective_case_id,
    partition.expected_identity_key,
    partition.source_manifest_sha256;

  INSERT INTO public.makesafe_intake_case_authority_corrections (
    org_id,
    legacy_case_id,
    effective_case_id,
    correction_kind,
    expected_identity_key,
    legacy_source_count,
    source_manifest_sha256,
    legacy_instruction_key,
    legacy_lineage_id,
    legacy_parent_case_id,
    legacy_parent_relation,
    legacy_cycle,
    evidence
  )
  SELECT
    '00000000-0000-0000-0000-000000000001'::uuid,
    legacy.id,
    NULL,
    'false_po_box',
    NULL,
    0,
    encode(extensions.digest('', 'sha256'), 'hex'),
    legacy.instruction_key,
    legacy.lineage_id,
    legacy.parent_case_id,
    legacy.parent_relation,
    legacy.cycle,
    jsonb_build_object(
      'legacy_typed_ancestry',
      jsonb_build_object(
        'lineage_id', legacy.lineage_id,
        'parent_case_id', legacy.parent_case_id,
        'parent_relation', legacy.parent_relation,
        'cycle', legacy.cycle
      ),
      'superseded_without_sources', true,
      'migration', '20260724025815'
    )
  FROM _ms_box_cases legacy
  WHERE NOT EXISTS (
    SELECT 1
    FROM _ms_box_sources source
    WHERE source.legacy_case_id = legacy.id
  );

  INSERT INTO public.makesafe_intake_source_authority_corrections (
    org_id,
    source_post_id,
    legacy_case_id,
    effective_case_id,
    target_job_id,
    correction_kind,
    expected_identity_key,
    evidence
  )
  SELECT
    '00000000-0000-0000-0000-000000000001'::uuid,
    expected.post_id,
    NULL,
    NULL,
    '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid,
    'existing_job_binding',
    'wo:AJBR-70062',
    jsonb_build_object(
      'job_number', 'SWMS-261055',
      'external_ref', '70062',
      'address_key', '12railtonplacedianellawa6059',
      'approved_draft_id', 'bc114af1-92c1-4f29-adef-2c2b136ea2de',
      'cancelled_duplicate_job_id', '401b97c8-b5e8-49ff-8202-5be5bb0a1135',
      'mailbox_twin_draft_id', 'd2e8a790-f177-4ec1-97ec-258357ff7f14',
      'intake_born_existing_job', true,
      'migration', '20260724025815'
    )
  FROM _ms_aj_sources expected;

  IF (
    SELECT count(*)
    FROM public.makesafe_intake_source_authority_corrections
    WHERE correction_kind = 'false_po_box'
  ) <> 600
    OR (
      SELECT count(*)
      FROM public.makesafe_intake_source_authority_corrections
      WHERE correction_kind = 'existing_job_binding'
    ) <> 2
    OR (
      SELECT count(*)
      FROM public.makesafe_intake_case_authority_corrections
    ) <> 369
  THEN
    RAISE EXCEPTION
      'lineage reconciliation post-check failed: correction counts';
  END IF;
  IF (
    SELECT count(*)
    FROM public.makesafe_intake_cases
    WHERE normaliser_version =
      'makesafe_refs.normaliseRef+wo_po_precedence@v2+po_box_reconciliation@v1'
  ) <> 294
    OR EXISTS (
      SELECT 1
      FROM public.makesafe_intake_source_authority_corrections correction
      JOIN public.makesafe_intake_cases effective
        ON effective.org_id = correction.org_id
       AND effective.id = correction.effective_case_id
      WHERE correction.correction_kind = 'false_po_box'
        AND upper(coalesce(effective.builder_po_canonical, '')) = 'BOX'
    )
  THEN
    RAISE EXCEPTION
      'lineage reconciliation post-check failed: effective case footprint';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_source_authority_corrections
    WHERE correction_kind = 'false_po_box'
    GROUP BY org_id, source_post_id
    HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM public.makesafe_intake_source_authority_corrections
    WHERE correction_kind = 'false_po_box'
    GROUP BY org_id, effective_case_id
    HAVING count(DISTINCT expected_identity_key) <> 1
  ) THEN
    RAISE EXCEPTION
      'lineage reconciliation post-check failed: effective ownership conflict';
  END IF;
  IF (SELECT count(*) FROM public.jobs) <> v_jobs_count
    OR (SELECT count(*) FROM public.job_assignments) <> v_assignments_count
    OR (SELECT count(*) FROM public.makesafe_intake_drafts) <> v_drafts_count
    OR (SELECT count(*) FROM public.job_documents) <> v_documents_count
    OR (SELECT count(*) FROM public.makesafe_notify_log) <> v_notify_count
    OR (SELECT count(*) FROM public.outbound_message_queue) <> v_outbound_count
  THEN
    RAISE EXCEPTION
      'lineage reconciliation post-check failed: side-effect row count changed';
  END IF;
  IF (
    SELECT md5(string_agg(
      (
        to_jsonb(job) - 'scope_json' - 'pricing_json'
      )::text || to_jsonb(details)::text,
      ',' ORDER BY job.id
    ))
    FROM public.jobs job
    JOIN public.makesafe_job_details details
      ON details.job_id = job.id
    WHERE job.id IN (
      '401b97c8-b5e8-49ff-8202-5be5bb0a1135'::uuid,
      '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
    )
  ) IS DISTINCT FROM v_aj_jobs_hash
    OR (
      SELECT md5(
        string_agg(
          to_jsonb(assignment)::text,
          ',' ORDER BY assignment.id
        )
      )
      FROM public.job_assignments assignment
      WHERE assignment.job_id IN (
        '401b97c8-b5e8-49ff-8202-5be5bb0a1135'::uuid,
        '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
      )
    ) IS DISTINCT FROM v_aj_assignment_hash
    OR (
      SELECT md5(
        string_agg(to_jsonb(draft)::text, ',' ORDER BY draft.id)
      )
      FROM public.makesafe_intake_drafts draft
      WHERE draft.id IN (
        'bc114af1-92c1-4f29-adef-2c2b136ea2de'::uuid,
        'd2e8a790-f177-4ec1-97ec-258357ff7f14'::uuid
      )
    ) IS DISTINCT FROM v_aj_drafts_hash
    OR (
      SELECT md5(
        string_agg(to_jsonb(document)::text, ',' ORDER BY document.id)
      )
      FROM public.job_documents document
      WHERE document.job_id =
        '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
    ) IS DISTINCT FROM v_aj_document_hash
  THEN
    RAISE EXCEPTION
      'AJ 70062 reconciliation post-check failed: job, assignment, draft or document changed';
  END IF;
END
$guard$;
