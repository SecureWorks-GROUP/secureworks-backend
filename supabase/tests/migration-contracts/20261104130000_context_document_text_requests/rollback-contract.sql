-- After the rollback: the ten bodies are production's pre-image again, the request surface is gone,
-- job_id is NOT NULL again with no record on no job, and the reader still lists and records.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_document_text_policy()','0c40a54309ab625cdc35c935026ef240'),
  ('public.context_document_text_sources()','3a8554d41d1b10718599c55d65e56110'),
  ('public.context_document_text_due(integer)','39a9301aabb3ee602b25ccaa0b7105eb'),
  ('public.record_context_document_text(jsonb)','a1cb2fdddb7a3f008274c7ca077282ba'),
  ('public.context_document_text_status()','5b0325757d95f2dc3497332b34108c44'),
  ('public.context_document_vision_due(integer)','82c241b4054ae531da2959ae93d752b8'),
  ('public.claim_context_document_vision(jsonb)','917a31afd7eabcace99f060bf8311a7c'),
  ('public.record_context_document_vision(jsonb)','318b0ff112334a6b7b012e46ae3d1be2'),
  ('public.context_document_vision_leased(uuid)','3c82eb91f1d3c457f9c003c274d5b594'),
  ('public.context_document_vision_status()','081a4f082618072351a8e9dfee6790f9')
 ) AS t(sig,md5) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'requests rollback: % is md5 %, not the pre-image %',x.sig,coalesce(live,'<missing>'),x.md5; END IF;
  IF has_function_privilege('anon',x.sig::regprocedure,'EXECUTE') OR has_function_privilege('authenticated',x.sig::regprocedure,'EXECUTE')
   OR NOT has_function_privilege('service_role',x.sig::regprocedure,'EXECUTE')
  THEN RAISE EXCEPTION 'requests rollback: grants on %',x.sig; END IF;
 END LOOP;
 IF to_regclass('public.context_document_text_requests') IS NOT NULL
  OR to_regprocedure('public.context_document_text_requested_due(integer)') IS NOT NULL
  OR to_regprocedure('public.context_document_vision_requested_due(integer)') IS NOT NULL
  OR to_regclass('public.context_document_texts_one_no_job') IS NOT NULL
  OR to_regclass('public.context_document_vision_reads_one_no_job') IS NOT NULL
 THEN RAISE EXCEPTION 'requests rollback: the request surface is still there'; END IF;
 IF NOT (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid='public.context_document_texts'::regclass AND a.attname='job_id')
  OR NOT (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid='public.context_document_vision_reads'::regclass AND a.attname='job_id')
 THEN RAISE EXCEPTION 'requests rollback: job_id is not NOT NULL again'; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN ('context_document_texts_no_job_attachment','context_document_vision_reads_no_job_attachment'))
 THEN RAISE EXCEPTION 'requests rollback: a no-job check is still there'; END IF;
 IF (SELECT obj_description('public.record_context_document_text(jsonb)'::regprocedure,'pg_proc')) LIKE '%20261104130000%'
  OR (SELECT obj_description('public.context_document_text_sources()'::regprocedure,'pg_proc')) NOT LIKE 'Every document on a live job (gap plan B-5;%'
 THEN RAISE EXCEPTION 'requests rollback: a comment was not restored'; END IF;
 -- The restored reader still lists and refuses as before.
 PERFORM * FROM public.context_document_text_due(5);
 PERFORM * FROM public.context_document_vision_due(5);
 PERFORM public.context_document_text_status();
 PERFORM public.context_document_vision_status();
END $$;
