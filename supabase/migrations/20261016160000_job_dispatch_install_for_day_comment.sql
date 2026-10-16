-- Dispatch slice 7, finding F2: the column comment on install_confirmed_for_day
-- states the rule the code follows (finding F1, desk ruling 15 Oct 2026).
--
-- A mark with a day stands while the job still has an install booking on that
-- day, past or ahead; it does not lapse when the install day shown moves on to
-- the next install day. Rules: supabase/functions/ops-api/dispatch_install.ts.
-- Contract: docs/dispatch-slice-7-contract.md. One comment, nothing else.

COMMENT ON COLUMN public.job_dispatch_state.install_confirmed_for_day IS
  'The install day shown when it was pressed (Perth); null when nothing was booked. The mark stands while the job still has an install booking on this day, past or ahead; it does not lapse when the day shown moves on to the next install day.';
