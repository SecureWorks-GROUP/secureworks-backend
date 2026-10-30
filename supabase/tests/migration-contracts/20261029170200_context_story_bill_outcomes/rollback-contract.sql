-- After 20261029170200_context_story_bill_outcomes_down.sql: the block is gone
-- and the four bodies are the story money book's (20261028190000) again, byte
-- for byte: a card's freshness hash no longer reads a bill_outcomes block.
\set ON_ERROR_STOP on
DO $$
DECLARE x record; live text;
BEGIN
  IF to_regprocedure('public.context_job_story_bill_outcomes(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'story bill outcomes rollback: the block function remains';
  END IF;
  FOR x IN SELECT * FROM (VALUES
    ('public.context_job_story_full_hash(jsonb)', '8ae3b1581ba96299ce107410e8ac5b39', 'Story money book (20261028190000)%'),
    ('public.context_job_story_text_get(uuid,jsonb,boolean)', '3cea9dd6df2d2f00660ccd8438637385', 'Story money book (20261028190000), job story text (20261009100000)%'),
    ('public.context_job_story_request(uuid,text,text)', '7a75f855aafb50a8821a106ff64ba173', 'Story money book (20261028190000), job story text (20261009100000)%'),
    ('public.context_job_story_writer_input(uuid)', '13097e3cc7abebfdeabff122bee66e1a', 'Story money book (20261028190000), job story text (20261009100000)%')
  ) v(sig, want, cmt) LOOP
    SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
    IF live IS DISTINCT FROM x.want THEN
      RAISE EXCEPTION 'story bill outcomes rollback: % md5 % (want the money book''s %)', x.sig, coalesce(live, '<missing>'), x.want;
    END IF;
    IF obj_description(to_regprocedure(x.sig), 'pg_proc') NOT LIKE x.cmt
       OR obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE '%Story bill outcomes (20261029170200)%' THEN
      RAISE EXCEPTION 'story bill outcomes rollback: % comment is not the money book''s', x.sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(x.sig), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(x.sig), 'EXECUTE')
       OR NOT has_function_privilege('service_role', to_regprocedure(x.sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'story bill outcomes rollback: % grants moved', x.sig;
    END IF;
  END LOOP;
  IF public.context_job_story_full_hash('{"job":{"id":"x"},"book":{"digest":"a"},"bill_outcomes":{"digest":"p"}}'::jsonb)
     IS DISTINCT FROM md5('story-digest-v1+story-book-v1|' || public.context_job_story_card_hash('{"job":{"id":"x"},"book":{"digest":"a"},"bill_outcomes":{"digest":"p"}}'::jsonb) || '|a') THEN
    RAISE EXCEPTION 'story bill outcomes rollback: the freshness hash still reads a bill_outcomes block';
  END IF;
  -- the H7 read it read is untouched
  IF to_regprocedure('public.context_job_bill_outcomes(uuid)') IS NULL THEN
    RAISE EXCEPTION 'story bill outcomes rollback: took the H7 read with it';
  END IF;
END $$;
