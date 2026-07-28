-- Correct the state-authority seed's case-candidate alias.
--
-- case_candidates exposes (job_id, case_id), but the downstream aggregate
-- referenced c.id. PostgreSQL therefore aborted the live seed before any
-- per-chunk seed ledger row could commit. This migration replaces only that
-- aggregate fragment. It performs no seed, status change, communication, or
-- financial write.

DO $migration$
DECLARE
  v_definition text;
  v_old_fragment text := $old$
      count(c.id) AS case_count,
      (array_agg(c.id ORDER BY c.id))[1] AS case_id
$old$;
  v_new_fragment text := $new$
      count(c.case_id) AS case_count,
      (array_agg(c.case_id ORDER BY c.case_id))[1] AS case_id
$new$;
  v_occurrences integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.seed_makesafe_state_authority_v1(text,text,text,uuid[])'::regprocedure
  )
  INTO STRICT v_definition;

  IF strpos(v_definition, v_new_fragment) > 0
     AND strpos(v_definition, v_old_fragment) = 0 THEN
    RETURN;
  END IF;

  v_occurrences := (
    length(v_definition) - length(replace(v_definition, v_old_fragment, ''))
  ) / length(v_old_fragment);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION
      'state seed case alias correction expected one legacy fragment, found %',
      v_occurrences;
  END IF;

  EXECUTE replace(v_definition, v_old_fragment, v_new_fragment);

  SELECT pg_get_functiondef(
    'public.seed_makesafe_state_authority_v1(text,text,text,uuid[])'::regprocedure
  )
  INTO STRICT v_definition;
  IF strpos(v_definition, v_new_fragment) = 0
     OR strpos(v_definition, v_old_fragment) > 0 THEN
    RAISE EXCEPTION 'state seed case alias correction did not install';
  END IF;
END;
$migration$;
