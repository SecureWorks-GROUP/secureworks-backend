-- After the ledger store rollback: the 20261006001000 admission and both
-- phase lists are back, the ledger phase is refused, the store is gone, and
-- the ledger model's tables are untouched.
\set ON_ERROR_STOP on
DO $c$
DECLARE r jsonb;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure) <> 'f50de57b906f28fc9b5b286821d64cb1'
 THEN RAISE EXCEPTION 'ledger store rollback: the admission is not the 20261006001000 body'; END IF;
 IF NOT has_function_privilege('service_role', 'public.reserve_context_model_call(text,uuid,uuid)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.reserve_context_model_call(text,uuid,uuid)', 'EXECUTE')
 THEN RAISE EXCEPTION 'ledger store rollback: admission grants'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_extraction_runs'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$d$)
  OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text])))$d$)
 THEN RAISE EXCEPTION 'ledger store rollback: phase checks not restored'; END IF;
 IF obj_description('public.reserve_context_model_call(text,uuid,uuid)'::regprocedure, 'pg_proc') IS NOT NULL
 THEN RAISE EXCEPTION 'ledger store rollback: the admission keeps the ledger comment (it had none)'; END IF;
 BEGIN
  r := public.reserve_context_model_call('ledger', gen_random_uuid(), gen_random_uuid());
  RAISE EXCEPTION 'ledger store rollback: the ledger phase is still admitted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Invalid model call identity' THEN RAISE; END IF;
 END;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
   AND p.proname IN ('context_ledger_text_norm','context_ledger_message_kind','context_ledger_row_admissible','context_ledger_evidence_rows',
    'context_ledger_current_generation','context_ledger_judge','context_ledger_due','context_ledger_claim','context_ledger_packet',
    'context_ledger_cite','context_ledger_check_item','context_ledger_write','context_ledger_carry_forward','context_ledger_promote',
    'context_ledger_finish','context_ledger_person_edit','context_ledger_checks_pass','context_ledger_promote_shadow','context_ledger_failures',
    'context_ledger_budget','context_ledger_backfill_open','context_ledger_party_keys','context_ledger_call_customer'))
  OR to_regclass('public.context_ledger_writes') IS NOT NULL
 THEN RAISE EXCEPTION 'ledger store rollback: store objects left behind'; END IF;
 IF to_regclass('public.context_ledger_items') IS NULL OR to_regclass('public.context_ledger_generations') IS NULL
  OR to_regclass('public.context_ledger_transitions') IS NULL OR to_regclass('public.context_ledger_settings') IS NULL
 THEN RAISE EXCEPTION 'ledger store rollback: removed a ledger model table it does not own'; END IF;
END $c$;
