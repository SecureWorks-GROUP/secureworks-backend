-- Count a placement on ANOTHER job as agreed (outcome alone, job ignored): the
-- contract's "placement on another job" check must catch it.
CREATE OR REPLACE FUNCTION public.context_jev_agreement(p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL)
RETURNS TABLE (decision_point text, confidence_band text, answered bigint, compared bigint, agreed bigint, agreement numeric,
 unsafe bigint, failed bigint, pairs jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 WITH win AS (
  SELECT coalesce(p_until, now()) AS until_, coalesce(p_since, coalesce(p_until, now()) - interval '14 days') AS since_
 ), d AS (
  SELECT j.decision_point AS point, j.jev_outcome, j.error_code,
   CASE WHEN j.jev_confidence IS NULL THEN NULL WHEN j.jev_confidence >= 0.9 THEN '0.90-1.00' WHEN j.jev_confidence >= 0.8 THEN '0.80-0.90'
        WHEN j.jev_confidence >= 0.5 THEN '0.50-0.80' ELSE '0.00-0.50' END AS band,
   (j.jev_outcome IS NOT NULL AND j.current_outcome IS NOT NULL) AS is_compared,
   (j.jev_outcome = j.current_outcome) AS is_agreed,
   CASE j.decision_point
    WHEN 'placement' THEN j.jev_outcome = 'job' AND (j.current_outcome <> 'job' OR j.jev_job_id <> j.current_job_id)
    WHEN 'ledger_update_gate' THEN j.jev_outcome = 'no_change' AND j.current_outcome = 'change'
    WHEN 'ledger_reply_owed' THEN j.jev_outcome = 'not_owed' AND j.current_outcome = 'owed' END AS is_unsafe,
   CASE WHEN j.jev_outcome = 'job' AND j.current_outcome = 'job' AND j.jev_job_id <> j.current_job_id THEN 'job>other_job'
        ELSE j.jev_outcome || '>' || j.current_outcome END AS pair
  FROM public.context_jev_decisions j CROSS JOIN win
  WHERE j.created_at >= win.since_ AND j.created_at < win.until_
 ), points (point, point_rank) AS (
  VALUES ('placement', 1), ('ledger_update_gate', 2), ('ledger_reply_owed', 3)
 ), bands (band, band_rank) AS (
  VALUES ('all', 0), ('0.90-1.00', 1), ('0.80-0.90', 2), ('0.50-0.80', 3), ('0.00-0.50', 4)
 ), cell AS (
  SELECT p.point, p.point_rank, b.band, b.band_rank, d.jev_outcome, d.error_code, d.is_compared, d.is_agreed, d.is_unsafe, d.pair
  FROM points p CROSS JOIN bands b
  LEFT JOIN d ON d.point = p.point AND (b.band = 'all' OR d.band = b.band)
 ), pair_counts AS (
  SELECT c.point, c.band, jsonb_object_agg(c.pair, c.n) AS pairs
  FROM (SELECT point, band, pair, count(*) AS n FROM cell WHERE is_compared GROUP BY point, band, pair) c
  GROUP BY c.point, c.band
 )
 SELECT c.point, c.band,
  count(*) FILTER (WHERE c.jev_outcome IS NOT NULL),
  count(*) FILTER (WHERE c.is_compared),
  count(*) FILTER (WHERE c.is_compared AND c.is_agreed),
  round((count(*) FILTER (WHERE c.is_compared AND c.is_agreed))::numeric / nullif(count(*) FILTER (WHERE c.is_compared), 0), 4),
  count(*) FILTER (WHERE c.is_compared AND c.is_unsafe),
  CASE WHEN c.band = 'all' THEN count(*) FILTER (WHERE c.error_code IS NOT NULL) ELSE 0 END,
  coalesce(min(pc.pairs::text)::jsonb, '{}'::jsonb)
 FROM cell c LEFT JOIN pair_counts pc ON pc.point = c.point AND pc.band = c.band
 GROUP BY c.point, c.point_rank, c.band, c.band_rank
 ORDER BY c.point_rank, c.band_rank
$fn$;
