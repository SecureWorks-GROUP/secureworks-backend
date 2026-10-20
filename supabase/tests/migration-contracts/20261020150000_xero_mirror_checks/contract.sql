-- Contract for 20261020150000_xero_mirror_checks.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. The table: row-level security on, exactly one policy, for the service role only,
--    and nothing granted to anon or authenticated.
DO $$
BEGIN
  IF to_regclass('public.xero_mirror_checks') IS NULL THEN
    RAISE EXCEPTION 'contract: xero_mirror_checks is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.xero_mirror_checks'::regclass) THEN
    RAISE EXCEPTION 'xero_mirror_checks requires row-level security';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'xero_mirror_checks') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'xero_mirror_checks'
                   AND NOT (roles = ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'contract: xero_mirror_checks must carry exactly one service-role policy';
  END IF;
  IF has_table_privilege('anon', 'public.xero_mirror_checks', 'SELECT')
     OR has_table_privilege('authenticated', 'public.xero_mirror_checks', 'SELECT') THEN
    RAISE EXCEPTION 'contract: anon or authenticated can read xero_mirror_checks';
  END IF;
  IF to_regclass('public.idx_xero_mirror_checks_recent') IS NULL THEN
    RAISE EXCEPTION 'contract: idx_xero_mirror_checks_recent is missing';
  END IF;
END $$;

-- 2. A complete check carries both sides' figures; an incomplete one may carry none.
BEGIN;
INSERT INTO public.xero_mirror_checks
  (complete, matches, xero_count, xero_total, copy_count, copy_total, differ_count,
   differences, drafts_count, drafts_total)
VALUES
  (true, false, 87, 108034.14, 82, 104681.66, 1,
   '[{"invoice_number": "INV-0001", "reason": "missing_from_copy"}]'::jsonb, 3, 1200.00),
  (false, NULL, NULL, NULL, NULL, NULL, 0, '[]'::jsonb, NULL, NULL);
DO $$
DECLARE
  v_refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.xero_mirror_checks (complete, matches) VALUES (true, true);
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'contract: a complete check without figures was accepted';
  END IF;
  v_refused := false;
  BEGIN
    INSERT INTO public.xero_mirror_checks (complete, differences)
    VALUES (false, '{"not": "a list"}'::jsonb);
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'contract: differences that are not a list were accepted';
  END IF;
  IF (SELECT count(*) FROM public.xero_mirror_checks) <> 2 THEN
    RAISE EXCEPTION 'contract: expected the two fixture rows';
  END IF;
  IF (SELECT org_id FROM public.xero_mirror_checks WHERE complete LIMIT 1)
     IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'contract: org_id default is wrong';
  END IF;
END $$;
ROLLBACK;

-- 3. Re-applying the migration is a no-op.
BEGIN;
\ir ../../../migrations/20261020150000_xero_mirror_checks.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'xero_mirror_checks') <> 1 THEN
    RAISE EXCEPTION 'contract: re-applying changed the policies';
  END IF;
END $$;
ROLLBACK;
