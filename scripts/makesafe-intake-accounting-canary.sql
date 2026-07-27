-- Read-only U1 SES accounting canary.
--
-- Required psql variables:
--   window_start  inclusive timestamptz watermark (overlap by >= 10 minutes)
--   window_end    exclusive timestamptz, normally now() - interval '5 minutes'
--   org_id        production organisation UUID
--
-- Example (read-only principal only):
--   psql "$READ_ONLY_DATABASE_URL" \
--     -v window_start='2026-07-27T00:00:00Z' \
--     -v window_end='2026-07-27T00:10:00Z' \
--     -v org_id='00000000-0000-0000-0000-000000000001' \
--     -f scripts/makesafe-intake-accounting-canary.sql

BEGIN TRANSACTION READ ONLY;

WITH required(table_name, column_name) AS (
  VALUES
    ('emails', 'post_id'),
    ('emails', 'mailbox'),
    ('emails', 'received_at'),
    ('email_classifier_exclusions', 'post_id'),
    ('email_classifier_exclusions', 'mailbox'),
    ('email_events_raw', 'org_id'),
    ('email_events_raw', 'post_id'),
    ('email_events_raw', 'mailbox'),
    ('email_events_raw', 'change_type'),
    ('email_events_raw', 'observed_at'),
    ('makesafe_intake_case_sources', 'org_id'),
    ('makesafe_intake_case_sources', 'post_id'),
    ('makesafe_intake_case_sources', 'case_id'),
    ('makesafe_intake_cases', 'org_id'),
    ('makesafe_intake_cases', 'id'),
    ('makesafe_intake_cases', 'state'),
    ('makesafe_intake_cases', 'reason_code'),
    ('makesafe_intake_cases', 'parent_relation'),
    ('makesafe_intake_cases', 'target_relation'),
    ('makesafe_intake_cases', 'target_job_id'),
    ('makesafe_intake_cases', 'received_at'),
    ('makesafe_job_details', 'job_id'),
    ('makesafe_job_details', 'cancel_reason'),
    ('makesafe_job_details', 'cancelled_at'),
    ('jobs', 'id'),
    ('jobs', 'status')
),
live AS (
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
)
SELECT r.table_name, r.column_name
FROM required r
LEFT JOIN live l USING (table_name, column_name)
WHERE l.column_name IS NULL
ORDER BY r.table_name, r.column_name;

WITH source_window AS (
  SELECT e.post_id, e.received_at
  FROM public.emails e
  WHERE lower(e.mailbox) = 'ses@secureworkswa.com.au'
    AND e.received_at >= :'window_start'::timestamptz
    AND e.received_at < :'window_end'::timestamptz
),
case_accounted AS (
  SELECT s.post_id, count(*)::integer AS fate_count
  FROM public.makesafe_intake_case_sources s
  JOIN source_window w ON w.post_id = s.post_id
  WHERE s.org_id = :'org_id'::uuid
    AND NOT EXISTS (
      SELECT 1
      FROM public.email_events_raw i
      WHERE i.org_id = :'org_id'::uuid
        AND i.post_id = s.post_id
        AND (
          i.change_type LIKE 'intake\_%' ESCAPE '\'
          OR i.change_type = 'scan_run_cap_deferred'
        )
    )
  GROUP BY s.post_id
),
issue_accounted AS (
  SELECT r.post_id, count(*)::integer AS fate_count
  FROM public.email_events_raw r
  JOIN source_window w ON w.post_id = r.post_id
  WHERE r.org_id = :'org_id'::uuid
    AND lower(r.mailbox) = 'ses@secureworkswa.com.au'
    AND (
      r.change_type LIKE 'intake\_%' ESCAPE '\'
      OR r.change_type = 'scan_run_cap_deferred'
    )
  GROUP BY r.post_id
),
nonwork_accounted AS (
  SELECT x.post_id
  FROM public.email_classifier_exclusions x
  JOIN source_window w ON w.post_id = x.post_id
  WHERE lower(x.mailbox) = 'ses@secureworkswa.com.au'

  UNION

  SELECT r.post_id
  FROM public.email_events_raw r
  JOIN source_window w ON w.post_id = r.post_id
  WHERE r.org_id = :'org_id'::uuid
    AND lower(r.mailbox) = 'ses@secureworkswa.com.au'
    AND r.change_type = 'excluded'
),
accounting_counts AS (
  SELECT
    w.post_id,
    coalesce(c.fate_count, 0) +
      coalesce(i.fate_count, 0) +
      CASE WHEN n.post_id IS NULL THEN 0 ELSE 1 END AS fate_count
  FROM source_window w
  LEFT JOIN case_accounted c USING (post_id)
  LEFT JOIN issue_accounted i USING (post_id)
  LEFT JOIN nonwork_accounted n USING (post_id)
),
failures AS (
  SELECT post_id, fate_count
  FROM accounting_counts
  WHERE fate_count <> 1
)
SELECT
  :'window_start'::timestamptz AS window_start,
  :'window_end'::timestamptz AS window_end,
  (SELECT count(*) FROM source_window) AS total_sources,
  count(*) AS unaccounted_or_double_accounted,
  coalesce(
    jsonb_agg(jsonb_build_object('post_id', post_id, 'fate_count', fate_count)
      ORDER BY post_id),
    '[]'::jsonb
  ) AS failures
FROM failures;

WITH cancellation_cases AS (
  SELECT
    c.id AS case_id,
    c.target_relation,
    c.target_job_id,
    c.reason_code,
    c.received_at
  FROM public.makesafe_intake_cases c
  WHERE c.org_id = :'org_id'::uuid
    AND c.received_at >= :'window_start'::timestamptz
    AND c.received_at < :'window_end'::timestamptz
    AND c.reason_code = 'cancellation'
),
failures AS (
  SELECT
    c.case_id,
    c.target_relation,
    c.target_job_id,
    c.reason_code,
    j.status AS job_status
  FROM cancellation_cases c
  LEFT JOIN public.jobs j ON j.id = c.target_job_id
  WHERE c.target_relation IS DISTINCT FROM 'cancellation_of'
    OR c.target_job_id IS NULL
    OR lower(coalesce(j.status, '')) NOT IN ('cancelled', 'canceled')
)
SELECT
  (SELECT count(*) FROM cancellation_cases) AS cancellation_cases,
  count(*) AS unresolved_cancellations,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'case_id', case_id,
        'target_job_id', target_job_id,
        'reason_code', reason_code,
        'job_status', job_status
      )
      ORDER BY case_id
    ),
    '[]'::jsonb
  ) AS failures
FROM failures;

ROLLBACK;
