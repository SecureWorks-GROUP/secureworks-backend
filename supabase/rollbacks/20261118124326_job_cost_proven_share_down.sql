SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT public.job_profit_remove_proven_share();
-- Keep historical review kinds and rows; the Reconcile history owns them.
DROP FUNCTION public.job_profit_remove_proven_share();
DROP FUNCTION public.job_profit_install_proven_share();
DROP FUNCTION public.job_profit_configure_proven_share(boolean);
DROP FUNCTION public.job_profit_reconcile_item_changed();
DROP FUNCTION public.job_profit_store_proven_share(uuid[]);
DROP FUNCTION public.job_cost_proven_share(uuid[]);
DROP FUNCTION public.job_cost_part_proven(uuid,integer,uuid);
ALTER TABLE public.job_profit_stored DROP COLUMN proven_share_reason,
  DROP COLUMN proven_share_pct,DROP COLUMN cost_unknown_items,DROP COLUMN cost_unknown_ex,
  DROP COLUMN cost_on_clues_ex,DROP COLUMN cost_proven_ex;
