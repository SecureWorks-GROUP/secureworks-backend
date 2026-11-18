SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE sig regprocedure := 'public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure;
  h text; def text; f record;
/* reverse only the two checked edits */ BEGIN
  FOR f IN SELECT p.oid::regprocedure sig, md5(p.prosrc) hash FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
      ('reconcile_undo','reconcile_undo_lines','reconcile_match_clue_key')
  LOOP
    IF (f.sig::text,f.hash) NOT IN (
      ('reconcile_undo(bigint,uuid)','8d34d85b018204c72d7db66ea915dcda'),
      ('reconcile_undo_lines(uuid,text,text)','4dbbeb9de37f716bf9210ce55053a43e'),
      ('reconcile_match_clue_key(match_clues)','02f37748d5e85a1d5aad7d71c13ca5a7')
    ) THEN RAISE EXCEPTION 'reconcile_undo_body_changed'; END IF;
  END LOOP;
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO STRICT h,def FROM pg_proc WHERE oid=sig;
  IF h = 'b011ec334de5208fffc613e5f6fe7fc9' THEN
    def := replace(def,$new$'run_hash',run_hash,'item_kind',p_item_kind,'lines'$new$,$old$'run_hash',run_hash,'lines'$old$);
    def := replace(def,$new$'status',item.status,'summary',item.summary,$new$,$old$'status',item.status,$old$);
    EXECUTE def;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=sig) <> '2d37c485e29e0a9a1a2b59985417741f'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.match_apply_stop(text)'::regprocedure)
       NOT IN ('b7ae6f0f0fbcdc47137b28f9022796d8','e5382283d43345f54b314a6fdf6fc897') THEN
    RAISE EXCEPTION 'reconcile_undo_body_changed';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.match_apply_stop(p_subject_id text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT 'held_by_person'::text WHERE EXISTS (
    SELECT FROM public.job_cost_lines l WHERE l.document_kind = split_part(p_subject_id,':',1)
    AND l.document_id = substr(p_subject_id,strpos(p_subject_id,':')+1) AND l.decided_by_kind = 'person')
$fn$;

DROP FUNCTION IF EXISTS public.reconcile_undo(bigint,uuid);
DROP FUNCTION IF EXISTS public.reconcile_undo_lines(uuid,text,text);
DROP FUNCTION IF EXISTS public.reconcile_match_clue_key(public.match_clues);
