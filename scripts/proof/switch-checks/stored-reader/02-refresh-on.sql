-- Stored reader, check 2: the profit refresh switch is on. The store
-- answers nothing while it is off (job_story_stored_profit_as_at).
\set zz_check 'stored_reader.refresh_on'
\ir ../session.sql
SELECT :'zz_check' AS "check",
       CASE WHEN f.enabled IS TRUE THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('flag', 'job_profit_refresh_v1', 'row_found', f.flag_name IS NOT NULL,
                          'enabled', f.enabled)::text AS evidence
FROM (SELECT 1) anchor
LEFT JOIN public.feature_flags f ON f.flag_name = 'job_profit_refresh_v1';
