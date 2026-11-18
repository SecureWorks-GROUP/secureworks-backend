-- Run from the repository root. The TypeScript draft mapper reads this exact file too.
\set examples `jq -ce 'select(type == "array" and length > 0)' supabase/functions/_shared/division_examples.json`
CREATE TEMP TABLE division_cases ON COMMIT DROP AS
SELECT * FROM jsonb_to_recordset(:'examples'::jsonb)
  AS e(job_number text, job_type text, stock_division text, expect text, ruled text, option_state text);

INSERT INTO public.jobs (id, org_id, job_number, type, status)
VALUES ('71110000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001',
        'SWP-ZZTEST09', 'miscellaneous', 'draft');

DO $test$
DECLARE
  own_org constant uuid := '00000000-0000-0000-0000-000000000001';
  other_org constant uuid := '00000000-0000-0000-0000-000000000002';
  e record;
  actual text;
  plan json;
BEGIN
  FOR e IN SELECT * FROM division_cases LOOP
    -- Isolate the two fixture organisations' option states inside the rolled-back contract.
    DELETE FROM public.xero_tracking_options
    WHERE org_id IN (own_org, other_org) AND option_name = 'Private Renovations';
    IF e.option_state IN ('ACTIVE', 'ARCHIVED', 'other_org') THEN
      INSERT INTO public.xero_tracking_options (org_id, category_id, category_name, option_id, option_name, status)
      VALUES (CASE WHEN e.option_state = 'other_org' THEN other_org ELSE own_org END,
        'ZZTEST-unit', 'Business Unit', 'ZZTEST-private', 'Private Renovations',
        CASE WHEN e.option_state = 'ARCHIVED' THEN 'ARCHIVED' ELSE 'ACTIVE' END);
    END IF;
    IF e.stock_division IS NOT NULL THEN
      actual := public.stock_division_option(e.stock_division);
    ELSE
      actual := public.job_division_option(e.job_number, e.job_type);
      IF public.job_division_option(e.job_number, e.job_type, own_org) IS DISTINCT FROM actual THEN
        RAISE EXCEPTION 'division_signature_mismatch: %', e.job_number;
      END IF;
    END IF;
    IF actual IS DISTINCT FROM coalesce(e.ruled, e.expect) THEN
      RAISE EXCEPTION 'division_fixture_mismatch: % % %', e.job_number, e.job_type, e.stock_division;
    END IF;
  END LOOP;
  DELETE FROM public.xero_tracking_options WHERE org_id = own_org AND option_name = 'Private Renovations';
  -- An office rename/archive takes effect on the next read. Retry cannot create the option.
  INSERT INTO public.xero_tracking_options (org_id, category_id, category_name, option_id, option_name, status)
  VALUES (own_org, 'ZZTEST-unit', 'Business Unit', 'ZZTEST-retry', 'Private Renovations', 'ACTIVE');
  IF public.job_division_option('SWP-ZZTEST09','general') IS DISTINCT FROM 'Private Renovations'
     OR public.job_division_option(NULL,'general',own_org) IS DISTINCT FROM 'Private Renovations'
     OR public.job_division_option(NULL,'general') IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'division_org_scope_mismatch';
  END IF;
  UPDATE public.xero_tracking_options SET status = 'ARCHIVED' WHERE org_id = own_org AND option_id = 'ZZTEST-retry';
  FOR attempt IN 1..2 LOOP
    IF public.job_division_option('SWP-ZZTEST09','general') IS DISTINCT FROM '' THEN
      RAISE EXCEPTION 'division_archived_retry_failed';
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM public.xero_tracking_options WHERE org_id = own_org AND option_name = 'Private Renovations' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'division_refusal_wrote_option';
  END IF;
  -- Tiny contract tables normally favour a sequential scan. Prove both lookups can use an index.
  SET LOCAL enable_seqscan = off;
  FOR plan IN EXECUTE $p$EXPLAIN (FORMAT JSON) SELECT j.org_id FROM public.jobs j WHERE j.job_number = 'SWP-ZZTEST09'$p$ LOOP
    IF plan::text LIKE '%Seq Scan%' OR plan::text NOT LIKE '%Index%' THEN RAISE EXCEPTION 'division_job_lookup_unindexed'; END IF;
  END LOOP;
  FOR plan IN EXECUTE $p$EXPLAIN (FORMAT JSON) SELECT 1 FROM public.xero_tracking_options WHERE org_id = '00000000-0000-0000-0000-000000000001' AND status = 'ACTIVE' AND option_name = 'Private Renovations'$p$ LOOP
    IF plan::text LIKE '%Seq Scan%' OR plan::text NOT LIKE '%Index%' THEN RAISE EXCEPTION 'division_option_lookup_unindexed'; END IF;
  END LOOP;
END $test$;

-- A stored, active option which this caller cannot read must still refuse.
UPDATE public.xero_tracking_options SET status = 'ACTIVE' WHERE option_id = 'ZZTEST-retry';
REVOKE SELECT ON public.xero_tracking_options FROM authenticated;
SET LOCAL ROLE authenticated;
DO $test$ BEGIN
  IF public.job_division_option(NULL, 'misc', '00000000-0000-0000-0000-000000000001') IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'division_unreadable_option_accepted';
  END IF;
END $test$;
RESET ROLE;
SELECT count(*) AS shared_division_cases_passed FROM division_cases;
