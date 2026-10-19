-- After the down migration: the three bodies are the ones production ran before this slice (their md5
-- as live on 19 Oct 2026) with their earlier comments, the ten helpers, the builder contact table, the
-- three columns and their check are gone, and the switch row stays, off.
DO $c$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_cite(uuid,jsonb)', '44b8faee5207fa4a4604dbcb25cbfc12'),
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', 'af976e59b8e6f35612d6383042d6e38e'),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', '6da1007ff2a6331219f4d98f85749ca7')) v(sig, m) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.m THEN RAISE EXCEPTION 'same payer close rollback: % is %, want %', x.sig, live, x.m; END IF;
  IF obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE '%Same payer close (20261019130000)%' THEN
   RAISE EXCEPTION 'same payer close rollback: % keeps this migration''s comment', x.sig;
  END IF;
  IF NOT has_function_privilege('service_role', x.sig, 'EXECUTE') OR has_function_privilege('anon', x.sig, 'EXECUTE')
   OR has_function_privilege('authenticated', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'same payer close rollback: % grants changed', x.sig;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('context_ledger_same_payer_close_on',
   'context_ledger_invoice_kind_of', 'context_ledger_obligation_kind', 'context_ledger_obligation_class', 'context_ledger_invoice_payer',
   'context_ledger_invoice_facts', 'context_ledger_obligation_job_facts', 'context_ledger_obligation_payer_match',
   'context_ledger_obligated_party', 'context_ledger_obligation_closes')) THEN
  RAISE EXCEPTION 'same payer close rollback: a helper is still there';
 END IF;
 IF to_regclass('public.context_ledger_builder_contacts') IS NOT NULL THEN
  RAISE EXCEPTION 'same payer close rollback: the builder contact table is still there';
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_items'
   AND column_name IN ('obligated_party', 'obligation_ref', 'certainty'))
  OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'context_ledger_items_certainty_check') THEN
  RAISE EXCEPTION 'same payer close rollback: a column or the certainty check is still there';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_ledger_same_payer_close_v1' AND NOT enabled) THEN
  RAISE EXCEPTION 'same payer close rollback: the switch row is kept, off';
 END IF;
 -- the legacy surface still answers
 PERFORM public.context_ledger_cite('00000000-0000-0000-0000-000000000000', '{"table":"job_events","id":"00000000-0000-0000-0000-000000000000"}');
 PERFORM public.context_ledger_check_item('00000000-0000-0000-0000-000000000000', '{}'::jsonb, 'model');
END $c$;
