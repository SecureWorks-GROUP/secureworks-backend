-- After the undo context_ledger_same_loop is the 20261104050000 definition again (md5 d105e91c..., its comment), with its
-- grants: a claim and an ask on one invoice are two loops again, an ask and the matching promise still one.
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure)) <> 'd105e91c2c30b2141d424bb53f7d6106' THEN
  RAISE EXCEPTION 'same loop matter rollback: not the old definition (md5 %)',
   md5(pg_get_functiondef('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure));
 END IF;
 IF obj_description('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure, 'pg_proc') NOT LIKE '(20261104050000)%' THEN
  RAISE EXCEPTION 'same loop matter rollback: not the old comment';
 END IF;
 IF NOT has_function_privilege('service_role', 'public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)', 'EXECUTE')
 OR has_function_privilege('anon', 'public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)', 'EXECUTE') THEN
  RAISE EXCEPTION 'same loop matter rollback: grants';
 END IF;
END $$;
