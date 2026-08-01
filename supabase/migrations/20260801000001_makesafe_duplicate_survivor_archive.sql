-- Captain-authorized duplicate-survivor archive (2026-08-01).
--
-- A both-live duplicate group is two board cards minted from ONE builder work
-- order instruction. The survivor stays live; the loser is archived on the
-- DISPLAY ledger only, carrying a durable pointer to its survivor.
--
-- This reuses the existing append-only makesafe_board_status_applications
-- ledger rather than adding a second board-status engine. It never writes jobs,
-- makesafe_job_details, assignments, invoices, events, communications, or
-- notifications, and it never deletes a card.
--
-- The pointer columns are additive and nullable, so every existing cutover row
-- and the existing apply_makesafe_board_status RPC keep working unchanged.

ALTER TABLE public.makesafe_board_status_applications
  ADD COLUMN IF NOT EXISTS duplicate_of_job_id uuid
    REFERENCES public.jobs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS duplicate_of_job_number text,
  ADD COLUMN IF NOT EXISTS duplicate_rule text,
  ADD COLUMN IF NOT EXISTS duplicate_evidence jsonb;

COMMENT ON COLUMN public.makesafe_board_status_applications.duplicate_of_job_id IS
  'Survivor card this archived duplicate points at. Set only by the duplicate-survivor archive path.';
COMMENT ON COLUMN public.makesafe_board_status_applications.duplicate_rule IS
  'Which captain rule selected the survivor: builder_po (the PO discriminates) or activity_evidence (delegated pick).';

-- All-or-nothing: a pointer row must carry every pointer field, must archive,
-- and must not point at itself. A non-pointer row must carry none of them.
ALTER TABLE public.makesafe_board_status_applications
  DROP CONSTRAINT IF EXISTS makesafe_board_status_applications_duplicate_pointer_check;
ALTER TABLE public.makesafe_board_status_applications
  ADD CONSTRAINT makesafe_board_status_applications_duplicate_pointer_check
  CHECK (
    (
      duplicate_of_job_id IS NULL
      AND duplicate_of_job_number IS NULL
      AND duplicate_rule IS NULL
      AND duplicate_evidence IS NULL
    )
    OR (
      duplicate_of_job_id IS NOT NULL
      AND duplicate_of_job_number IS NOT NULL
      AND length(btrim(duplicate_of_job_number)) > 0
      AND duplicate_rule IN ('builder_po', 'activity_evidence')
      AND duplicate_evidence IS NOT NULL
      AND jsonb_typeof(duplicate_evidence) = 'object'
      AND duplicate_of_job_id <> job_id
      AND after_status = 'archive'
    )
  );

CREATE INDEX IF NOT EXISTS idx_makesafe_board_status_applications_duplicate_of
  ON public.makesafe_board_status_applications (duplicate_of_job_id)
  WHERE duplicate_of_job_id IS NOT NULL;

-- Re-create the current-display view with the pointer columns appended so the
-- board read model can surface "archived as duplicate of X" without a second read.
DROP VIEW IF EXISTS public.makesafe_board_status_current;
CREATE VIEW public.makesafe_board_status_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (job_id)
  id,
  run_key,
  job_id,
  job_number,
  source_status,
  before_status,
  after_status,
  computed_at,
  computed_reasons,
  computed_missing,
  evidence_ref,
  applied_by,
  applied_at,
  duplicate_of_job_id,
  duplicate_of_job_number,
  duplicate_rule,
  duplicate_evidence
FROM public.makesafe_board_status_applications
ORDER BY job_id, applied_at DESC, id DESC;

REVOKE ALL ON public.makesafe_board_status_current FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_board_status_current TO service_role;
COMMENT ON VIEW public.makesafe_board_status_current IS
  'Latest captain-applied display transition per MakeSafe job. The edge read model applies it only while source_status still matches the current declared board stage.';

