-- Down for 20261118195000_reconcile_list_page (PLACEHOLDER version).
-- Removes the two read functions. The switch row is removed only
-- while it is still off, so a switch someone turned on is never deleted.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DROP FUNCTION IF EXISTS public.reconcile_list_page(uuid,text[],integer,jsonb);
DROP FUNCTION IF EXISTS public.reconcile_list_counts(uuid);
DELETE FROM public.feature_flags WHERE flag_name = 'reconcile_list_v1' AND enabled = false;
