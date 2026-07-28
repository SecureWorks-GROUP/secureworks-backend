DROP FUNCTION IF EXISTS public.seed_makesafe_state_authority_scoped_v2(
  text, text, text, uuid[]
);

DROP TABLE IF EXISTS public.makesafe_state_seed_scope_runs;

DO $migration$
DECLARE
  v_definition text;
  v_canonical_guard text :=
    'AND (j.type = ''makesafe'' OR (j.type = ''insurance'' AND j.metadata->>''insurance_job_type'' = ''restoration''));';
  v_legacy_guard text := 'AND j.type = ''makesafe'';';
  v_occurrences integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.seed_makesafe_state_authority_v1(text,text,text,uuid[])'::regprocedure
  )
  INTO STRICT v_definition;

  IF strpos(v_definition, v_legacy_guard) > 0 THEN
    RETURN;
  END IF;

  v_occurrences := (
    length(v_definition) -
      length(replace(v_definition, v_canonical_guard, ''))
  ) / length(v_canonical_guard);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION
      'seed scope rollback expected exactly one canonical guard, found %',
      v_occurrences;
  END IF;

  EXECUTE replace(v_definition, v_canonical_guard, v_legacy_guard);
END;
$migration$;
