-- Stored reader, check 6: the store is armed and the source trigger
-- set has not changed since. A snapshot counts only after the arm stamp and
-- only while job_story_stored_profit_setup() equals the stamped set.
\set zz_check 'stored_reader.armed'
\ir ../session.sql
\if :zz_ok
SELECT :'zz_check' AS "check",
       CASE WHEN a.armed_at IS NOT NULL AND a.setup IS NOT NULL AND x.setup_now IS NOT NULL
             AND a.setup = x.setup_now THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('arm_row', a.singleton IS NOT NULL, 'armed_at', a.armed_at,
                          'setup_complete_now', x.setup_now IS NOT NULL,
                          'setup_same_as_armed', a.setup IS NOT NULL AND a.setup = x.setup_now)::text AS evidence
FROM (SELECT public.job_story_stored_profit_setup() AS setup_now) x
LEFT JOIN public.job_story_stored_profit_arm a ON a.singleton;
\endif
