-- Track A D1 completion: the last of the 336 poisoned false-PO intake
-- identities. Round one (20260724025815) reconciled the 335 po:BOX cases into
-- append-only corrected authority; production probes on 2026-07-30 confirm all
-- 335 remain covered and exactly one poisoned case is left: po:SENT, minted
-- when the retired permissive planner regex read the MLB chaser line
-- "Do we have an install date. PO sent 24/6." as a purchase order.
--
-- This migration re-derives that case's identity from its raw sources under
-- the v2 grammar (a canonical PO requires digits directly after the label, so
-- "PO sent 24/6" yields no PO and the subject yields claim MLB-24481), then
-- binds its two transport rows to the corrected MLB-24481 general-makesafe
-- authority that round one already persisted, using the same append-only
-- ledgers and the same expected-identity convention (ref:MLB-24481).
--
-- Like round one it is deliberately production-data-specific: every observed
-- footprint must still match the reviewed 2026-07-30 snapshot or the whole
-- transaction aborts. It never updates or deletes a source, case, job,
-- assignment, draft, status or communication row. Migration-provisioned
-- databases (fresh supabase start, preview branches, CI) get the schema
-- change only and skip the data correction.

-- The correction kind vocabulary gains 'false_po_sent'. The original CHECK
-- constraint names are the deterministic 63-byte truncations Postgres
-- generated for the inline column constraints in 20260724025815.
ALTER TABLE public.makesafe_intake_case_authority_corrections
  DROP CONSTRAINT
    makesafe_intake_case_authority_correction_correction_kind_check;
ALTER TABLE public.makesafe_intake_case_authority_corrections
  ADD CONSTRAINT makesafe_case_authority_correction_kind_check CHECK (
    correction_kind IN ('false_po_box', 'false_po_sent')
  );

ALTER TABLE public.makesafe_intake_source_authority_corrections
  DROP CONSTRAINT
    makesafe_intake_source_authority_correcti_correction_kind_check;
ALTER TABLE public.makesafe_intake_source_authority_corrections
  ADD CONSTRAINT makesafe_source_authority_correction_kind_check CHECK (
    correction_kind IN ('false_po_box', 'false_po_sent', 'existing_job_binding')
  );

-- A false_po_sent source correction carries the same shape as false_po_box:
-- legacy case, effective case, no target job.
ALTER TABLE public.makesafe_intake_source_authority_corrections
  DROP CONSTRAINT makesafe_intake_source_authority_corrections_shape;
