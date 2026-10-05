-- After the B-5b rollback: the A1 admission and the three-phase check are
-- back, the vision phase is refused, and the vision reader's objects are gone.
DO $$
DECLARE r jsonb;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)<>'86bfd48365b6aa26c4400ec2b5d476c3'
 THEN RAISE EXCEPTION 'b5b rollback: reservation body not the A1 body'; END IF;
 IF NOT has_function_privilege('service_role','public.reserve_context_model_call(text,uuid,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.reserve_context_model_call(text,uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'b5b rollback: reservation grants'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_model_call_reservations'::regclass AND contype='c'
   AND pg_get_constraintdef(oid)=$d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$d$)
 THEN RAISE EXCEPTION 'b5b rollback: three-phase check not restored'; END IF;
 BEGIN
  r:=public.reserve_context_model_call('vision',NULL,NULL);
  RAISE EXCEPTION 'b5b rollback: vision still admitted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'Invalid model call identity' THEN RAISE; END IF;
 END;
 IF to_regclass('public.context_document_vision_reads') IS NOT NULL
  OR to_regclass('public.context_document_vision_settings') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_policy()') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_flag()') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_daily_cap()') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_due(integer)') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_backoff(integer)') IS NOT NULL
  OR to_regprocedure('public.claim_context_document_vision(jsonb)') IS NOT NULL
  OR to_regprocedure('public.record_context_document_vision(jsonb)') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_leased(uuid)') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_admission()') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_status()') IS NOT NULL
 THEN RAISE EXCEPTION 'b5b rollback: objects left behind'; END IF;
 -- B-5 is untouched.
 IF to_regclass('public.context_document_texts') IS NULL OR to_regprocedure('public.context_document_text_sources()') IS NULL
 THEN RAISE EXCEPTION 'b5b rollback: the text reader lost an object'; END IF;
END $$;
