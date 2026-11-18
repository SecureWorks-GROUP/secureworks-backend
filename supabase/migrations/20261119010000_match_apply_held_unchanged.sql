-- P2-02.8 (director 02:45). A held bill writes no clue rows while its clues are unchanged.
--
-- With reconcile_matcher_v1 on, match_apply marks the bill's clues not current and inserts the
-- fresh ones BEFORE it reads the stop, so a bill held by a person (a line a person decided, or an
-- undo receipt) gets a new clue set on every pass of the sync, the queue and the backlog. Now,
-- with the switch on, a held bill whose fresh clues are the same as its current ones (the same
-- semantic key, reconcile_match_clue_key, in the same order) returns the stop and writes nothing.
-- A held bill whose clues CHANGED is still rewritten once and the stop is read again after, so an
-- undo receipt still lets go when the undone evidence is gone. Unchanged: the switch-off shadow
-- path (the shadow report reads one clue set per run), match_apply_stop, and every bill that is
-- not held.
--
-- PLACEHOLDER version: the keeper stamps the real one when the PR is marked ready.
--
-- Callable functions only: no table, index, trigger, schedule, switch or data write. The new
-- reads use match_clues_current_subject_idx (subject_kind, subject_id WHERE current) and the
-- match_clue_types primary key. match_apply is patched in place from its live body, keeping its
-- grants and settings, and refused unless the live body is main's (20261118195300's) or this one's.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE h text;
/* main's bodies, or this migration's own on a re-apply */ BEGIN
  SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid = to_regprocedure('public.match_clues_unchanged(text,text,jsonb,text)');
  IF h IS NOT NULL AND h <> 'f228062ecc1a3a69e266533282028e5e' THEN RAISE EXCEPTION 'match_apply_held_unchanged: match_clues_unchanged body changed'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'))
     IS DISTINCT FROM 'b011ec334de5208fffc613e5f6fe7fc9'
     AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'))
     IS DISTINCT FROM 'a63d82c7f7a24ea5a99c0933bec7352a' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: match_apply body changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.match_apply_stop(text)'))
     IS DISTINCT FROM 'b7ae6f0f0fbcdc47137b28f9022796d8'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.reconcile_match_clue_key(public.match_clues)'))
     IS DISTINCT FROM '02f37748d5e85a1d5aad7d71c13ca5a7' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: stop or clue key body changed';
  END IF;
END $guard$;

-- True when the fresh clues match the current run-written clues one for one, in order, by the same
-- semantic key undo uses. Type and root are read as match_apply would store them; an unknown type
-- or a bad value never matches, so the rewrite path refuses it as before.
CREATE OR REPLACE FUNCTION public.match_clues_unchanged(p_subject_kind text, p_subject_id text,
  p_clues jsonb, p_rule_version text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT (SELECT coalesce(array_agg(public.reconcile_match_clue_key(k) ORDER BY k.id), '{}')
            FROM public.match_clues k WHERE k.current AND k.kept_from IS NULL
             AND k.subject_kind = p_subject_kind AND k.subject_id = p_subject_id)
       = (SELECT coalesce(array_agg(md5(jsonb_build_array(c.v->>'clue_code', t.family, c.v->>'root',
            c.v->>'outcome', (c.v->>'job_id')::uuid, c.v->>'division', (c.v->>'names_one')::boolean,
            c.v->>'seen_where', c.v->>'seen_value', coalesce(c.v->'detail', '{}'), p_rule_version,
            NULL::text)::text) ORDER BY c.n), '{}')
            FROM jsonb_array_elements(p_clues) WITH ORDINALITY c(v, n)
            LEFT JOIN public.match_clue_types t ON t.code = c.v->>'clue_code')
$fn$;
REVOKE ALL ON FUNCTION public.match_clues_unchanged(text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_clues_unchanged(text,text,jsonb,text) TO service_role;

DO $matcher$
DECLARE sig regprocedure := 'public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure;
  h text; def text;
/* patch the checked live body in place, keeping its grants and settings */ BEGIN
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO STRICT h, def FROM pg_proc WHERE oid = sig;
  IF h = 'b011ec334de5208fffc613e5f6fe7fc9' THEN
    def := replace(def,
$old$  UPDATE public.match_clues k SET current = false WHERE k.current AND k.kept_from IS NULL
$old$,
$new$  -- A held bill whose clues are the ones already current writes nothing (P2-02.8).
  IF enabled_now THEN
    stop_reason := public.match_apply_stop(p_subject_id);
    IF stop_reason IS NOT NULL AND public.match_clues_unchanged(p_subject_kind,p_subject_id,p_clues,p_rule_version) THEN
      RETURN jsonb_build_object('applied',stop_reason);
    END IF;
  END IF;
  UPDATE public.match_clues k SET current = false WHERE k.current AND k.kept_from IS NULL
$new$);
    EXECUTE def;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = sig) <> 'a63d82c7f7a24ea5a99c0933bec7352a' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: match_apply patch did not apply';
  END IF;
END $matcher$;
