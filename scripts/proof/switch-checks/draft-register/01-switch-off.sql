-- Draft register, check 1: the draft standard switch exists and is still
-- off. Turning it on starts the register (PR 1641) and also turns on P3-01.7
-- and P3-01.8 (the draft standard's division and account rules).
\set zz_check 'draft_register.switch_off'
\ir ../session.sql
\if :zz_ok
SELECT :'zz_check' AS "check",
       CASE WHEN f.enabled IS FALSE THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('flag', 'xero_draft_standard_v1', 'row_found', f.flag_name IS NOT NULL,
                          'enabled', f.enabled)::text AS evidence
FROM (SELECT 1) anchor
LEFT JOIN public.feature_flags f ON f.flag_name = 'xero_draft_standard_v1';
\endif