CREATE OR REPLACE FUNCTION public.apply_makesafe_duplicate_survivor_archive(
  p_run_key text,
  p_applied_by text,
  p_evidence_ref text,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  expected_count integer;
  eligible_count integer;
  inserted_count integer;
  applied_rows jsonb;
BEGIN
  IF length(btrim(COALESCE(p_run_key, ''))) = 0
     OR length(btrim(COALESCE(p_applied_by, ''))) = 0
     OR length(btrim(COALESCE(p_evidence_ref, ''))) = 0 THEN
    RAISE EXCEPTION 'run key, attribution, and evidence reference are required';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  expected_count := jsonb_array_length(p_rows);
  -- Duplicate adjudication is a reviewed, hand-verified list, never a bulk sweep.
  IF expected_count < 1 OR expected_count > 50 THEN
    RAISE EXCEPTION 'p_rows must contain between 1 and 50 duplicate archives';
  END IF;

  WITH incoming AS (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS x(
      job_id uuid,
      job_number text,
      source_status text,
      before_status text,
      after_status text,
      computed_at timestamptz,
      computed_reasons jsonb,
      computed_missing jsonb,
      duplicate_of_job_id uuid,
      duplicate_of_job_number text,
      duplicate_rule text,
      duplicate_evidence jsonb
    )
  ),
  eligible AS (
    SELECT i.*
    FROM incoming i
    -- The loser must be a live, non-terminal make-safe card.
    JOIN public.jobs loser
      ON loser.id = i.job_id
     AND loser.job_number = i.job_number
     AND loser.type = 'makesafe'
    JOIN public.makesafe_job_details loser_detail ON loser_detail.job_id = i.job_id
    -- The survivor must ALSO still be a live, non-terminal make-safe card.
    -- Archiving a duplicate onto a dead survivor would strand the work.
    JOIN public.jobs survivor
      ON survivor.id = i.duplicate_of_job_id
     AND survivor.job_number = i.duplicate_of_job_number
     AND survivor.type = 'makesafe'
    JOIN public.makesafe_job_details survivor_detail
      ON survivor_detail.job_id = i.duplicate_of_job_id
    LEFT JOIN LATERAL (
      SELECT a.after_status
      FROM public.makesafe_board_status_applications a
      WHERE a.job_id = i.job_id
        AND a.source_status = i.source_status
      ORDER BY a.applied_at DESC, a.id DESC
      LIMIT 1
    ) latest ON true
    WHERE lower(COALESCE(loser.status, '')) NOT IN (
      'archived', 'complete', 'completed', 'closed',
      'cancelled', 'canceled', 'lost', 'deleted'
    )
      AND lower(COALESCE(survivor.status, '')) NOT IN (
        'archived', 'complete', 'completed', 'closed',
        'cancelled', 'canceled', 'lost', 'deleted'
      )
      AND i.job_id <> i.duplicate_of_job_id
      AND i.source_status IN ('new', 'allocated', 'trade_report_in', 'report_ready')
      AND i.before_status IN ('new', 'allocated', 'trade_report_in', 'report_ready')
      AND i.after_status = 'archive'
      AND i.duplicate_rule IN ('builder_po', 'activity_evidence')
      AND jsonb_typeof(COALESCE(i.duplicate_evidence, 'null'::jsonb)) = 'object'
      AND i.computed_at IS NOT NULL
      AND jsonb_typeof(COALESCE(i.computed_reasons, '[]'::jsonb)) = 'array'
      AND jsonb_array_length(COALESCE(i.computed_reasons, '[]'::jsonb)) > 0
      AND jsonb_typeof(COALESCE(i.computed_missing, '[]'::jsonb)) = 'array'
      -- Stale-plan guard: the card must still sit where the plan saw it.
      AND COALESCE(latest.after_status, i.source_status) = i.before_status
      -- A survivor may never itself be an archived duplicate (no pointer chains).
      AND NOT EXISTS (
        SELECT 1
        FROM public.makesafe_board_status_applications s
        WHERE s.job_id = i.duplicate_of_job_id
          AND s.duplicate_of_job_id IS NOT NULL
      )
  )
  SELECT count(*) INTO eligible_count FROM eligible;

  IF eligible_count <> expected_count THEN
    RAISE EXCEPTION
      'guarded duplicate archive rejected one or more rows (expected %, eligible %)',
      expected_count, eligible_count;
  END IF;

  WITH incoming AS (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS x(
      job_id uuid,
      job_number text,
      source_status text,
      before_status text,
      after_status text,
      computed_at timestamptz,
      computed_reasons jsonb,
      computed_missing jsonb,
      duplicate_of_job_id uuid,
      duplicate_of_job_number text,
      duplicate_rule text,
      duplicate_evidence jsonb
    )
  ),
  inserted AS (
    INSERT INTO public.makesafe_board_status_applications (
      run_key,
      job_id,
      job_number,
      source_status,
      before_status,
      after_status,
      computed_at,
      computed_reasons,
      computed_missing,
      evidence_ref,
      applied_by,
      duplicate_of_job_id,
      duplicate_of_job_number,
      duplicate_rule,
      duplicate_evidence
    )
    SELECT
      p_run_key,
      i.job_id,
      i.job_number,
      i.source_status,
      i.before_status,
      i.after_status,
      i.computed_at,
      COALESCE(i.computed_reasons, '[]'::jsonb),
      COALESCE(i.computed_missing, '[]'::jsonb),
      p_evidence_ref,
      p_applied_by,
      i.duplicate_of_job_id,
      i.duplicate_of_job_number,
      i.duplicate_rule,
      i.duplicate_evidence
    FROM incoming i
    ON CONFLICT (run_key, job_id) DO NOTHING
    RETURNING *
  )
  SELECT count(*), COALESCE(jsonb_agg(to_jsonb(inserted) ORDER BY id), '[]'::jsonb)
  INTO inserted_count, applied_rows
  FROM inserted;

  IF inserted_count <> expected_count THEN
    RAISE EXCEPTION
      'run key already exists with a conflicting or partial duplicate archive set';
  END IF;

  RETURN jsonb_build_object(
    'run_key', p_run_key,
    'applied_count', inserted_count,
    'applied', applied_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_makesafe_duplicate_survivor_archive(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_makesafe_duplicate_survivor_archive(text, text, text, jsonb)
  TO service_role;
COMMENT ON FUNCTION public.apply_makesafe_duplicate_survivor_archive(text, text, text, jsonb) IS
  'Atomic idempotency-keyed display-only duplicate-survivor archive. Requires a live survivor, forbids pointer chains and self-pointers, rejects terminal and stale cards, and appends a complete before/after/pointer/evidence audit without invoking operational writers.';
