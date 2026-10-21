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

-- Keep the full seed atomic. Separate HTTP RPC calls cannot roll back an
-- earlier chunk when a later chunk fails, so the database owns the loop.
CREATE OR REPLACE FUNCTION public.seed_makesafe_state_authority_atomic_v1(
  p_run_key text,
  p_applied_by text,
  p_selection_hash text,
  p_job_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_offset integer := 1;
  v_end integer;
  v_chunk uuid[];
  v_chunk_result jsonb;
  v_chunks jsonb := '[]'::jsonb;
  v_requested integer := cardinality(p_job_ids);
  v_accounted integer := 0;
  v_seeded integer := 0;
  v_skipped integer := 0;
BEGIN
  IF v_requested IS NULL OR v_requested < 1 THEN
    RAISE EXCEPTION 'p_job_ids must contain at least one job';
  END IF;

  WHILE v_offset <= v_requested LOOP
    v_end := LEAST(v_offset + 499, v_requested);
    v_chunk := p_job_ids[v_offset:v_end];
    v_chunk_result := public.seed_makesafe_state_authority_scoped_v2(
      format('%s:chunk-%s-of-%s', p_run_key, ((v_offset - 1) / 500) + 1,
        CEIL(v_requested::numeric / 500)::integer),
      p_applied_by,
      p_selection_hash,
      v_chunk
    );
    v_chunks := v_chunks || jsonb_build_array(v_chunk_result);
    v_accounted := v_accounted + (v_chunk_result->>'accounted')::integer;
    v_seeded := v_seeded + (v_chunk_result->>'seeded')::integer;
    v_skipped := v_skipped + (v_chunk_result->>'skipped')::integer;
    v_offset := v_end + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'requested', v_requested,
    'accounted', v_accounted,
    'seeded', v_seeded,
    'skipped', v_skipped,
    'completed_chunks', jsonb_array_length(v_chunks),
    'chunk_count', jsonb_array_length(v_chunks),
    'chunks', v_chunks
  );
END;
$$;

REVOKE ALL ON FUNCTION public.seed_makesafe_state_authority_atomic_v1(
  text, text, text, uuid[]
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_makesafe_state_authority_atomic_v1(
  text, text, text, uuid[]
) TO service_role;
