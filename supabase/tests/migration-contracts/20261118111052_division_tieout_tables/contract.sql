\set ON_ERROR_STOP on
BEGIN;
\ir ../../../migrations/20261118111052_division_tieout_tables.sql
\ir ../../../migrations/20261118111052_division_tieout_tables.sql

DO $$
DECLARE
  target regclass;
  priv text;
BEGIN
  FOREACH target IN ARRAY ARRAY['public.division_tieout_cells'::regclass,
                                'public.division_tieout_exceptions'::regclass] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = target)
       OR EXISTS (SELECT FROM pg_policy WHERE polrelid = target) THEN
      RAISE EXCEPTION 'division_tieout_rls';
    END IF;
    FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('authenticated', target, priv) OR has_table_privilege('anon', target, priv)
         OR has_table_privilege('service_role', target, priv) <>
           (priv IN ('SELECT','INSERT','UPDATE','DELETE')) THEN
        RAISE EXCEPTION 'division_tieout_privilege';
      END IF;
    END LOOP;
  END LOOP;
END $$;

SET LOCAL ROLE service_role;
DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-000000000044';
  cell public.division_tieout_cells%ROWTYPE;
  item public.division_tieout_exceptions%ROWTYPE;
BEGIN
  INSERT INTO public.division_tieout_cells (org_id, month, tracking_option, account_code, computed_at)
    VALUES (org, DATE '2000-01-01', 'test-option', 'test-account', now()) RETURNING * INTO cell;
  IF cell.xero_amount IS NOT NULL OR cell.difference IS NOT NULL OR cell.ours_amount <> 0
     OR cell.listed_amount <> 0 OR cell.ours_lines <> 0 THEN RAISE EXCEPTION 'division_cell_defaults'; END IF;

  INSERT INTO public.division_tieout_exceptions (org_id, month, tracking_option, account_code, amount, reason)
    VALUES (org, cell.month, cell.tracking_option, cell.account_code, 1.25, 'line_untagged') RETURNING * INTO item;
  IF item.holder <> 'bookkeeper' OR item.state <> 'open' THEN RAISE EXCEPTION 'division_exception_defaults'; END IF;

  BEGIN
    UPDATE public.division_tieout_exceptions SET reason = 'invalid' WHERE id = item.id;
    RAISE EXCEPTION 'invalid_reason_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.division_tieout_exceptions SET holder = 'invalid' WHERE id = item.id;
    RAISE EXCEPTION 'invalid_holder_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.division_tieout_exceptions SET state = 'invalid' WHERE id = item.id;
    RAISE EXCEPTION 'invalid_state_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.division_tieout_exceptions SET holder = 'ops', state = 'explained' WHERE id = item.id;
  BEGIN
    INSERT INTO public.division_tieout_exceptions (org_id, month, tracking_option, account_code, amount, reason)
      VALUES (org, cell.month, cell.tracking_option, cell.account_code, 2.50, item.reason);
    RAISE EXCEPTION 'duplicate_exception_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT FROM public.division_tieout_exceptions WHERE id = item.id
                 AND holder = 'ops' AND state = 'explained' AND amount = 1.25) THEN
    RAISE EXCEPTION 'division_exception_retry_changed_decision';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;
\echo PASS P3-04.4 tie-out constraints, service access and office decision on retry
