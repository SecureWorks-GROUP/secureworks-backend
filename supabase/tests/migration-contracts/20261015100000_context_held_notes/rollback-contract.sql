-- After the down migration: the five bodies are the 20261014120000 stack's again (their md5 as
-- production ran them on 15 Oct 2026), the helpers, trigger and column are gone, the switch row stays.
DO $c$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', '06e3e1cae99a50ec56308b74e7a1b03d'),
  ('public.context_ledger_judge(uuid[])', '92367db74677cd38612394056aac07fa'),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', 'b27d9f6c0abdd7174f38b0ed5e1ac5f0'),
  ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', '93ddf3979e8c0c3625c425a3934f4838'),
  ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', '9ba28fe55db39844b2a9b83dc448eaad')) v(sig, m) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.m THEN RAISE EXCEPTION 'held notes rollback: % is %, want %', x.sig, live, x.m; END IF;
  IF obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE 'Held notes (20261015100000)%' THEN
   RAISE EXCEPTION 'held notes rollback: % keeps this migration''s comment', x.sig;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('context_held_notes_on',
   'context_ledger_held_placed_copy', 'context_ledger_held_citable', 'context_ledger_held_cite', 'context_ledger_item_held_now',
   'context_job_story_held_marks', 'context_ledger_items_held_stamp')) THEN
  RAISE EXCEPTION 'held notes rollback: a helper is still there';
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_items' AND column_name = 'job_not_certain')
  OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'context_ledger_items_held_stamp') THEN
  RAISE EXCEPTION 'held notes rollback: the column or trigger is still there';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_held_notes_v1' AND NOT enabled) THEN
  RAISE EXCEPTION 'held notes rollback: the switch row is kept, off';
 END IF;
 -- the legacy surface still answers
 PERFORM public.context_ledger_judge(ARRAY[]::uuid[]);
END $c$;
