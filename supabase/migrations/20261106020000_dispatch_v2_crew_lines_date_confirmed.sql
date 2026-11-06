-- Dispatch v2, Tweak 7 Part A (Shaun, 6 Nov 2026, "go A"): a delivery date
-- typed by hand and ticked Confirmed counts as the supplier order being
-- confirmed, the same as Accept on a reply or the Order confirmed stage. The
-- crew pickup line it writes is recorded with trigger 'date_confirmed', so
-- this widens the one CHECK on dispatch_v2_order_crew_lines.trigger to allow
-- it. Nothing else changes: no row is touched, no backfill.
--
-- Rules: supabase/functions/ops-api/dispatch_v2_order_confirmed_write.ts.
-- Contract: docs/dispatch-v2-board-contract.md section 3e.
--
-- Rollback: supabase/rollbacks/20261106020000_dispatch_v2_crew_lines_date_confirmed_down.sql.

ALTER TABLE public.dispatch_v2_order_crew_lines
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_crew_lines_trigger_valid;

ALTER TABLE public.dispatch_v2_order_crew_lines
  ADD CONSTRAINT dispatch_v2_order_crew_lines_trigger_valid CHECK (
    trigger IN ('accept', 'stage_set', 'date_confirmed', 'date_set')
  );
