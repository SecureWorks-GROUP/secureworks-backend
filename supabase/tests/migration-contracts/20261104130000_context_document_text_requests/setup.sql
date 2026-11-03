-- Requests setup: every table and function this migration reads already exists in the earlier
-- registered fixtures (jobs, job_documents, business_events and the ladder, context_email_attachments,
-- the B-5 document text records and the B-5b vision records). A check that the fixtures leave exactly
-- production's pre-image of the ten bodies this migration replaces (read from production 3 Nov 2026).
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
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'requests setup: % is md5 %, not production''s pre-image %',x.sig,coalesce(live,'<missing>'),x.md5; END IF;
 END LOOP;
END $$;
