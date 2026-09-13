-- Restore the pre-awaiting_pack state check. contract.sql must then fail when
-- inserting awaiting_pack.
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
      'unknown'
    )
  );
