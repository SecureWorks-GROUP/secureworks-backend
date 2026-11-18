-- Down for 20261119000000_reconcile_list_page (PLACEHOLDER version).
-- Removes the two read functions and the index. The switch row is removed only
-- while it is still off, so a switch someone turned on is never deleted.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DROP FUNCTION IF EXISTS public.reconcile_list_page(uuid,text[],integer,jsonb);
DROP FUNCTION IF EXISTS public.reconcile_list_counts(uuid);
DROP INDEX IF EXISTS public.reconcile_items_open_page_idx;
DELETE FROM public.feature_flags WHERE flag_name = 'reconcile_list_v1' AND enabled = false;
