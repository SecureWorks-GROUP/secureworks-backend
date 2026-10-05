-- B-5b setup: every table and function this migration reads already exists in
-- the earlier registered fixtures (jobs, job_documents, the B-5 document text
-- records and sources, business_events and its writer, feature_flags, the
-- switches, the model call reservations and their A1 admission). A check that
-- the fixtures leave exactly the pre-image of the one function this migration
-- replaces (the A1 reservation body, 20260924060000) and of the B-5 sources.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)')) IS DISTINCT FROM '86bfd48365b6aa26c4400ec2b5d476c3'
 THEN RAISE EXCEPTION 'b5b setup: reserve_context_model_call is not the 20260924060000 body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_document_text_sources()')) IS DISTINCT FROM '3a8554d41d1b10718599c55d65e56110'
 THEN RAISE EXCEPTION 'b5b setup: context_document_text_sources is not the 20261005210000 body'; END IF;
END $$;
