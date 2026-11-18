SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE f record;
/* permit only an exact reapplication */ BEGIN
  FOR f IN SELECT p.oid::regprocedure::text sig, md5(p.prosrc) body FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('match_lock_cost_document','match_requeue','match_clue_add','match_apply_stop','match_apply')
  LOOP
    IF (f.sig,f.body) NOT IN (
      ('match_lock_cost_document(text)','c59bc534138571fda5d1b4c9c83d5731'),
      ('match_requeue(text,text,text)','fed2e3fb935261e3752bafc839a39276'),
      ('match_clue_add(text,text,uuid,text,text,jsonb,text)','b693ff4260774c5fa114bd498d7516fc'),
      ('match_apply_stop(text)','e5382283d43345f54b314a6fdf6fc897'),
      ('match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)','2d37c485e29e0a9a1a2b59985417741f')) THEN RAISE EXCEPTION 'match_function_body_changed'; END IF;
  END LOOP;
END $guard$;
DROP FUNCTION IF EXISTS public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text);
DROP FUNCTION IF EXISTS public.match_apply_stop(text);
DROP FUNCTION IF EXISTS public.match_clue_add(text,text,uuid,text,text,jsonb,text);
DROP FUNCTION IF EXISTS public.match_requeue(text,text,text);
DROP FUNCTION IF EXISTS public.match_lock_cost_document(text);
