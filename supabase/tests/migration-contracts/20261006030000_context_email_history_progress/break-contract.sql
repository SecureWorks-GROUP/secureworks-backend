-- Ship the progress columns but keep B-1's tick: a source that never moves
-- keeps the queue for 288 calls and every other mailbox waits behind it (the
-- fencing loop of 5 Oct 2026). The contract must catch it.
\ir ../../../rollbacks/20261006030000_context_email_history_progress_down.sql
ALTER TABLE public.context_email_history_plan
 ADD COLUMN posts_since_progress integer NOT NULL DEFAULT 0,
 ADD COLUMN last_run_id uuid,
 ADD COLUMN last_progress_at timestamptz,
 ADD COLUMN stalled_at timestamptz,
 ADD COLUMN stall_reason text,
 ADD COLUMN stalls integer NOT NULL DEFAULT 0;
ALTER TABLE public.context_email_history_plan DROP CONSTRAINT context_email_history_plan_state_check;
ALTER TABLE public.context_email_history_plan ADD CONSTRAINT context_email_history_plan_state_check
 CHECK (state IN ('pending','loading','stalled','succeeded','gave_up'));
