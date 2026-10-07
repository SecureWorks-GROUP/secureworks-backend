-- Report red rows to no one and still read green: the status read is wrapped
-- so a lane whose only red reason is the missing reader receipt reads green,
-- which is the defect the receipt rule exists to stop (the lane went green on
-- pg_cron alone while nobody received the red rows). The wrapper keeps the
-- name, security, comment and access, so only the receipt check can catch it.
ALTER FUNCTION public.context_scorecard_run_status(timestamptz) RENAME TO context_scorecard_run_status_unwrapped;
CREATE FUNCTION public.context_scorecard_run_status(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
 SELECT CASE WHEN s->'lane'->>'status' = 'red' AND s->'lane'->>'note' LIKE 'red rows reported to no reader%'
              AND position('; ' IN s->'lane'->>'note') = 0
             THEN jsonb_set(s, '{lane,status}', '"green"') ELSE s END
 FROM (SELECT public.context_scorecard_run_status_unwrapped(p_as_of) AS s) x
$$;
COMMENT ON FUNCTION public.context_scorecard_run_status(timestamptz) IS
 'Context scorecard hourly (20261007040000): break proof wrapper that ignores the reader receipt.';
REVOKE ALL ON FUNCTION public.context_scorecard_run_status(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_scorecard_run_status(timestamptz) TO service_role;
