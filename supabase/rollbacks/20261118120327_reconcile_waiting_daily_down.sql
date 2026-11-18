-- P2-13.8 rollback: unschedule the daily snapshot timer if installed, then drop
-- the functions and daily snapshot table introduced by this migration.
SELECT public.reconcile_waiting_daily_remove();
DROP FUNCTION IF EXISTS public.reconcile_waiting_daily_install();
DROP FUNCTION IF EXISTS public.reconcile_waiting_daily_remove();
DROP FUNCTION IF EXISTS public.reconcile_waiting_daily_trim(date, integer);
DROP FUNCTION IF EXISTS public.reconcile_waiting_days(integer);
DROP FUNCTION IF EXISTS public.reconcile_waiting_snapshot(date);
DROP FUNCTION IF EXISTS public.reconcile_waiting_summary();
DROP TABLE IF EXISTS public.reconcile_waiting_daily;
