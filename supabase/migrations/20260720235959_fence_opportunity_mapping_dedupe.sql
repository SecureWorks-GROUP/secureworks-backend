-- Resolve historical duplicate GHL opportunity mappings before the fencing mint
-- uniqueness migration (20260721000001_fence_job_mint.sql) is applied.
--
-- Safety contract:
--   * no job is deleted or merged;
--   * every mapping in a duplicate group, including the kept mapping, is audited;
--   * only losing jobs have ghl_opportunity_id set to NULL;
--   * the winner is deterministic and evidence-led;
--   * patio duplicates are handled because the following unique index covers all
--     job types, even though fencing retries exposed the production problem.

CREATE TABLE IF NOT EXISTS public.fence_opportunity_mapping_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organisations(id),
  job_type text NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  old_opportunity_id text NOT NULL,
  resolution_action text NOT NULL CHECK (resolution_action IN ('kept', 'unmapped')),
  resolution_reason text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  winner_job_id uuid NOT NULL REFERENCES public.jobs(id),
  ambiguous_group boolean NOT NULL,
  rich_business_row_count integer NOT NULL,
  evidence jsonb NOT NULL,
  winner_evidence jsonb NOT NULL,
  UNIQUE (job_id, old_opportunity_id),
  CHECK (
    (resolution_action = 'kept' AND job_id = winner_job_id)
    OR (resolution_action = 'unmapped' AND job_id <> winner_job_id)
  )
);

COMMENT ON TABLE public.fence_opportunity_mapping_audit IS
  'Immutable evidence snapshot for the 2026-07 duplicate GHL opportunity mapping repair. Includes fencing and patio rows; losing jobs were unmapped, never deleted.';
COMMENT ON COLUMN public.fence_opportunity_mapping_audit.ambiguous_group IS
  'True when at least two jobs in the original group carried quote, financial, assignment, or other operational relation evidence. The winner is provisional and manually reversible from this row.';

ALTER TABLE public.fence_opportunity_mapping_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fence_opportunity_mapping_audit FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_fence_opportunity_mapping_audit_opportunity
  ON public.fence_opportunity_mapping_audit (org_id, job_type, old_opportunity_id);
CREATE INDEX IF NOT EXISTS idx_fence_opportunity_mapping_audit_winner
  ON public.fence_opportunity_mapping_audit (winner_job_id);

