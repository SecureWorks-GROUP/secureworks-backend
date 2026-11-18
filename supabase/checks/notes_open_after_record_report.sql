-- P4-02.8. Run with psql -X -f. Stop on any read failure.
\set ON_ERROR_STOP on

-- 1. One row per open item in a live reading. When several records have the
-- item's key, its first matching record starts the clock.
SELECT j.job_number, i.item_key, i.closes_on, proof.label AS record_label,
       (now() AT TIME ZONE 'Australia/Perth')::date
       - (proof.closes_at AT TIME ZONE 'Australia/Perth')::date AS days_open_since_record
FROM public.context_ledger_generations g
JOIN public.jobs j ON j.id = g.job_id
JOIN public.context_ledger_items i ON i.generation_id = g.id AND i.job_id = g.job_id
CROSS JOIN LATERAL (
  SELECT c.label, c.closes_at
  FROM (
    SELECT r.*, count(*) OVER () AS candidates
    FROM public.context_ledger_record_candidates(
      i.job_id, i.closes_on, i.about_key, i.opened_at, i.from_role, i.to_role
    ) r
  ) c
  WHERE (c.candidates = 1 OR c.key = i.about_key) AND c.closes_at <= now()
  ORDER BY c.closes_at, c.table_name COLLATE "C", c.record_id COLLATE "C"
  LIMIT 1
) proof
WHERE g.status = 'live' AND i.status = 'open' AND NOT i.person_locked
  AND i.closes_on IN ('quote_sent','invoice_issued','payment','booking_made','visit','work_done')
ORDER BY j.job_number COLLATE "C", i.item_key COLLATE "C";

-- 2. Attribute each reopening to the preceding close, including when two
-- transitions share a timestamp. A later close starts a new episode.
SELECT i.closes_on, count(*) AS record_closes,
       count(*) FILTER (WHERE following.to_status = 'open'
                          AND following.by LIKE 'person:%') AS reopened_by_person
FROM public.context_ledger_transitions t
JOIN public.context_ledger_items i ON i.id = t.item_id
LEFT JOIN LATERAL (
  SELECT u.to_status, u.by
  FROM public.context_ledger_transitions u
  WHERE u.item_id = t.item_id AND (u.at, u.id) > (t.at, t.id)
    AND u.from_status IS DISTINCT FROM u.to_status
  ORDER BY u.at, u.id
  LIMIT 1
) following ON true
WHERE t.by = 'rule:record_close_v1' AND t.to_status IN ('closed','declined')
  AND t.at BETWEEN now() - interval '7 days' AND now()
GROUP BY i.closes_on
ORDER BY i.closes_on;

-- 3. psql branches before PostgreSQL parses the optional table reference.
SELECT to_regclass('public.job_truth_weekly_samples') IS NOT NULL AS samples_installed \gset
\if :samples_installed
WITH newest AS (
  SELECT week FROM public.job_truth_weekly_samples
  GROUP BY week HAVING count(read_at) = count(*)
  ORDER BY week DESC LIMIT 1
), sample AS (
  SELECT s.job_id, s.notes_total, s.marks
  FROM public.job_truth_weekly_samples s JOIN newest USING (week)
), misses AS (
  SELECT s.job_id, mark->>'problem' AS problem
  FROM sample s CROSS JOIN LATERAL jsonb_array_elements(s.marks) mark
  WHERE mark->>'target' = 'note' AND mark->>'problem' = 'wrongly_open'
), totals AS (
  SELECT (SELECT week FROM newest) AS week,
         (SELECT sum(notes_total) FROM sample) AS notes_read,
         (SELECT count(*) FROM misses) AS missed
), report AS (
  SELECT CASE WHEN week IS NULL THEN 'no complete weekly sample' ELSE 'summary' END AS row_kind,
         week, CASE WHEN week IS NOT NULL THEN missed END AS missed, notes_read,
         round(100.0 * missed / nullif(notes_read, 0), 4) AS missed_pct,
         NULL::text AS job_number, NULL::text AS problem
  FROM totals
  UNION ALL
  SELECT 'miss', n.week, NULL, NULL, NULL, j.job_number, m.problem
  FROM misses m JOIN public.jobs j ON j.id = m.job_id CROSS JOIN newest n
)
SELECT * FROM report ORDER BY job_number COLLATE "C" NULLS FIRST;
\else
SELECT 'weekly sample not built yet' AS row_kind;
\endif
