-- After the down migration: the story safety (20261006040000) bodies of the job record's messages
-- and the story meta and the story settled notes (20261011120000) assembler are back word for word,
-- both card helpers are gone, and the decision store is untouched.
\set ON_ERROR_STOP 1
DO $$
DECLARE x record; live text;
BEGIN
  FOR x IN SELECT * FROM (VALUES
    ('public.context_job_record_messages(uuid[],timestamptz)', '4be90ba0880f757464646a86bde76e1a'),
    ('public.context_job_story_meta(uuid,timestamptz)', '184af6a89d7bc188878c545400f64e68'),
    ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', '209d903df7a8732b4773dee0f0741593')
  ) v(sig, m) LOOP
    SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
    IF live IS DISTINCT FROM x.m THEN
      RAISE EXCEPTION 'card events rollback: % md5 % (want %)', x.sig, coalesce(live, '<missing>'), x.m;
    END IF;
  END LOOP;
  IF obj_description('public.context_job_record_messages(uuid[],timestamptz)'::regprocedure, 'pg_proc') LIKE '%card events (20261021150000)%'
     OR obj_description('public.context_job_story_meta(uuid,timestamptz)'::regprocedure, 'pg_proc') LIKE '%card events (20261021150000)%'
     OR obj_description('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure, 'pg_proc') LIKE '%card events (20261021150000)%' THEN
    RAISE EXCEPTION 'card events rollback: a comment still names this migration';
  END IF;
  IF to_regprocedure('public.context_job_card_events(uuid[])') IS NOT NULL
     OR to_regprocedure('public.context_job_card_decisions(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'card events rollback: a helper remains';
  END IF;
  IF to_regprocedure('public.context_event_jobs(uuid)') IS NULL OR to_regprocedure('public.context_recon_job_items(uuid)') IS NULL
     OR to_regclass('public.context_reconciliation_decisions') IS NULL THEN
    RAISE EXCEPTION 'card events rollback: the decision store or the job items read was touched';
  END IF;
END $$;
