-- After the rollback: both bodies and their comments are the 20261104130000 pre-image byte for byte,
-- and the closer is gone.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.record_context_document_text(jsonb)','c09711fa2928f366daecb41deed7e3ed','a59aa255de058d63117651d498a7ca6f'),
  ('public.context_document_text_status()','69cafa2747e11a63c10179195054865a','43189a413ba4e8438ca88a6480ec1c18')
 ) AS t(sig,body,note) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.body THEN RAISE EXCEPTION 'stuck rollback: % body md5 %',x.sig,coalesce(live,'<missing>'); END IF;
  IF md5(obj_description(to_regprocedure(x.sig),'pg_proc')) IS DISTINCT FROM x.note THEN RAISE EXCEPTION 'stuck rollback: % comment not restored',x.sig; END IF;
  IF has_function_privilege('anon',to_regprocedure(x.sig),'EXECUTE') OR NOT has_function_privilege('service_role',to_regprocedure(x.sig),'EXECUTE')
  THEN RAISE EXCEPTION 'stuck rollback: % grants changed',x.sig; END IF;
 END LOOP;
 IF to_regprocedure('public.close_stale_context_document_text_runs()') IS NOT NULL THEN RAISE EXCEPTION 'stuck rollback: the closer is still there'; END IF;
END $$;
