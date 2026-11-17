-- Runs after P2-01.1 merges; its owning writer must have saved the ZZTEST line.
-- Spec tables: phase-2-matching-build-spec, section 2.2 (17 Nov).
-- Inputs: job_number, line_id, expected_amount_ex (from the kept source document).
-- This fixture is one known actual cost assigned wholly to the ZZTEST job.
WITH target AS (
  SELECT id, org_id
  FROM public.jobs
  WHERE job_number = :'job_number' AND job_number LIKE 'ZZTEST%'
), stored AS (
  SELECT l.id, l.document_kind, l.document_id, l.line_key, l.kind, l.lane,
    l.amount_ex, l.state, l.not_counted_reason, l.is_actual, l.source_hash,
    l.updated_at
  FROM public.job_cost_lines l
  JOIN target j ON j.org_id = l.org_id
  WHERE l.id = :'line_id'::uuid AND (SELECT count(*) FROM target) = 1
    AND EXISTS (SELECT 1 FROM public.job_cost_line_parts p
      WHERE p.line_id = l.id AND p.target = 'job' AND p.job_id = j.id)
), parts AS (
  SELECT count(*) AS part_count, sum(p.amount_ex) AS parts_amount_ex,
    count(*) FILTER (WHERE p.target = 'job'
      AND p.job_id IN (SELECT id FROM target)
      AND p.lane = l.lane) AS matching_job_parts
  FROM public.job_cost_line_parts p JOIN stored l ON l.id = p.line_id
)
SELECT CASE WHEN (SELECT count(*) FROM target) = 1 AND s.id IS NOT NULL
    AND s.state = 'on_job' AND s.not_counted_reason IS NULL AND s.is_actual
    AND nullif(btrim(s.source_hash), '') IS NOT NULL
    AND p.part_count = 1 AND p.matching_job_parts = 1
    AND s.amount_ex = :'expected_amount_ex'::numeric
    AND p.parts_amount_ex = s.amount_ex
  THEN 'PASS' ELSE 'FAIL' END AS result,
  (SELECT count(*) FROM target) AS matched_jobs, s.id AS line_id,
  s.document_kind, s.document_id, s.line_key, s.kind, s.lane, s.state,
  s.not_counted_reason, s.is_actual, s.amount_ex,
  :'expected_amount_ex'::numeric AS expected_amount_ex,
  p.part_count, p.matching_job_parts, p.parts_amount_ex, s.source_hash, s.updated_at
FROM parts p LEFT JOIN stored s ON true;
