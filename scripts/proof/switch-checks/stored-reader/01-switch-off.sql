-- Stored reader, check 1: the story switch exists and is still off.
\set zz_check 'stored_reader.switch_off'
\ir ../session.sql
\if :zz_ok
SELECT :'zz_check' AS "check",
       CASE WHEN f.enabled IS FALSE THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('flag', 'job_story_stored_profit_v1', 'row_found', f.flag_name IS NOT NULL,
                          'enabled', f.enabled)::text AS evidence
FROM (SELECT 1) anchor
LEFT JOIN public.feature_flags f ON f.flag_name = 'job_story_stored_profit_v1';
\endif
