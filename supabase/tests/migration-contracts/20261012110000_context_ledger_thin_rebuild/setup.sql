-- Prerequisites for 20261012110000_context_ledger_thin_rebuild: nothing new. The function it replaces,
-- the tables its guard reads (the run ledger, the ledger model, the store's receipts and settings) and
-- the roles it grants to come from earlier registered cases (20260911170001, 20261006010000,
-- 20261006013000, 20261007160000). This checks they are there and that context_ledger_finish is the
-- body production runs (the 20261007160000 body, md5 110174bcd355a82568fd7bc572d414f6); it adds
-- nothing, so no fixture row outlives a contract.
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'))
    IS DISTINCT FROM '110174bcd355a82568fd7bc572d414f6' THEN
  RAISE EXCEPTION 'thin rebuild setup: context_ledger_finish is not the 20261007160000 body production runs (md5 110174bcd355a82568fd7bc572d414f6)';
 END IF;
 FOREACH r IN ARRAY ARRAY['public.jobs', 'public.context_extraction_runs', 'public.context_ledger_generations', 'public.context_ledger_items',
   'public.context_ledger_writes', 'public.context_ledger_settings'] LOOP
  IF to_regclass(r) IS NULL THEN RAISE EXCEPTION 'thin rebuild setup: % is missing from the registered stack', r; END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['public.context_ledger_checks_pass(jsonb)', 'public.context_ledger_carry_forward(uuid,uuid)',
   'public.context_ledger_promote(uuid,text)', 'public.context_ledger_promote_shadow(text,uuid[],integer)',
   'public.context_ledger_failures(uuid[])', 'public.context_ledger_judge(uuid[])'] LOOP
  IF to_regprocedure(r) IS NULL THEN RAISE EXCEPTION 'thin rebuild setup: % is missing from the registered stack', r; END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'thin rebuild setup: role % is missing', r; END IF;
 END LOOP;
END $$;
