-- One-switch runtime rollback for deterministic make-safe intake.
-- Captain approval is required before execution. This preserves the append-only
-- canonical case/evidence ledger and changes no jobs, drafts, communications or money.

UPDATE public.makesafe_cron_settings
SET intake_mode = 'legacy',
    intake_mode_changed_at = now(),
    intake_mode_changed_by = 'captain-approved-runtime-rollback'
WHERE id = true
  AND intake_mode = 'deterministic';
