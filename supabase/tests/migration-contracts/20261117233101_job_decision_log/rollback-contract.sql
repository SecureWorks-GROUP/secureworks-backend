DO $check$ BEGIN
 IF to_regclass('public.job_decision_log') IS NOT NULL THEN
   RAISE EXCEPTION 'job decision log: rollback left view behind';
 END IF;
 IF to_regclass('public.context_ledger_transitions') IS NULL OR to_regclass('public.business_events') IS NULL
   OR to_regclass('public.agent_action_proposals') IS NULL OR to_regclass('public.job_truth_weekly_samples') IS NULL THEN
   RAISE EXCEPTION 'job decision log: rollback changed a source';
 END IF;
END $check$;
\echo PASS: P4-01.9 rollback removes only the view
