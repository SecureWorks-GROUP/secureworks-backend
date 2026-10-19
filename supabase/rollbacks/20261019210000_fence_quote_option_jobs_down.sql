-- Down for 20261019210000_fence_quote_option_jobs. Roll ghl-proxy back first
-- (it calls link_fence_quote_option). Superseded marks and groups are lost;
-- the quote_option_* job_events stay (nothing is deleted). Export
-- quote_option_settle_runs first: it is dropped. Job statuses were
-- never changed by this migration, so nothing else reverts.
-- Export the grouping first if it must be kept:
--   SELECT id, quote_option_group_id, quote_option_label, superseded_by_job_id, superseded_at
--     FROM public.jobs WHERE quote_option_group_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_jobs_quote_option_supersede ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_quote_option_supersede();
DROP FUNCTION IF EXISTS public.fence_quote_option_mark_options(uuid, text, uuid, uuid[]);
DROP FUNCTION IF EXISTS public.fence_quote_option_clear_mark(uuid, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.link_fence_quote_option(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.fence_quote_option_status_won(text);
DROP FUNCTION IF EXISTS public.fence_quote_option_lock_key(uuid);
DELETE FROM public.feature_flags WHERE flag_name IN ('quote_option_supersede_v1', 'fence_same_site_guard_v1');
DROP TABLE IF EXISTS public.quote_option_settle_runs;
DROP INDEX IF EXISTS public.idx_jobs_quote_option_group;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_superseded_shape;
ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS superseded_at,
  DROP COLUMN IF EXISTS superseded_by_job_id,
  DROP COLUMN IF EXISTS quote_option_label,
  DROP COLUMN IF EXISTS quote_option_group_id;
