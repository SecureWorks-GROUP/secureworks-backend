-- P0-14.3: read the persisted digest, never build it.
-- Source: 20250301000005_daily_digests.sql.
-- Inputs (psql variables): job_number, expected_digest_date (ISO date).
-- The ZZTEST job selects its organisation; the digest itself is organisation-wide.
WITH target AS (
  SELECT id, org_id
  FROM public.jobs
  WHERE job_number = :'job_number' AND job_number LIKE 'ZZTEST%'
), stored AS (
  SELECT d.id, d.digest_date, d.created_at, d.status, d.alert_count,
    jsonb_typeof(d.digest_json) = 'object' AND d.digest_json <> '{}'::jsonb AS has_content,
    md5(d.digest_json::text) AS digest_json_md5
  FROM public.daily_digests d
  WHERE d.org_id = (SELECT org_id FROM target WHERE (SELECT count(*) FROM target) = 1)
  ORDER BY d.digest_date DESC, d.created_at DESC NULLS LAST, d.id
  LIMIT 1
)
SELECT CASE WHEN (SELECT count(*) FROM target) = 1
    AND s.digest_date = :'expected_digest_date'::date AND s.has_content
  THEN 'PASS' ELSE 'FAIL' END AS result,
  (SELECT count(*) FROM target) AS matched_jobs,
  s.id AS digest_id, s.digest_date, s.created_at, s.status, s.alert_count,
  s.has_content, s.digest_json_md5
FROM (SELECT 1) anchor
LEFT JOIN stored s ON true;
