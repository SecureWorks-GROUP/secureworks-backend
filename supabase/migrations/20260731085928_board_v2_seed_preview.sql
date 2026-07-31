-- Read-only prospective inputs for the make-safe state-authority bootstrap.
--
-- The original dark seed dry-run compared the unseeded persisted views even
-- though the live seed is what creates their identity, cycle, family and fact
-- hashes. That made the acceptance gate impossible to satisfy on an unseeded
-- database. This migration adds a service-role-only STABLE preview RPC which
-- computes the same prospective inputs without INSERT/UPDATE/DELETE.
--
-- This migration does not execute the seed, move a board card, write an
-- operational row, send a communication, or touch a financial record.

-- The deployed seed body has two latent bootstrap defects which its former
-- dry-run never reached: the case-count selector names c.id even though the
-- case_candidates CTE exposes case_id, and its family selector does not give
-- the typed restoration authority precedence over stale make-safe metadata.
-- Patch the exact reviewed body in place without maintaining a second seed
-- implementation. The earlier seed-scope migration already owns restoration
-- eligibility and fact-trigger coverage.
DO $repair_seed_body$
DECLARE
  v_definition text;
  v_repaired text;
  v_case_count_occurrences integer;
  v_case_id_occurrences integer;
  v_family_occurrences integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.seed_makesafe_state_authority_v1(text,text,text,uuid[])'::regprocedure
  )
  INTO v_definition;

  v_case_count_occurrences := (
    length(v_definition) -
      length(replace(v_definition, 'count(c.id) AS case_count', ''))
  ) / length('count(c.id) AS case_count');
  v_case_id_occurrences := (
    length(v_definition) -
      length(replace(
        v_definition,
        '(array_agg(c.id ORDER BY c.id))[1] AS case_id',
        ''
      ))
  ) / length('(array_agg(c.id ORDER BY c.id))[1] AS case_id');
  v_family_occurrences := (
    length(v_definition) -
      length(replace(
        v_definition,
        $anchor$lower(COALESCE(
        j.metadata->>'ses_family',$anchor$,
        ''
      ))
  ) / length($anchor$lower(COALESCE(
        j.metadata->>'ses_family',$anchor$);

  IF v_case_count_occurrences <> 1
     OR v_case_id_occurrences <> 1
     OR v_family_occurrences <> 1 THEN
    RAISE EXCEPTION
      'seed_makesafe_state_authority_v1 no longer matches the reviewed repair anchors';
  END IF;

  v_repaired := replace(
    replace(
      replace(
        v_definition,
        'count(c.id) AS case_count',
        'count(c.case_id) AS case_count'
      ),
      '(array_agg(c.id ORDER BY c.id))[1] AS case_id',
      '(array_agg(c.case_id ORDER BY c.case_id))[1] AS case_id'
    ),
    $anchor$lower(COALESCE(
        j.metadata->>'ses_family',$anchor$,
    $replacement$lower(COALESCE(
        CASE
          WHEN j.type = 'insurance'
            AND j.metadata->>'insurance_job_type' = 'restoration'
            THEN 'restoration'
        END,
        j.metadata->>'ses_family',$replacement$
  );

  EXECUTE v_repaired;
END;
$repair_seed_body$;

CREATE OR REPLACE FUNCTION public.preview_makesafe_state_authority_v2(
  p_job_ids uuid[]
)
RETURNS TABLE (
  job_id uuid,
  projection_inputs jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_requested integer;
  v_matched integer;
BEGIN
  v_requested := cardinality(p_job_ids);
  IF v_requested < 1 OR v_requested > 500 THEN
    RAISE EXCEPTION 'p_job_ids must contain between 1 and 500 jobs';
  END IF;
  IF v_requested <> (
    SELECT count(DISTINCT id) FROM unnest(p_job_ids) ids(id)
  ) THEN
    RAISE EXCEPTION 'p_job_ids contains duplicate jobs';
  END IF;

  SELECT count(*) INTO v_matched
  FROM public.jobs j
  WHERE j.id = ANY(p_job_ids)
    AND (
      j.type = 'makesafe'
      OR (
        j.type = 'insurance'
        AND j.metadata->>'insurance_job_type' = 'restoration'
      )
    );
  IF v_matched <> v_requested THEN
    RAISE EXCEPTION
      'preview selection contains a missing or non-canonical make-safe job';
  END IF;

  RETURN QUERY
  WITH job_inputs AS (
    SELECT
      j.*,
      d.external_ref AS detail_external_ref,
      d.report_type,
      lower(COALESCE(d.requesting_company_slug, '')) AS company_slug,
      lower(concat_ws(
        ' ',
        d.requesting_company_slug,
        d.requesting_company_name,
        d.external_ref,
        j.metadata->'requesting_company'->>'slug',
        j.metadata->'requesting_company'->>'name'
      )) AS builder_token,
      lower(COALESCE(
        CASE
          WHEN j.type = 'insurance'
            AND j.metadata->>'insurance_job_type' = 'restoration'
            THEN 'restoration'
        END,
        j.metadata->>'ses_family',
        j.metadata->>'makesafe_job_family',
        j.metadata->>'makesafe_family',
        j.metadata->>'job_family',
        d.report_type,
        ''
      )) AS family_token
    FROM public.jobs j
    LEFT JOIN public.makesafe_job_details d ON d.job_id = j.id
    WHERE j.id = ANY(p_job_ids)
  ),
  job_context AS (
    SELECT
      i.*,
      CASE
        WHEN (
          i.builder_token ~ '(^|[^a-z0-9])(aj|ajs|ajbr)([^a-z0-9]|$)'
          OR i.builder_token LIKE '%alliance joinery%'
        )
          AND i.family_token NOT LIKE '%temp%fenc%'
          THEN 'physical_makesafe'
        WHEN i.family_token LIKE '%temp%fenc%'
          THEN 'temporary_fencing'
        WHEN i.family_token LIKE '%assessment%'
          OR i.family_token LIKE '%report_and_quote%'
          THEN 'assessment_quote'
        WHEN i.family_token LIKE '%roof%'
          AND (
            i.metadata->>'own_template_requested' = 'true'
            OR lower(COALESCE(i.metadata->>'report_delivery', '')) =
              'own_document'
            OR i.family_token LIKE '%own%template%'
            OR i.family_token LIKE '%strata%'
          )
          THEN 'own_template_roof'
        WHEN i.family_token LIKE '%roof%'
          AND (
            i.builder_token ~ '(^|[^a-z0-9])mlb([^a-z0-9]|$)'
            OR i.builder_token LIKE '%ml builders%'
            OR i.builder_token LIKE '%major loss builders%'
            OR i.builder_token LIKE '%mlbuilders%'
          )
          THEN 'ordinary_roof_portal'
        WHEN i.family_token IN (
          'general_makesafe',
          'physical_makesafe',
          'makesafe'
        )
          THEN 'physical_makesafe'
        ELSE NULL
      END AS family_code
    FROM job_inputs i
  ),
  existing_cycles AS (
    SELECT c.*
    FROM public.makesafe_attendance_cycles c
    WHERE c.job_id = ANY(p_job_ids)
  ),
  missing_cycles AS (
    SELECT
      extensions.uuid_generate_v5(
        'cf5c8b90-bdb4-5bb0-8d75-c732db3773c8'::uuid,
        'attendance-cycle:' || j.id::text || ':' ||
          GREATEST(COALESCE(d.cycle_number, 1), 1)::text
      ) AS id,
      j.id AS job_id,
      GREATEST(COALESCE(d.cycle_number, 1), 1) AS cycle_number,
      COALESCE(d.created_at, j.created_at, transaction_timestamp()) AS opened_at,
      NULL::timestamptz AS closed_at,
      'state_authority_seed_existing_job'::text AS open_reason,
      COALESCE(d.created_at, j.created_at, transaction_timestamp()) AS created_at,
      NULL::bigint AS makesafe_fact_version,
      NULL::text AS makesafe_content_hash
    FROM job_context j
    LEFT JOIN public.makesafe_job_details d ON d.job_id = j.id
    WHERE NOT EXISTS (
      SELECT 1 FROM existing_cycles c WHERE c.job_id = j.id
    )
  ),
  cycle_source AS (
    SELECT
      c.id,
      c.job_id,
      c.cycle_number,
      c.opened_at,
      c.closed_at,
      c.open_reason,
      c.created_at,
      c.makesafe_fact_version,
      c.makesafe_content_hash,
      to_jsonb(c) AS raw_json
    FROM existing_cycles c
    UNION ALL
    SELECT
      c.id,
      c.job_id,
      c.cycle_number,
      c.opened_at,
      c.closed_at,
      c.open_reason,
      c.created_at,
      c.makesafe_fact_version,
      c.makesafe_content_hash,
      to_jsonb(c) AS raw_json
    FROM missing_cycles c
  ),
  cycles AS (
    SELECT
      c.*,
      CASE
        WHEN c.makesafe_fact_version IS NULL
          OR c.makesafe_content_hash IS NULL THEN 1
        ELSE c.makesafe_fact_version
      END AS preview_version,
      CASE
        WHEN c.makesafe_fact_version IS NULL
          OR c.makesafe_content_hash IS NULL
          THEN public.makesafe_fact_hash_v1(
            'makesafe_attendance_cycles',
            c.raw_json
              - 'makesafe_fact_version'
              - 'makesafe_content_hash'
              - 'updated_at'
          )
        ELSE c.makesafe_content_hash
      END AS preview_hash
    FROM cycle_source c
  ),
  cycle_counts AS (
    SELECT
      c.job_id,
      count(*) AS cycle_count,
      (array_agg(c.id ORDER BY c.id))[1] AS single_cycle_id,
      array_agg(c.id ORDER BY c.id) AS cycle_ids,
      public.makesafe_attendance_cycle_set_hash_v1(
        array_agg(c.id ORDER BY c.id)
      ) AS cycle_set_hash
    FROM cycles c
    GROUP BY c.job_id
  ),
  details AS (
    SELECT
      d.*,
      CASE WHEN cc.cycle_count = 1
        THEN cc.single_cycle_id
        ELSE d.attendance_cycle_id
      END AS preview_cycle_id,
      CASE WHEN cc.cycle_count = 1
        THEN 'bound'
        ELSE d.cycle_attribution
      END AS preview_cycle_attribution
    FROM public.makesafe_job_details d
    JOIN cycle_counts cc ON cc.job_id = d.job_id
    WHERE d.job_id = ANY(p_job_ids)
  ),
  assignments AS (
    SELECT
      a.id,
      a.job_id,
      a.status,
      CASE WHEN cc.cycle_count = 1
        THEN cc.single_cycle_id
        ELSE a.attendance_cycle_id
      END AS attendance_cycle_id,
      CASE WHEN cc.cycle_count = 1
        THEN 'bound'
        ELSE a.cycle_attribution
      END AS cycle_attribution,
      CASE
        WHEN a.makesafe_fact_version IS NULL
          OR a.makesafe_content_hash IS NULL THEN 1
        ELSE a.makesafe_fact_version
      END AS makesafe_fact_version,
      CASE
        WHEN a.makesafe_fact_version IS NULL
          OR a.makesafe_content_hash IS NULL
          THEN public.makesafe_fact_hash_v1(
            'job_assignments',
            (
              to_jsonb(a) ||
              jsonb_build_object(
                'attendance_cycle_id',
                CASE WHEN cc.cycle_count = 1
                  THEN cc.single_cycle_id
                  ELSE a.attendance_cycle_id
                END,
                'cycle_attribution',
                CASE WHEN cc.cycle_count = 1
                  THEN 'bound'
                  ELSE a.cycle_attribution
                END
              )
            )
              - 'makesafe_fact_version'
              - 'makesafe_content_hash'
              - 'updated_at'
          )
        ELSE a.makesafe_content_hash
      END AS makesafe_content_hash
    FROM public.job_assignments a
    JOIN cycle_counts cc ON cc.job_id = a.job_id
    WHERE a.job_id = ANY(p_job_ids)
  ),
  service_reports AS (
    SELECT
      r.id,
      r.job_id,
      r.status,
      COALESCE(c.id, r.attendance_cycle_id) AS attendance_cycle_id,
      CASE WHEN c.id IS NOT NULL
        THEN 'bound'
        ELSE r.cycle_attribution
      END AS cycle_attribution,
      CASE
        WHEN r.makesafe_fact_version IS NULL
          OR r.makesafe_content_hash IS NULL THEN 1
        ELSE r.makesafe_fact_version
      END AS makesafe_fact_version,
      CASE
        WHEN r.makesafe_fact_version IS NULL
          OR r.makesafe_content_hash IS NULL
          THEN public.makesafe_fact_hash_v1(
            'job_service_reports',
            (
              to_jsonb(r) ||
              jsonb_build_object(
                'attendance_cycle_id',
                COALESCE(c.id, r.attendance_cycle_id),
                'cycle_attribution',
                CASE WHEN c.id IS NOT NULL
                  THEN 'bound'
                  ELSE r.cycle_attribution
                END
              )
            )
              - 'makesafe_fact_version'
              - 'makesafe_content_hash'
              - 'updated_at'
          )
        ELSE r.makesafe_content_hash
      END AS makesafe_content_hash
    FROM public.job_service_reports r
    LEFT JOIN cycles c
      ON c.job_id = r.job_id
     AND c.cycle_number = COALESCE(r.cycle_number, 1)
    WHERE r.job_id = ANY(p_job_ids)
  ),
  documents AS (
    SELECT
      d.id,
      d.job_id,
      d.type,
      CASE WHEN cc.cycle_count = 1
        THEN cc.single_cycle_id
        ELSE d.attendance_cycle_id
      END AS attendance_cycle_id,
      CASE WHEN cc.cycle_count = 1
        THEN 'bound'
        ELSE d.cycle_attribution
      END AS cycle_attribution,
      CASE
        WHEN d.makesafe_fact_version IS NULL
          OR d.makesafe_content_hash IS NULL THEN 1
        ELSE d.makesafe_fact_version
      END AS makesafe_fact_version,
      CASE
        WHEN d.makesafe_fact_version IS NULL
          OR d.makesafe_content_hash IS NULL
          THEN public.makesafe_fact_hash_v1(
            'job_documents',
            (
              to_jsonb(d) ||
              jsonb_build_object(
                'attendance_cycle_id',
                CASE WHEN cc.cycle_count = 1
                  THEN cc.single_cycle_id
                  ELSE d.attendance_cycle_id
                END,
                'cycle_attribution',
                CASE WHEN cc.cycle_count = 1
                  THEN 'bound'
                  ELSE d.cycle_attribution
                END
              )
            )
              - 'makesafe_fact_version'
              - 'makesafe_content_hash'
              - 'updated_at'
          )
        ELSE d.makesafe_content_hash
      END AS makesafe_content_hash
    FROM public.job_documents d
    JOIN cycle_counts cc ON cc.job_id = d.job_id
    WHERE d.job_id = ANY(p_job_ids)
  ),
  media AS (
    SELECT
      m.id,
      m.job_id,
      m.type,
      m.phase,
      CASE WHEN cc.cycle_count = 1
        THEN cc.single_cycle_id
        ELSE m.attendance_cycle_id
      END AS attendance_cycle_id,
      CASE WHEN cc.cycle_count = 1
        THEN 'bound'
        ELSE m.cycle_attribution
      END AS cycle_attribution,
      CASE
        WHEN m.makesafe_fact_version IS NULL
          OR m.makesafe_content_hash IS NULL THEN 1
        ELSE m.makesafe_fact_version
      END AS makesafe_fact_version,
      CASE
        WHEN m.makesafe_fact_version IS NULL
          OR m.makesafe_content_hash IS NULL
          THEN public.makesafe_fact_hash_v1(
            'job_media',
            (
              to_jsonb(m) ||
              jsonb_build_object(
                'attendance_cycle_id',
                CASE WHEN cc.cycle_count = 1
                  THEN cc.single_cycle_id
                  ELSE m.attendance_cycle_id
                END,
                'cycle_attribution',
                CASE WHEN cc.cycle_count = 1
                  THEN 'bound'
                  ELSE m.cycle_attribution
                END
              )
            )
              - 'makesafe_fact_version'
              - 'makesafe_content_hash'
              - 'updated_at'
          )
        ELSE m.makesafe_content_hash
      END AS makesafe_content_hash
    FROM public.job_media m
    JOIN cycle_counts cc ON cc.job_id = m.job_id
    WHERE m.job_id = ANY(p_job_ids)
  ),
  packs AS (
    SELECT
      p.id,
      p.job_id,
      p.status,
      p.review_state,
      p.needs_money_review,
      p.last_render_hash,
      CASE
        WHEN p.makesafe_fact_version IS NULL
          OR p.makesafe_content_hash IS NULL THEN 1
        ELSE p.makesafe_fact_version
      END AS makesafe_fact_version,
      CASE
        WHEN p.makesafe_fact_version IS NULL
          OR p.makesafe_content_hash IS NULL
          THEN public.makesafe_fact_hash_v1(
            'makesafe_report_packs',
            to_jsonb(p)
              - 'makesafe_fact_version'
              - 'makesafe_content_hash'
              - 'updated_at'
          )
        ELSE p.makesafe_content_hash
      END AS makesafe_content_hash
    FROM public.makesafe_report_packs p
    WHERE p.job_id = ANY(p_job_ids)
  ),
  pack_cycles AS (
    SELECT
      pc.id::text AS id,
      pc.pack_id,
      pc.job_id,
      pc.attendance_cycle_id,
      pc.cycle_attribution
    FROM public.makesafe_report_pack_cycles pc
    WHERE pc.job_id = ANY(p_job_ids)
    UNION ALL
    SELECT
      'preview:' || p.id::text || ':' || cc.single_cycle_id::text,
      p.id,
      p.job_id,
      cc.single_cycle_id,
      'bound'
    FROM public.makesafe_report_packs p
    JOIN cycle_counts cc
      ON cc.job_id = p.job_id
     AND cc.cycle_count = 1
    WHERE p.job_id = ANY(p_job_ids)
      AND NOT EXISTS (
        SELECT 1
        FROM public.makesafe_report_pack_cycles existing
        WHERE existing.pack_id = p.id
      )
  ),
  case_source AS (
    SELECT
      c.*,
      public.makesafe_fact_hash_v1(
        'intake-source',
        to_jsonb(c)
          - 'source_version'
          - 'source_content_hash'
          - 'lineage_version'
          - 'lineage_correction_hash'
          - 'lineage_supersession_hash'
          - 'updated_at'
          - 'observed_at'
          - 'last_decision_at'
      ) AS computed_source_hash,
      public.makesafe_fact_hash_v1(
        'lineage-corrections',
        jsonb_build_object(
          'case_id', c.id,
          'case_corrections', COALESCE((
            SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at, x.id)
            FROM public.makesafe_intake_case_authority_corrections x
            WHERE x.legacy_case_id = c.id OR x.effective_case_id = c.id
          ), '[]'::jsonb),
          'source_corrections', COALESCE((
            SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at, x.id)
            FROM public.makesafe_intake_source_authority_corrections x
            WHERE x.legacy_case_id = c.id OR x.effective_case_id = c.id
          ), '[]'::jsonb)
        )
      ) AS computed_correction_hash,
      public.makesafe_fact_hash_v1(
        'lineage-supersessions',
        jsonb_build_object(
          'case_id', c.id,
          'supersessions', COALESCE((
            SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at, x.id)
            FROM
              public.makesafe_intake_source_authority_correction_supersessions
                x
            WHERE x.prior_authority_case_id = c.id
               OR x.effective_case_id = c.id
          ), '[]'::jsonb)
        )
      ) AS computed_supersession_hash
    FROM public.makesafe_intake_cases c
    WHERE (
        c.job_id = ANY(p_job_ids)
        OR c.target_job_id = ANY(p_job_ids)
      )
      AND c.state IN ('confirmed_live_job', 'blocked_live_job')
  ),
  cases AS (
    SELECT
      c.*,
      CASE
        WHEN c.source_version IS NULL OR c.source_content_hash IS NULL THEN 1
        WHEN c.source_content_hash IS DISTINCT FROM c.computed_source_hash
          THEN c.source_version + 1
        ELSE c.source_version
      END AS preview_source_version,
      c.computed_source_hash AS preview_source_hash,
      CASE
        WHEN c.lineage_version IS NULL
          OR c.lineage_correction_hash IS NULL
          OR c.lineage_supersession_hash IS NULL THEN 1
        WHEN c.lineage_correction_hash IS DISTINCT FROM
            c.computed_correction_hash
          OR c.lineage_supersession_hash IS DISTINCT FROM
            c.computed_supersession_hash
          THEN c.lineage_version + 1
        ELSE c.lineage_version
      END AS preview_lineage_version,
      c.computed_correction_hash AS preview_correction_hash,
      c.computed_supersession_hash AS preview_supersession_hash
    FROM case_source c
  ),
  case_candidates AS (
    SELECT
      j.id AS job_id,
      c.id AS case_id
    FROM job_context j
    JOIN cases c ON c.job_id = j.id OR c.target_job_id = j.id
  ),
  case_counts AS (
    SELECT
      j.id AS job_id,
      count(c.case_id) AS case_count,
      (array_agg(c.case_id ORDER BY c.case_id))[1] AS case_id
    FROM job_context j
    LEFT JOIN case_candidates c ON c.job_id = j.id
    GROUP BY j.id
  ),
  identity_source AS (
    SELECT
      j.org_id,
      j.id AS job_id,
      CASE
        WHEN cc.case_count = 1 THEN 'effective_intake_case'
        WHEN cc.case_count = 0 THEN 'legacy_job_record'
        ELSE 'unresolved_authority'
      END AS authority_kind,
      CASE WHEN cc.case_count = 1 THEN c.id ELSE NULL END AS effective_case_id,
      CASE
        WHEN cc.case_count = 1 THEN c.instruction_key
        WHEN cc.case_count = 0 THEN 'legacy-job:' || j.id::text
        ELSE 'unresolved-job:' || j.id::text
      END AS source_instruction_id,
      COALESCE(c.preview_source_version, 1) AS source_version,
      COALESCE(
        c.preview_source_hash,
        public.makesafe_fact_hash_v1(
          'legacy-job-source',
          jsonb_build_object(
            'job_id', j.id,
            'job_number', j.job_number,
            'external_ref', j.detail_external_ref,
            'created_at', j.created_at
          )
        )
      ) AS source_content_hash,
      COALESCE(c.lineage_id::text, j.id::text) AS lineage_id,
      COALESCE(c.preview_lineage_version, 1) AS lineage_version,
      COALESCE(
        c.preview_correction_hash,
        public.makesafe_fact_hash_v1(
          'legacy-lineage-corrections',
          jsonb_build_object('job_id', j.id, 'corrections', '[]'::jsonb)
        )
      ) AS lineage_correction_hash,
      COALESCE(
        c.preview_supersession_hash,
        public.makesafe_fact_hash_v1(
          'legacy-lineage-supersessions',
          jsonb_build_object('job_id', j.id, 'supersessions', '[]'::jsonb)
        )
      ) AS lineage_supersession_hash,
      CASE
        WHEN cc.case_count > 1 THEN 'blocked_live_job'
        ELSE c.state
      END AS intake_state,
      CASE
        WHEN j.family_code IS NOT NULL THEN 'resolved'
        ELSE 'unresolved'
      END AS family_state,
      j.family_code AS family_rule_key,
      CASE
        WHEN cc.case_count > 1 THEN 'multiple_effective_authorities'
        WHEN j.family_token LIKE '%roof%'
          THEN 'builder_family_applicability_unresolved'
        WHEN j.family_code IS NULL THEN 'family_unclassified'
        ELSE NULL
      END AS blocker_code,
      CASE
        WHEN cc.case_count > 1
          THEN 'Choose the one source instruction that owns this job.'
        WHEN j.family_token LIKE '%roof%'
          THEN 'Confirm the builder and whether this roof report is a portal handoff or our own document.'
        WHEN j.family_code IS NULL
          THEN 'Classify the job family from its original work-order evidence.'
        ELSE NULL
      END AS recovery_instruction,
      jsonb_build_array(
        'jobs:' || j.id::text,
        CASE
          WHEN c.id IS NOT NULL
            THEN 'makesafe_intake_cases:' || c.id::text
          ELSE 'makesafe_job_details:' || j.id::text
        END
      ) AS evidence_refs
    FROM job_context j
    JOIN case_counts cc ON cc.job_id = j.id
    LEFT JOIN cases c ON c.id = cc.case_id
  ),
  identities AS (
    SELECT
      s.*,
      public.makesafe_fact_hash_v1(
        'state-identity-revision',
        jsonb_build_object(
          'job_id', s.job_id,
          'authority_kind', s.authority_kind,
          'effective_case_id', s.effective_case_id,
          'source_instruction_id', s.source_instruction_id,
          'source_version', s.source_version,
          'source_content_hash', s.source_content_hash,
          'lineage_id', s.lineage_id,
          'lineage_version', s.lineage_version,
          'lineage_correction_hash', s.lineage_correction_hash,
          'lineage_supersession_hash', s.lineage_supersession_hash,
          'intake_state', s.intake_state,
          'family_state', s.family_state,
          'family_rule_key', s.family_rule_key,
          'blocker_code', s.blocker_code,
          'evidence_refs', s.evidence_refs
        )
      ) AS revision_hash
    FROM identity_source s
  ),
  family_rule_seed_rows AS (
    SELECT *
    FROM (VALUES
      (
        'physical_makesafe'::text,
        'physical'::text,
        'ses-builder-family-matrix/2026-07-27.1:physical_makesafe'::text,
        5::integer,
        ARRAY[]::text[],
        ARRAY[]::text[]
      ),
      (
        'temporary_fencing',
        'physical',
        'ses-builder-family-matrix/2026-07-27.1:temporary_fencing',
        5,
        ARRAY[]::text[],
        ARRAY[]::text[]
      ),
      (
        'ordinary_roof_portal',
        'portal',
        'ses-builder-family-matrix/2026-07-27.1:ordinary_roof_portal',
        0,
        ARRAY[]::text[],
        ARRAY['roof_report']::text[]
      ),
      (
        'own_template_roof',
        'report_only',
        'ses-builder-family-matrix/2026-07-27.1:own_template_roof',
        0,
        ARRAY['roof_report']::text[],
        ARRAY[]::text[]
      ),
      (
        'assessment_quote',
        'portal',
        'ses-builder-family-matrix/2026-07-27.1:assessment_quote',
        0,
        ARRAY[]::text[],
        ARRAY['assessment', 'photos', 'scope']::text[]
      )
    ) AS seeded(
      family_code,
      family_kind,
      matrix_revision,
      completion_photo_floor,
      required_document_types,
      required_portal_roles
    )
  ),
  family_rules AS (
    SELECT
      extensions.uuid_generate_v5(
        'cf5c8b90-bdb4-5bb0-8d75-c732db3773c8'::uuid,
        'family-rule:' || r.family_code || ':' || r.matrix_revision
      ) AS id,
      r.*,
      public.makesafe_fact_hash_v1(
        'family-rule',
        jsonb_build_object(
          'family_code', r.family_code,
          'family_kind', r.family_kind,
          'matrix_revision', r.matrix_revision,
          'completion_photo_floor', r.completion_photo_floor,
          'required_document_types', to_jsonb(r.required_document_types),
          'required_portal_roles', to_jsonb(r.required_portal_roles)
        )
      ) AS matrix_content_hash
    FROM family_rule_seed_rows r
  ),
  closeout AS (
    SELECT DISTINCT ON (p.job_id)
      p.job_id,
      p.id AS pack_id,
      p.xero_invoice_id,
      x.id AS invoice_id,
      p.sent_at
    FROM public.makesafe_report_packs p
    LEFT JOIN public.xero_invoices x
      ON x.job_id = p.job_id
     AND x.invoice_type = 'ACCREC'
     AND upper(x.status) IN ('AUTHORISED', 'PAID')
    WHERE p.job_id = ANY(p_job_ids)
      AND COALESCE(p.pack_kind, 'main') = 'main'
      AND lower(COALESCE(p.status, '')) IN (
        'sent', 'sent_marker_failed', 'sent_not_closed', 'close_failed'
      )
      AND COALESCE(NULLIF(upper(p.invoice_status), ''), upper(x.status))
        IN ('AUTHORISED', 'PAID')
    ORDER BY p.job_id, p.sent_at DESC NULLS LAST, p.id DESC
  ),
  terminal_proofs AS (
    SELECT
      j.id AS job_id,
      COALESCE(
        to_jsonb(current_proof),
        CASE WHEN co.job_id IS NOT NULL THEN
          jsonb_build_object(
            'id', extensions.uuid_generate_v5(
              'cf5c8b90-bdb4-5bb0-8d75-c732db3773c8'::uuid,
              'terminal-proof:' || j.id::text || ':' || cc.cycle_set_hash
            ),
            'job_id', j.id,
            'kind', 'verified_historical_closeout',
            'attendance_cycle_ids', to_jsonb(cc.cycle_ids),
            'attendance_cycle_set_hash', cc.cycle_set_hash,
            'readiness_revision', NULL,
            'release_revision_id', NULL,
            'closeout_revision_id', NULL,
            'evidence_refs', to_jsonb(array_remove(ARRAY[
              'makesafe_report_packs:' || co.pack_id::text,
              CASE WHEN co.invoice_id IS NOT NULL
                THEN 'xero_invoices:' || co.invoice_id::text END,
              CASE WHEN co.xero_invoice_id IS NOT NULL
                THEN 'xero_invoice_id:' || co.xero_invoice_id END
            ]::text[], NULL)),
            'proven_at', COALESCE(co.sent_at, transaction_timestamp())
          )
        END
      ) AS row_json
    FROM job_context j
    JOIN cycle_counts cc ON cc.job_id = j.id
    LEFT JOIN public.makesafe_terminal_proofs_current_v2 current_proof
      ON current_proof.job_id = j.id
    LEFT JOIN closeout co ON co.job_id = j.id
  ),
  cancellations AS (
    SELECT
      j.id AS job_id,
      COALESCE(
        to_jsonb(current_cancel),
        CASE
          WHEN lower(j.status) IN ('cancelled', 'canceled')
            AND length(btrim(COALESCE(d.cancel_reason, ''))) > 0
            AND d.cancelled_at IS NOT NULL
            THEN jsonb_build_object(
              'id', extensions.uuid_generate_v5(
                'cf5c8b90-bdb4-5bb0-8d75-c732db3773c8'::uuid,
                'cancellation:' || j.id::text || ':' || cc.cycle_set_hash
              ),
              'job_id', j.id,
              'attendance_cycle_set_hash', cc.cycle_set_hash,
              'state', 'confirmed',
              'reason_code', d.cancel_reason,
              'note', d.cancel_note,
              'decided_by', COALESCE(NULLIF(d.cancelled_by, ''), 'preview'),
              'decided_at', COALESCE(
                d.cancelled_at,
                j.updated_at,
                transaction_timestamp()
              ),
              'evidence_refs', jsonb_build_array(
                'jobs:' || j.id::text,
                'makesafe_job_details:' || d.job_id::text
              )
            )
        END
      ) AS row_json
    FROM job_context j
    JOIN cycle_counts cc ON cc.job_id = j.id
    LEFT JOIN details d ON d.job_id = j.id
    LEFT JOIN public.makesafe_cancellation_current_v2 current_cancel
      ON current_cancel.job_id = j.id
  )
  SELECT
    j.id,
    jsonb_build_object(
      'identity', jsonb_build_object(
        'id', extensions.uuid_generate_v5(
          'cf5c8b90-bdb4-5bb0-8d75-c732db3773c8'::uuid,
          'state-identity:' || i.revision_hash
        ),
        'job_id', i.job_id,
        'authority_kind', i.authority_kind,
        'effective_case_id', i.effective_case_id,
        'source_instruction_id', i.source_instruction_id,
        'source_version', i.source_version,
        'source_content_hash', i.source_content_hash,
        'lineage_id', i.lineage_id,
        'lineage_version', i.lineage_version,
        'lineage_correction_hash', i.lineage_correction_hash,
        'lineage_supersession_hash', i.lineage_supersession_hash,
        'intake_state', i.intake_state,
        'family_state', i.family_state,
        'family_rule_key', i.family_rule_key,
        'blocker_code', i.blocker_code,
        'recovery_instruction', i.recovery_instruction,
        'evidence_refs', i.evidence_refs,
        'revision_hash', i.revision_hash
      ),
      'cycles', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', c.id,
          'job_id', c.job_id,
          'cycle_number', c.cycle_number,
          'opened_at', c.opened_at,
          'closed_at', c.closed_at,
          'makesafe_fact_version', c.preview_version,
          'makesafe_content_hash', c.preview_hash
        ) ORDER BY c.id)
        FROM cycles c WHERE c.job_id = j.id
      ), '[]'::jsonb),
      'assignments', COALESCE((
        SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
        FROM assignments a WHERE a.job_id = j.id
      ), '[]'::jsonb),
      'service_reports', COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
        FROM service_reports r WHERE r.job_id = j.id
      ), '[]'::jsonb),
      'documents', COALESCE((
        SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id)
        FROM documents d WHERE d.job_id = j.id
      ), '[]'::jsonb),
      'media', COALESCE((
        SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id)
        FROM media m WHERE m.job_id = j.id
      ), '[]'::jsonb),
      'pack_cycles', COALESCE((
        SELECT jsonb_agg(to_jsonb(pc) ORDER BY pc.id)
        FROM pack_cycles pc WHERE pc.job_id = j.id
      ), '[]'::jsonb),
      'packs', COALESCE((
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
        FROM packs p WHERE p.job_id = j.id
      ), '[]'::jsonb),
      'details', CASE WHEN d.job_id IS NULL THEN NULL ELSE
        to_jsonb(d) ||
        jsonb_build_object(
          'attendance_cycle_id', d.preview_cycle_id,
          'cycle_attribution', d.preview_cycle_attribution
        )
      END,
      'family_rule', CASE WHEN fr.family_code IS NULL THEN NULL ELSE
        jsonb_build_object(
          'id', fr.id,
          'family_code', fr.family_code,
          'family_kind', fr.family_kind,
          'matrix_revision', fr.matrix_revision,
          'matrix_content_hash', fr.matrix_content_hash,
          'completion_photo_floor', fr.completion_photo_floor,
          'required_document_types', to_jsonb(fr.required_document_types),
          'required_portal_roles', to_jsonb(fr.required_portal_roles)
        )
      END,
      'terminal_proof', tp.row_json,
      'cancellation', ca.row_json
    )
  FROM job_context j
  JOIN identities i ON i.job_id = j.id
  LEFT JOIN details d ON d.job_id = j.id
  LEFT JOIN family_rules fr ON fr.family_code = i.family_rule_key
  LEFT JOIN terminal_proofs tp ON tp.job_id = j.id
  LEFT JOIN cancellations ca ON ca.job_id = j.id
  ORDER BY j.id;
END;
$$;

REVOKE ALL ON FUNCTION public.preview_makesafe_state_authority_v2(uuid[])
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.preview_makesafe_state_authority_v2(uuid[])
  TO service_role;