ALTER TABLE public.makesafe_intake_source_authority_corrections
  ADD CONSTRAINT makesafe_intake_source_authority_corrections_shape CHECK (
    (
      correction_kind IN ('false_po_box', 'false_po_sent')
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
  );

DO $sent$
DECLARE
  c_org constant uuid := '00000000-0000-0000-0000-000000000001';
  c_company constant uuid := '12c26cdb-d1a5-404f-973f-c3dbaff37285';
  c_legacy_case constant uuid := '34848e85-dda7-44b0-8abd-cca721ea2068';
  c_effective_case constant uuid := '5d252e8a-6883-45dd-97fd-61ef4cb50785';
  c_lineage constant uuid := '1d56955c-196f-4e20-b429-4b8cf64f0755';
  c_post_graph constant text :=
    'AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAlSHoLAAA=';
  c_post_mailbox constant text :=
    'mailbox_110e772e20035f54aa682c52c4994e55960a8933a17c7ac0b81321c0d75d296e';
  c_sha_graph constant text :=
    '15a651a773cc63b7246e12bf260f5dd1fbca854e526d5ae06d04dd18024a4ceb';
  c_sha_mailbox constant text :=
    '4ee49c54dfa40c69f4cfb8b75509e227e90d08f9c92ffc5a75352b4310da85fa';
  c_subject constant text :=
    'Our Ref: MLB-24481 - 29 Gymea Ct, Armadale - Client Ref: 13330402 - Other Ref:';
  c_expected_key constant text := 'ref:MLB-24481';
  -- The v2 canonical PO grammar (makesafe_builder_work_order_identity.ts
  -- PO_RE) as a Postgres ARE: the label, an optional number/no tail, then the
  -- digits DIRECTLY. "PO sent 24/6" cannot match; "PO Box 2143" cannot match.
  c_v2_po_grammar constant text :=
    '\m(?:p[[:space:]]*o|purchase[[:space:]]+order)(?:[[:space:]]*(?:number|no\.?))?[[:space:]]*[:#-]?[[:space:]]*[0-9]{3,}\M';
  v_count bigint;
  v_manifest text;
BEGIN
  -- A migration-provisioned database has no production footprint: install the
  -- widened correction vocabulary above, manufacture nothing here.
  IF NOT EXISTS (
    SELECT 1 FROM public.makesafe_intake_cases
    WHERE org_id = c_org AND id = c_legacy_case
  ) THEN
    RETURN;
  END IF;

  -- Idempotence: a completed prior run is a no-op, a partial one is corruption.
  SELECT (
    SELECT count(*) FROM public.makesafe_intake_case_authority_corrections
    WHERE correction_kind = 'false_po_sent'
  ) + (
    SELECT count(*) FROM public.makesafe_intake_source_authority_corrections
    WHERE correction_kind = 'false_po_sent'
  ) INTO v_count;
  IF v_count = 3 THEN
    RETURN;
  ELSIF v_count <> 0 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: partial correction ledger (% rows)',
      v_count;
  END IF;

  -- The legacy SENT case must still match the reviewed snapshot exactly.
  IF (
    SELECT count(*) FROM public.makesafe_intake_cases c
    WHERE c.org_id = c_org
      AND c.id = c_legacy_case
      AND c.instruction_key =
        'fingerprint:2008d8d56cdfe92d/deliverable:po%3ASENT/cycle:1'
      AND c.company_id = c_company
      AND c.company_slug_raw = 'mlb'
      AND c.external_ref_canonical = 'MLB-24481'
      AND c.builder_wo_canonical IS NULL
      AND upper(c.builder_po_raw) = 'SENT'
      AND c.builder_po_canonical = 'SENT'
      AND c.wo_po_identity_key = 'po:SENT'
      AND c.deliverable_ref_canonical = 'GENERAL_MAKESAFE'
      AND c.state = 'exception'
      AND c.job_id IS NULL
      AND c.lineage_id = c_lineage
      AND c.parent_case_id = c_lineage
      AND c.parent_relation = 'sibling_of'
      AND c.cycle = 1
  ) <> 1 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: legacy case snapshot changed';
  END IF;

  -- The whole poisoned population must still be the audited 336: exactly one
  -- SENT, exactly 335 BOX, none of them live, every BOX case already covered
  -- by the round-one authority correction ledger.
  IF (
    SELECT count(*) FROM public.makesafe_intake_cases
    WHERE upper(coalesce(builder_po_canonical, '')) = 'SENT'
  ) <> 1 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: SENT population changed';
  END IF;
  IF (
    SELECT count(*) FROM public.makesafe_intake_cases
    WHERE upper(coalesce(builder_po_canonical, '')) = 'BOX'
  ) <> 335 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: BOX population changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.makesafe_intake_cases
    WHERE upper(coalesce(builder_po_canonical, '')) IN ('BOX', 'SENT')
      AND job_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: a poisoned identity reached a live job';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.makesafe_intake_cases c
    WHERE upper(coalesce(c.builder_po_canonical, '')) = 'BOX'
      AND NOT EXISTS (
        SELECT 1 FROM public.makesafe_intake_case_authority_corrections cor
        WHERE cor.org_id = c.org_id AND cor.legacy_case_id = c.id
      )
  ) THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: round-one BOX coverage regressed';
  END IF;

  -- The legacy case owns exactly its two transport rows and nothing else owns
  -- them; both emails still carry the reviewed content, and neither has any
  -- attachment (so no designated work-order PDF can upgrade the identity).
  IF (
    SELECT count(*) FROM public.makesafe_intake_case_sources s
    WHERE s.org_id = c_org AND s.case_id = c_legacy_case
  ) <> 2 OR (
    SELECT count(*) FROM public.makesafe_intake_case_sources s
    WHERE s.org_id = c_org
      AND s.case_id = c_legacy_case
      AND (
        (s.post_id = c_post_graph AND s.role = 'original')
        OR (s.post_id = c_post_mailbox AND s.role = 'resend')
      )
  ) <> 2 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: legacy source ownership changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.makesafe_intake_case_sources s
    WHERE s.post_id IN (c_post_graph, c_post_mailbox)
      AND s.case_id <> c_legacy_case
  ) THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: source rows have another owner';
  END IF;
  IF (
    SELECT count(*) FROM public.emails e
    WHERE e.mailbox = 'ses@secureworkswa.com.au'
      AND lower(e.from_email) = 'mlb.mailer@primeeco.tech'
      AND e.subject = c_subject
      AND (
        (e.post_id = c_post_graph AND e.content_sha256 = c_sha_graph)
        OR (e.post_id = c_post_mailbox AND e.content_sha256 = c_sha_mailbox)
      )
  ) <> 2 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: source email manifest changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.email_attachments
    WHERE email_id IN (c_post_graph, c_post_mailbox)
  ) THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: unexpected attachment on a source';
  END IF;

  -- The re-derivation itself: under the v2 grammar neither source text parses
  -- a PO, and both name claim MLB-24481. If a parseable PO ever appears here,
  -- this correction would be wrong, so refuse.
  IF (
    SELECT count(*) FROM public.emails e
    WHERE e.post_id IN (c_post_graph, c_post_mailbox)
      AND NOT (
        (coalesce(e.subject, '') || E'\n' || coalesce(e.body_content, ''))
          ~* c_v2_po_grammar
      )
      AND (
        regexp_match(
          coalesce(e.subject, '') || E'\n' || coalesce(e.body_content, ''),
          '\mMLB[-[:space:]#]*([0-9]{3,})\M',
          'i'
        )
      )[1] = '24481'
  ) <> 2 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: v2 re-derivation no longer holds';
  END IF;

  -- The corrected authority is the round-one MLB-24481 general-makesafe
  -- partition, unchanged, still exception-lane, with its two round-one source
  -- corrections and no second-round supersession touching it.
  IF (
    SELECT count(*) FROM public.makesafe_intake_cases c
    WHERE c.org_id = c_org
      AND c.id = c_effective_case
      AND c.instruction_key =
        'fingerprint:5edb3fc06861c499b09fe83ba1860c17bc5e363a47733e94462a607b9ddb87fb/deliverable:MLB-24481%3AGENERAL_MAKESAFE/cycle:1'
      AND c.company_id = c_company
      AND c.external_ref_canonical = 'MLB-24481'
      AND c.builder_wo_canonical IS NULL
      AND c.builder_po_canonical IS NULL
      AND c.deliverable_ref_canonical = 'GENERAL_MAKESAFE'
      AND c.state = 'exception'
      AND c.job_id IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: effective authority snapshot changed';
  END IF;
  IF (
    SELECT count(*) FROM public.makesafe_intake_source_authority_corrections
    WHERE org_id = c_org AND effective_case_id = c_effective_case
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM public.makesafe_intake_source_authority_correction_supersessions
    WHERE effective_case_id = c_effective_case
      OR prior_authority_case_id = c_effective_case
  ) THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: effective authority ledger state changed';
  END IF;

  -- Append the correction: both transport rows re-bind to the corrected
  -- authority under the same expected-identity convention round one used for
  -- work-order-less partitions.
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
    c_org,
    e.post_id,
    c_legacy_case,
    c_effective_case,
    'false_po_sent',
    c_expected_key,
    jsonb_build_object(
      'legacy_builder_po', 'SENT',
      'poison_source_text', 'PO sent 24/6',
      'rederivation',
      'v2 canonical PO grammar requires digits after the label; the sources carry no parseable PO and name claim MLB-24481',
      'source_content_sha256', e.content_sha256,
      'migration', '20260730090000'
    )
  FROM public.emails e
  WHERE e.post_id IN (c_post_graph, c_post_mailbox);

  SELECT encode(
    extensions.digest(
      string_agg(s.post_id, ',' ORDER BY s.post_id),
      'sha256'
    ),
    'hex'
  )
  INTO v_manifest
  FROM public.makesafe_intake_case_sources s
  WHERE s.org_id = c_org AND s.case_id = c_legacy_case;

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
    c_org,
    legacy.id,
    c_effective_case,
    'false_po_sent',
    c_expected_key,
    2,
    v_manifest,
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
      'legacy_builder_po', 'SENT',
      'migration', '20260730090000'
    )
  FROM public.makesafe_intake_cases legacy
  WHERE legacy.org_id = c_org AND legacy.id = c_legacy_case;

  -- Closing invariant: every poisoned identity in the ledger now has corrected
  -- authority coverage. 336 of 336.
  IF EXISTS (
    SELECT 1 FROM public.makesafe_intake_cases c
    WHERE upper(coalesce(c.builder_po_canonical, '')) IN ('BOX', 'SENT')
      AND NOT EXISTS (
        SELECT 1 FROM public.makesafe_intake_case_authority_corrections cor
        WHERE cor.org_id = c.org_id AND cor.legacy_case_id = c.id
      )
  ) THEN
    RAISE EXCEPTION
      'false-PO SENT reconciliation refused: an uncovered poisoned case remains';
  END IF;
END;
$sent$;
