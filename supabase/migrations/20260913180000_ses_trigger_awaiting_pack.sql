-- SES trigger: awaiting_pack means the docket was prepared but Docs Ready
-- pointers are not bound. Drain must not auto-bind or mint. Board Watch /
-- terminal / UI join the same run_id. Isolated tests cover bind reuse.

ALTER TABLE public.ses_report_trigger_runs
  DROP CONSTRAINT IF EXISTS ses_report_trigger_runs_state_check;

ALTER TABLE public.ses_report_trigger_runs
  ADD CONSTRAINT ses_report_trigger_runs_state_check CHECK (
    state IN (
      'pending',
      'claimed',
      'done',
      'refused_stale',
      'refused_conflict',
      'refused_gate',
      'failed',
      'unknown',
      'awaiting_pack'
    )
  );

COMMENT ON COLUMN public.ses_report_trigger_runs.state IS
  'pending/claimed/done/refused_*/failed/unknown plus awaiting_pack: docket prepared, Build Pack bind still owed. awaiting_pack is not auto-drained.';

-- Explicit run_id may claim awaiting_pack. Drain next() still ignores it so
-- production cannot auto-bind.
CREATE OR REPLACE FUNCTION public.claim_ses_report_trigger_run(
  p_run_id uuid,
  p_owner text,
  p_lease_seconds integer DEFAULT 600
)
RETURNS SETOF public.ses_report_trigger_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.ses_report_trigger_runs;
  v_max_attempts constant integer := 6;
  v_increment integer := 1;
BEGIN
  SELECT * INTO v_row
    FROM public.ses_report_trigger_runs
   WHERE id = p_run_id
     AND (
       state = 'pending'
       OR state = 'awaiting_pack'
       OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
       OR (state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
     )
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_row.state = 'awaiting_pack' THEN
    v_increment := 0;
  END IF;
  IF v_row.attempts >= v_max_attempts THEN
    UPDATE public.ses_report_trigger_runs
       SET state = 'unknown',
           last_error = coalesce(last_error, '') || ' | attempt ceiling reached at claim',
           recovery_action = 'attempts exhausted: read back the docket by dedupe key, then mark done or refile',
           claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE id = p_run_id;
    RETURN;
  END IF;
  UPDATE public.ses_report_trigger_runs
     SET state = 'claimed',
         attempts = attempts + v_increment,
         claimed_by = p_owner,
         claimed_at = clock_timestamp(),
         claim_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => greatest(30, least(p_lease_seconds, 1800))),
         updated_at = clock_timestamp()
   WHERE id = p_run_id
   RETURNING * INTO v_row;
  RETURN NEXT v_row;
END;
$$;
