BEGIN;
DO $patch$
DECLARE
  body text := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
  prior text := $prior$
  -- Every participant, and every installer currently assigned to the job,
  -- needs a counting hour. An assigned person who has not joined is named
  -- the same way. Office removes a participant only before the freeze.
  SELECT string_agg(missing.user_id, ',' ORDER BY missing.user_id COLLATE "C")
    INTO v_needs_hours
  FROM (
    SELECT p.user_id::text AS user_id
    FROM public.group_work_order_participants p
    WHERE p.group_id = p_group_id
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = p.user_id
      )
    UNION
    SELECT DISTINCT a.user_id::text
    FROM public.job_assignments a
    WHERE a.job_id = v_job
      AND COALESCE(to_jsonb(a)->>'status', '') IS DISTINCT FROM 'cancelled'
      AND COALESCE(to_jsonb(a)->>'role', '') IS DISTINCT FROM 'observer'
      AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') IS DISTINCT FROM 'true'
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = a.user_id
      )
  ) missing;
$prior$;
  replacement text := $replacement$
  -- One population for automatic membership, readiness and both split modes.
  -- Explicit members remain obligations; a watching allocation adds nobody.
  SELECT string_agg(crew.user_id::text, ',' ORDER BY crew.user_id::text COLLATE "C")
    INTO v_needs_hours
  FROM public.group_work_order_crew(ARRAY[v_job]) crew
  WHERE NOT EXISTS (
    SELECT 1 FROM group_wo_entries e WHERE e.user_id = crew.user_id
  );
$replacement$;
BEGIN
  IF strpos(body, prior) > 0 THEN
    IF strpos(body, replacement) > 0 OR
       length(body) - length(replace(body, prior, '')) <> length(prior) THEN
      RAISE EXCEPTION 'group_split_crew_rollback_preimage_changed';
    END IF;
    RETURN;
  END IF;
  IF strpos(body, replacement) = 0 OR
     length(body) - length(replace(body, replacement, '')) <> length(replacement) THEN
    RAISE EXCEPTION 'group_split_crew_rollback_preimage_changed';
  END IF;
  EXECUTE replace(body, replacement, prior);
END $patch$;
DROP FUNCTION public.group_work_order_crew(uuid[]);
COMMIT;
