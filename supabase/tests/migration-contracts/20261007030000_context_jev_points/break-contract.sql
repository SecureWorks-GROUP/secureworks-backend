-- Never count a lead as unsafe: Jev calling a lead declined or gone elsewhere
-- when the job was then won would no longer show as harm. The contract's
-- named lead check must catch it.
CREATE OR REPLACE FUNCTION public.context_jev_agreement(p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL)
RETURNS TABLE (decision_point text, confidence_band text, answered bigint, compared bigint, agreed bigint, agreement numeric,
 unsafe bigint, failed bigint, pairs jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 WITH win AS (
  SELECT coalesce(p_until, now()) AS until_, coalesce(p_since, coalesce(p_until, now()) - interval '14 days') AS since_
 ), rows_ AS MATERIALIZED (
  SELECT j.decision_point AS point, j.jev_outcome, j.jev_job_id, j.jev_confidence, j.current_job_id, j.error_code,
   CASE WHEN j.decision_point IN ('sender_role', 'visit_happened', 'lead_alive', 'email_triage') THEN public.context_jev_truth(j)
        WHEN j.decision_point = 'payment_wait' AND j.current_outcome = 'hold' AND (j.current_answer ->> 'customer_held') IS DISTINCT FROM 'true' THEN NULL
        ELSE j.current_outcome END AS against
  FROM public.context_jev_decisions j CROSS JOIN win
  WHERE j.created_at >= win.since_ AND j.created_at < win.until_
 ), d AS (
  SELECT r.point, r.jev_outcome, r.error_code,
   CASE WHEN r.jev_confidence IS NULL THEN NULL WHEN r.jev_confidence >= 0.9 THEN '0.90-1.00' WHEN r.jev_confidence >= 0.8 THEN '0.80-0.90'
        WHEN r.jev_confidence >= 0.5 THEN '0.50-0.80' ELSE '0.00-0.50' END AS band,
   (r.jev_outcome IS NOT NULL AND r.against IS NOT NULL
    AND (r.point <> 'email_triage' OR r.against <> 'not_junk' OR r.jev_outcome = 'marketing_junk')) AS is_compared,
   CASE r.point
    WHEN 'lead_alive' THEN (r.jev_outcome IN ('alive', 'paused') AND r.against = 'won') OR (r.jev_outcome IN ('declined', 'gone_elsewhere') AND r.against = 'lost')
    WHEN 'payment_wait' THEN (r.jev_outcome = 'none' AND r.against = 'remind') OR (r.jev_outcome IN ('paid', 'disputes', 'asked_for_time') AND r.against = 'hold')
    ELSE (r.jev_outcome = r.against AND (r.jev_outcome <> 'job' OR r.jev_job_id = r.current_job_id)) END AS is_agreed,
   CASE r.point
    WHEN 'placement' THEN r.jev_outcome = 'job' AND (r.against <> 'job' OR r.jev_job_id <> r.current_job_id)
    WHEN 'ledger_update_gate' THEN r.jev_outcome = 'no_change' AND r.against = 'change'
    WHEN 'ledger_reply_owed' THEN r.jev_outcome = 'not_owed' AND r.against = 'owed'
    WHEN 'sender_role' THEN r.jev_outcome <> 'unknown' AND (r.jev_outcome = 'customer') <> (r.against = 'customer')
    WHEN 'visit_happened' THEN r.jev_outcome = 'yes' AND r.against = 'no'
    WHEN 'lead_alive' THEN false
    WHEN 'payment_wait' THEN r.jev_outcome = 'none' AND r.against = 'hold'
    WHEN 'email_triage' THEN r.jev_outcome = 'marketing_junk' AND r.against <> 'marketing_junk' END AS is_unsafe,
   CASE WHEN r.point = 'placement' AND r.jev_outcome = 'job' AND r.against = 'job' AND r.jev_job_id <> r.current_job_id THEN 'job>other_job'
        ELSE r.jev_outcome || '>' || r.against END AS pair
  FROM rows_ r
 ), points (point, point_rank) AS (
  VALUES ('placement', 1), ('ledger_update_gate', 2), ('ledger_reply_owed', 3),
   ('sender_role', 4), ('visit_happened', 5), ('lead_alive', 6), ('payment_wait', 7), ('email_triage', 8)
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
