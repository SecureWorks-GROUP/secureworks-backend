-- Draft register, check 4: with the switch off, nothing has written to the
-- register (all organisations). A row here means a writer ran without the
-- switch. Evidence is counts by register row only.
\set zz_check 'draft_register.register_empty_while_off'
\ir ../session.sql
\if :zz_ok
SELECT :'zz_check' AS "check",
       CASE WHEN f.enabled IS FALSE AND (SELECT count(*) FROM public.xero_draft_register) = 0
            THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('switch_enabled', f.enabled,
                          'rows', (SELECT count(*) FROM public.xero_draft_register),
                          'by_register_row', (SELECT coalesce(jsonb_object_agg(register_row, n), '{}')
                                              FROM (SELECT register_row, count(*) n FROM public.xero_draft_register
                                                    GROUP BY register_row) g))::text AS evidence
FROM (SELECT 1) anchor
LEFT JOIN public.feature_flags f ON f.flag_name = 'xero_draft_standard_v1';
\endif
