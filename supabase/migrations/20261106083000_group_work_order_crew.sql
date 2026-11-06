BEGIN;

-- Explicit group membership remains an obligation even after a role/allocation
-- changes. Only genuine non-admin allocations add people automatically.
CREATE OR REPLACE FUNCTION public.group_work_order_crew(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $crew$
  SELECT DISTINCT j.id, a.user_id
  FROM public.jobs j
  JOIN public.job_assignments a ON a.job_id = j.id
  JOIN public.users u ON u.id = a.user_id AND u.org_id = j.org_id
  WHERE j.id = ANY(COALESCE(p_job_ids, ARRAY[]::uuid[]))
    AND lower(COALESCE(u.role::text, '')) <> 'admin'
    AND lower(COALESCE(to_jsonb(a)->>'status', '')) <> 'cancelled'
    AND lower(COALESCE(to_jsonb(a)->>'role', '')) <> 'observer'
    AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') <> 'true'
  UNION
  SELECT g.job_id, p.user_id
  FROM public.group_work_orders g
  JOIN public.group_work_order_participants p ON p.group_id = g.id
  WHERE g.job_id = ANY(COALESCE(p_job_ids, ARRAY[]::uuid[]))
    AND g.status IS DISTINCT FROM 'void';
$crew$;

REVOKE ALL ON FUNCTION public.group_work_order_crew(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_crew(uuid[]) TO service_role;
COMMENT ON FUNCTION public.group_work_order_crew(uuid[]) IS
  'Read-only shared required crew: genuine non-admin allocations plus retained explicit group members. No group, hours, rate, sign-off or share write.';

-- Replace only the required-crew read. Preserve the installed money, sign-off,
-- locking and freeze code byte for byte, including later approved amendments.
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
  IF strpos(body, replacement) > 0 THEN RETURN; END IF;
  IF strpos(body, prior) = 0 OR
     length(body) - length(replace(body, prior, '')) <> length(prior) THEN
    RAISE EXCEPTION 'group_split_crew_preimage_changed';
  END IF;
  EXECUTE replace(body, prior, replacement);
END $patch$;

COMMIT;
