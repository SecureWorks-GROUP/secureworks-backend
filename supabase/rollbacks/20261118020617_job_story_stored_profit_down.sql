SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE spec record; h text;
/* function block */ BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('public.context_job_story_book(uuid,timestamptz)','62d11c1c91fba84c7d6ca5ab3bafda32'),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)','da7e2486ccfb3f5e43094cfbe8a98477')
 ) s(sig,want) LOOP
  SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure(spec.sig);
  IF h IS DISTINCT FROM spec.want THEN RAISE EXCEPTION 'story_stored_profit_down_preimage: % %',spec.sig,h; END IF;
 END LOOP;
END $guard$;
DO $restore$
DECLARE spec text; f text;
BEGIN
 FOREACH spec IN ARRAY ARRAY['context_job_story_book(uuid,timestamptz)','context_job_story_text_get(uuid,jsonb,boolean)'] LOOP
  SELECT pg_get_functiondef(to_regprocedure('public.'||replace(spec,'(', '_profit_live('))) INTO f;
  IF f IS NULL THEN RAISE EXCEPTION 'story_stored_profit_original_missing: %',spec; END IF;
  EXECUTE replace(f,'_profit_live(', '(');
 END LOOP;
END $restore$;
DROP FUNCTION public.context_job_story_book_profit_stored(uuid,timestamptz);
DROP FUNCTION public.context_job_story_money_sig_profit_stored(uuid);
DROP FUNCTION public.context_job_story_book_profit_live(uuid,timestamptz);
DROP FUNCTION public.context_job_story_money_sig_profit_live(uuid);
DROP FUNCTION public.context_job_story_text_get_profit_live(uuid,jsonb,boolean);
DROP FUNCTION public.job_story_stored_profit_on();
DELETE FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1';
