-- After the saved job story's rollback: the admission is the call budget body
-- (20261006060000) again, byte for byte, with its comment; the reservations'
-- phase list is the ledger store's; both tables, every story function and the
-- switch row are gone; every other flag row and the story card stay. Then:
-- story calls already made stay (the list narrows NOT VALID around them and
-- refuses a new one), and the migration applies again over its own rollback.
\set ON_ERROR_STOP on

DO $$
DECLARE f text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)
    IS DISTINCT FROM '0d741538d7874ce63d48e54d8645d18c' THEN
  RAISE EXCEPTION 'story text rollback: the admission is not the call budget body';
 END IF;
 IF md5(obj_description('public.reserve_context_model_call(text,uuid,uuid)'::regprocedure, 'pg_proc')) IS DISTINCT FROM '447301f37db2c45b6b2cecc299619676' THEN
  RAISE EXCEPTION 'story text rollback: the admission comment is not the call budget''s';
 END IF;
 IF (SELECT string_agg(pg_get_constraintdef(oid), ' | ') FROM pg_constraint
     WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%phase = ANY%')
    IS DISTINCT FROM $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$d$ THEN
  RAISE EXCEPTION 'story text rollback: the phase list is not the ledger store''s';
 END IF;
 IF to_regclass('public.context_job_story_texts') IS NOT NULL OR to_regclass('public.context_job_story_requests') IS NOT NULL THEN
  RAISE EXCEPTION 'story text rollback: a story table was left behind';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_job_story_text_policy()', 'public.context_job_story_text_on()',
   'public.context_job_story_sections_problem(jsonb)', 'public.context_job_story_checks_problem(jsonb)',
   'public.context_job_story_digest_num(jsonb)', 'public.context_job_story_digest_at(jsonb)', 'public.context_job_story_card_hash(jsonb)',
   'public.context_job_story_reading(uuid)', 'public.context_job_story_record_sig(uuid)', 'public.context_job_story_claim_state(uuid)',
   'public.context_job_story_budget()', 'public.context_job_story_text_get(uuid,jsonb,boolean)', 'public.context_job_story_request(uuid,text,text)',
   'public.context_job_story_enqueue_changed(integer)', 'public.context_job_story_claim(integer)', 'public.context_job_story_writer_input(uuid)',
   'public.context_job_story_text_save(uuid,uuid,uuid,jsonb,text,timestamptz,uuid,text,text,jsonb)',
   'public.context_job_story_request_finish(uuid,uuid,text,text,timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'story text rollback: % was left behind', f; END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_proc WHERE coalesce(obj_description(oid, 'pg_proc'), '') LIKE 'Job story text (20261009100000)%') THEN
  RAISE EXCEPTION 'story text rollback: a function of this migration was left behind';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1') THEN
  RAISE EXCEPTION 'story text rollback: the switch row was left behind';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1') THEN
  RAISE EXCEPTION 'story text rollback: another flag row was lost';
 END IF;
 IF to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)') IS NULL
    OR to_regprocedure('public.context_job_story_ledger(uuid,uuid,timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'story text rollback: the story card was dropped';
 END IF;
 -- A story call is refused again (the call budget body knows no story phase).
 BEGIN
  PERFORM public.reserve_context_model_call('story', NULL, NULL);
  RAISE EXCEPTION 'story text rollback: a story call was admitted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Invalid model call identity' THEN RAISE; END IF;
 END;
END $$;

-- Story calls already made stay: the list narrows NOT VALID around them, and
-- the migration applies again over its own rollback.
BEGIN;
\ir ../../../migrations/20261009100000_context_job_story_text.sql
INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
VALUES ((now() AT TIME ZONE 'Australia/Perth')::date - 400, 1, 'story', now() - interval '400 days');
\ir ../../../rollbacks/20261009100000_context_job_story_text_down.sql
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c' AND NOT convalidated
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text]))) NOT VALID$d$) THEN
  RAISE EXCEPTION 'story text rollback: the phase list did not narrow NOT VALID around a kept story call';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.context_model_call_reservations WHERE phase = 'story') THEN
  RAISE EXCEPTION 'story text rollback: a story call was deleted';
 END IF;
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  VALUES ((now() AT TIME ZONE 'Australia/Perth')::date - 400, 2, 'story', now() - interval '400 days');
  RAISE EXCEPTION 'story text rollback: a new story call was stored after the rollback';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
\ir ../../../migrations/20261009100000_context_job_story_text.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)
    IS DISTINCT FROM '25a5b5f208af726d47e952f98cecef56' THEN
  RAISE EXCEPTION 'story text rollback: the migration did not apply again over its own rollback';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c' AND convalidated
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text, 'story'::text])))$d$)
  OR (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1' AND NOT enabled) <> 1 THEN
  RAISE EXCEPTION 'story text rollback: the second apply is not whole';
 END IF;
END $$;
ROLLBACK;
