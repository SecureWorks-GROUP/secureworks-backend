-- 20261115100000 gave the tie-out Job Profit's own rule. 20261030060000 and its down refuse that body by its
-- comment; 20261029121500 has no such guard and would replace or drop it without a word. This is a disposable copy, so 20261115100000 is rolled back first and the break lands on the body the
-- contract reads.
SELECT COALESCE(obj_description(to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)'), 'pg_proc'), '') LIKE 'TP-01 Xero tie-out, Job Profit rule (20261115100000%' AS tieout_has_job_profit_rule \gset
\if :tieout_has_job_profit_rule
\ir ../../../rollbacks/20261115100000_xero_tieout_job_profit_rule_down.sql
\endif
-- Deliberately break the holding-job rule: a row on a holding job
-- (do_not_schedule 'true', any case) is read as on a job. The contract
-- must fail, because a holding job is never a job and its dollars are unplaced.
DO $$
DECLARE d text := pg_get_functiondef('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure);
BEGIN
  IF position('lower(COALESCE(j.metadata ->> ''do_not_schedule'', '''')) = ''true'' AS hold' IN d) = 0 THEN
    RAISE EXCEPTION 'break: holding rule not found';
  END IF;
  EXECUTE replace(d, 'lower(COALESCE(j.metadata ->> ''do_not_schedule'', '''')) = ''true'' AS hold',
                     'lower(COALESCE(j.metadata ->> ''do_not_schedule'', '''')) = ''never'' AS hold');
END $$;
