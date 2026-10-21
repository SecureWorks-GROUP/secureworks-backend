-- Dispatch slice 7: the install confirmation mark on a job's Dispatch record.
--
-- Contract: docs/dispatch-slice-7-contract.md. Reader: ops-api `pipeline` with
-- dispatch=1. Writer: ops-api `set_dispatch_install_confirmed`
-- (supabase/functions/ops-api/dispatch_install.ts holds the rules), and nothing
-- else.
--
-- Four nullable columns on job_dispatch_state and two checks. No table, trigger,
-- function or publication. The mark is Dispatch's own record (ruling I1): it is
-- never the calendar's lock on a booking (job_assignments.confirmation_status),
-- whose writer can text the client and writes a business event. Pressing Mark
-- confirmed writes these columns and one job_events row, and nothing else.
--
-- Rollback: supabase/rollbacks/20261014190000_job_dispatch_install_confirmed_down.sql.

ALTER TABLE public.job_dispatch_state
  ADD COLUMN IF NOT EXISTS install_confirmed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS install_confirmed_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS install_confirmed_by_email text NULL,
  ADD COLUMN IF NOT EXISTS install_confirmed_for_day date NULL;

ALTER TABLE public.job_dispatch_state
  DROP CONSTRAINT IF EXISTS job_dispatch_state_install_confirmed_named,
  DROP CONSTRAINT IF EXISTS job_dispatch_state_install_confirmed_dated;

-- Every mark names a person: a time with no email (or an email with no time)
-- is refused.
ALTER TABLE public.job_dispatch_state
  ADD CONSTRAINT job_dispatch_state_install_confirmed_named
    CHECK ((install_confirmed_at IS NULL) = (install_confirmed_by_email IS NULL));
-- A cleared mark is cleared whole: no user or day without a time.
ALTER TABLE public.job_dispatch_state
  ADD CONSTRAINT job_dispatch_state_install_confirmed_dated
    CHECK (install_confirmed_at IS NOT NULL OR (install_confirmed_by IS NULL AND install_confirmed_for_day IS NULL));

COMMENT ON TABLE public.job_dispatch_state IS
  'Dispatch tab (docs/dispatch-slice-3-contract.md, docs/dispatch-slice-7-contract.md): the stage a person set on the job''s Dispatch rail, the next-step line they typed, and the install confirmation mark. Never the job status and never a booking; written only by ops-api set_dispatch_stage / set_dispatch_next_step / set_dispatch_install_confirmed. A job with no row reads its rail place from its job status (the Repairs board stage for repair).';
COMMENT ON COLUMN public.job_dispatch_state.stage IS
  'One of the six rail stops; null when only a next-step line or an install mark was saved. not_started is never stored.';
COMMENT ON COLUMN public.job_dispatch_state.install_confirmed_at IS
  'When a person pressed Mark confirmed on the install; null when not confirmed. Dispatch''s own mark, never the calendar''s booking lock.';
COMMENT ON COLUMN public.job_dispatch_state.install_confirmed_by IS
  'The signed-in user who confirmed; null for the privileged ops key, whose operator email is in install_confirmed_by_email.';
COMMENT ON COLUMN public.job_dispatch_state.install_confirmed_by_email IS
  'The confirmer''s email, always written with install_confirmed_at.';
COMMENT ON COLUMN public.job_dispatch_state.install_confirmed_for_day IS
  'The install day shown when it was pressed (Perth); null when nothing was booked. The mark stands only while a booking stays on this day.';
