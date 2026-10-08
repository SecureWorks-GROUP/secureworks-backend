-- Prerequisites for 20261008095000_context_ledger_pass_small_floor: nothing new. The function it
-- replaces, the tables its body reads (the run ledger, the ledger model and the store's receipts) and
-- the three roles it grants to come from earlier registered cases (20260911170001, 20261006010000,
-- 20261006013000). This checks they are there and that context_ledger_finish is the body production
-- runs (the 20261006013000 body, md5 0c02a410bb32f46315fbf278090ef60e); it adds nothing.
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'))
    IS DISTINCT FROM '0c02a410bb32f46315fbf278090ef60e' THEN
  RAISE EXCEPTION 'ledger pass small floor setup: context_ledger_finish is not the 20261006013000 body production runs (md5 0c02a410bb32f46315fbf278090ef60e)';
 END IF;
 FOREACH r IN ARRAY ARRAY['public.jobs', 'public.context_extraction_runs', 'public.context_ledger_generations', 'public.context_ledger_items',
   'public.context_ledger_writes', 'public.context_ledger_settings'] LOOP
  IF to_regclass(r) IS NULL THEN RAISE EXCEPTION 'ledger pass small floor setup: % is missing from the registered stack', r; END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'ledger pass small floor setup: role % is missing', r; END IF;
 END LOOP;
END $$;