-- Arrays compare lexicographically in PostgreSQL. Keeping the rank construction
-- in one narrow immutable helper makes the provisional winner rule inspectable:
-- prefer breadth across independent evidence categories, then financial evidence,
-- then quote, operational, artifact and lifecycle depth. Raw event volume is not
-- ranked because automation produced thousands of events on some retry rows;
-- distinct event-type breadth is used instead.
CREATE OR REPLACE FUNCTION public._fence_opportunity_mapping_rank(
  p_financial_count bigint,
  p_quote_count bigint,
  p_operations_count bigint,
  p_artifact_count bigint,
  p_lifecycle_count bigint,
  p_scope_nonempty boolean,
  p_pricing_nonempty boolean,
  p_event_type_count bigint
) RETURNS bigint[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT ARRAY[
    (
      (COALESCE(p_financial_count, 0) > 0)::integer
      + (COALESCE(p_quote_count, 0) > 0)::integer
      + (COALESCE(p_operations_count, 0) > 0)::integer
      + (COALESCE(p_artifact_count, 0) > 0)::integer
      + (COALESCE(p_lifecycle_count, 0) > 0)::integer
      + COALESCE(p_scope_nonempty, false)::integer
      + COALESCE(p_pricing_nonempty, false)::integer
      + (COALESCE(p_event_type_count, 0) > 0)::integer
    )::bigint,
    (COALESCE(p_financial_count, 0) > 0)::integer::bigint,
    COALESCE(p_financial_count, 0),
    COALESCE(p_quote_count, 0),
    COALESCE(p_operations_count, 0),
    COALESCE(p_artifact_count, 0),
    COALESCE(p_lifecycle_count, 0),
    COALESCE(p_scope_nonempty, false)::integer::bigint,
    COALESCE(p_pricing_nonempty, false)::integer::bigint,
    COALESCE(p_event_type_count, 0)
  ]
$$;

REVOKE ALL ON FUNCTION public._fence_opportunity_mapping_rank(
  bigint, bigint, bigint, bigint, bigint, boolean, boolean, bigint
) FROM PUBLIC, anon, authenticated;

WITH duplicate_groups AS (
  SELECT org_id, type, ghl_opportunity_id, count(*)::integer AS group_size
  FROM public.jobs
  WHERE ghl_opportunity_id IS NOT NULL
  GROUP BY org_id, type, ghl_opportunity_id
  HAVING count(*) > 1
), duplicate_jobs AS (
  SELECT j.*, g.group_size
  FROM public.jobs j
  JOIN duplicate_groups g USING (org_id, type, ghl_opportunity_id)
), measured AS (
  SELECT
    j.org_id,
    j.type AS job_type,
    j.ghl_opportunity_id AS old_opportunity_id,
    j.group_size,
    j.id AS job_id,
    j.job_number,
    j.status::text AS status,
    j.created_at,
    j.updated_at,
    COALESCE(j.scope_json, '{}'::jsonb) <> '{}'::jsonb AS scope_nonempty,
    COALESCE(j.pricing_json, '{}'::jsonb) <> '{}'::jsonb AS pricing_nonempty,
    pg_column_size(COALESCE(j.scope_json, '{}'::jsonb))::bigint AS scope_bytes,
    pg_column_size(COALESCE(j.pricing_json, '{}'::jsonb))::bigint AS pricing_bytes,
    (
      (SELECT count(*) FROM public.xero_invoices x WHERE x.job_id = j.id)
      + (SELECT count(*) FROM public.xero_projects x WHERE x.job_id = j.id)
      + (SELECT count(*) FROM public.purchase_orders p WHERE p.job_id = j.id)
      + (SELECT count(*) FROM public.work_orders w WHERE w.job_id = j.id)
      + (SELECT count(*) FROM public.trade_invoice_lines t WHERE t.job_id = j.id)
      + (j.xero_quote_id IS NOT NULL)::integer
      + (j.deposit_invoice_id IS NOT NULL)::integer
    )::bigint AS financial_count,
    (SELECT count(*) FROM public.quote_revisions q WHERE q.job_id = j.id)::bigint AS quote_count,
    (
      (SELECT count(*) FROM public.job_assignments a WHERE a.job_id = j.id)
      + (SELECT count(*) FROM public.job_variations v WHERE v.job_id = j.id)
      + (SELECT count(*) FROM public.council_submissions c WHERE c.job_id = j.id)
      + (SELECT count(*) FROM public.run_line_items r WHERE r.job_id = j.id)
      + (SELECT count(*) FROM public.job_contacts c WHERE c.job_id = j.id)
    )::bigint AS operations_count,
    (
      (SELECT count(*) FROM public.job_documents d WHERE d.job_id = j.id)
      + (SELECT count(*) FROM public.job_media m WHERE m.job_id = j.id)
      + (SELECT count(*) FROM public.scope_revisions s WHERE s.job_id = j.id)
      + (SELECT count(*) FROM public.job_scope s WHERE s.job_id = j.id)
    )::bigint AS artifact_count,
    (
      (j.status::text <> 'draft')::integer
      + (j.quoted_at IS NOT NULL)::integer
      + (j.accepted_at IS NOT NULL)::integer
      + (j.scheduled_at IS NOT NULL)::integer
      + (j.completed_at IS NOT NULL)::integer
      + (j.approvals_at IS NOT NULL)::integer
      + (j.deposit_at IS NOT NULL)::integer
      + (j.processing_at IS NOT NULL)::integer
      + (j.xero_contact_id IS NOT NULL)::integer
      + (j.xero_quote_id IS NOT NULL)::integer
      + (j.deposit_invoice_id IS NOT NULL)::integer
    )::bigint AS lifecycle_count,
    (SELECT count(*) FROM public.job_events e WHERE e.job_id = j.id)::bigint AS event_count,
    (SELECT count(DISTINCT e.event_type) FROM public.job_events e WHERE e.job_id = j.id)::bigint AS event_type_count
  FROM duplicate_jobs j
), scored AS (
  SELECT
    m.*,
    public._fence_opportunity_mapping_rank(
      m.financial_count,
      m.quote_count,
      m.operations_count,
      m.artifact_count,
      m.lifecycle_count,
      m.scope_nonempty,
      m.pricing_nonempty,
      m.event_type_count
    ) AS evidence_rank,
    CASE
      WHEN m.status = 'draft'
        AND NOT m.scope_nonempty
        AND NOT m.pricing_nonempty
        AND m.financial_count = 0
        AND m.quote_count = 0
        AND m.operations_count = 0
        AND m.artifact_count = 0
        AND m.lifecycle_count = 0
        AND m.event_count <= 1
      THEN 'empty_retry_husk'
      WHEN m.financial_count + m.quote_count + m.operations_count > 0
      THEN 'linked_business_record'
      WHEN m.scope_nonempty OR m.pricing_nonempty OR m.artifact_count > 0 OR m.lifecycle_count > 0
      THEN 'scoped_or_lifecycle_record'
      ELSE 'thin_mapping_record'
    END AS classification,
    count(*) FILTER (
      WHERE m.financial_count + m.quote_count + m.operations_count > 0
    ) OVER (
      PARTITION BY m.org_id, m.job_type, m.old_opportunity_id
    )::integer AS rich_business_row_count
  FROM measured m
), ranked AS (
  SELECT
    s.*,
    row_number() OVER (
      PARTITION BY s.org_id, s.job_type, s.old_opportunity_id
      ORDER BY
        s.evidence_rank DESC,
        CASE WHEN s.scope_nonempty THEN s.updated_at END DESC NULLS LAST,
        s.updated_at DESC NULLS LAST,
        s.created_at DESC NULLS LAST,
        s.job_id DESC
    ) AS mapping_rank
  FROM scored s
), rows_with_winner AS (
  SELECT
    r.*,
    w.job_id AS winner_job_id,
    w.evidence_rank AS winner_evidence_rank,
    w.classification AS winner_classification,
    w.job_number AS winner_job_number,
    w.status AS winner_status
  FROM ranked r
  JOIN ranked w
    ON w.org_id = r.org_id
    AND w.job_type = r.job_type
    AND w.old_opportunity_id = r.old_opportunity_id
    AND w.mapping_rank = 1
), audited AS (
  INSERT INTO public.fence_opportunity_mapping_audit (
    org_id,
    job_type,
    job_id,
    old_opportunity_id,
    resolution_action,
    resolution_reason,
    winner_job_id,
    ambiguous_group,
    rich_business_row_count,
    evidence,
    winner_evidence
  )
  SELECT
    r.org_id,
    r.job_type,
    r.job_id,
    r.old_opportunity_id,
    CASE WHEN r.mapping_rank = 1 THEN 'kept' ELSE 'unmapped' END,
    'duplicate_opportunity_mapping_richest_evidence_v1',
    r.winner_job_id,
    r.rich_business_row_count > 1,
    r.rich_business_row_count,
    jsonb_build_object(
      'classification', r.classification,
      'group_size', r.group_size,
      'rank', r.evidence_rank,
      'job_number', r.job_number,
      'status', r.status,
      'scope_nonempty', r.scope_nonempty,
      'scope_bytes', r.scope_bytes,
      'pricing_nonempty', r.pricing_nonempty,
      'pricing_bytes', r.pricing_bytes,
      'financial_count', r.financial_count,
      'quote_count', r.quote_count,
      'operations_count', r.operations_count,
      'artifact_count', r.artifact_count,
      'lifecycle_count', r.lifecycle_count,
      'event_count', r.event_count,
      'event_type_count', r.event_type_count,
      'updated_at', r.updated_at
    ),
    jsonb_build_object(
      'classification', r.winner_classification,
      'rank', r.winner_evidence_rank,
      'job_number', r.winner_job_number,
      'status', r.winner_status
    )
  FROM rows_with_winner r
  ON CONFLICT (job_id, old_opportunity_id) DO NOTHING
  RETURNING job_id
)
UPDATE public.jobs j
SET ghl_opportunity_id = NULL
FROM rows_with_winner r
WHERE r.mapping_rank > 1
  AND j.id = r.job_id
  AND j.ghl_opportunity_id = r.old_opportunity_id;

-- Fail this transaction rather than letting the following unique-index migration
-- choose implicitly or fail opaquely. A clean apply returns zero rows here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.jobs
    WHERE ghl_opportunity_id IS NOT NULL
    GROUP BY org_id, type, ghl_opportunity_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'fence opportunity mapping dedupe left duplicate mappings';
  END IF;
END;
$$;
