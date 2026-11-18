-- Undo FU26.1. If installed, its own remove restores FU26.0's book and the
-- original staff read first (and refuses if a later change replaced either).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $undo$
/* function block */ BEGIN
 IF to_regprocedure('public.remove_job_story_stored_profit()') IS NOT NULL THEN
  PERFORM public.remove_job_story_stored_profit();
 END IF;
END $undo$;
DROP FUNCTION IF EXISTS public.install_job_story_stored_profit();
DROP FUNCTION IF EXISTS public.remove_job_story_stored_profit();
DROP FUNCTION IF EXISTS public.context_job_story_book_switch(uuid,timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_book_stored(uuid,timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_money_sig_stored(uuid);
DROP FUNCTION IF EXISTS public.context_story_book_costs_stored(uuid);
DROP FUNCTION IF EXISTS public.context_job_story_text_get_stamped(uuid,jsonb,boolean);
DROP FUNCTION IF EXISTS public.context_job_story_text_get_unstamped(uuid,jsonb,boolean);
DROP FUNCTION IF EXISTS public.job_story_stored_profit_as_at(uuid,timestamptz);
DROP FUNCTION IF EXISTS public.job_story_stored_profit_on();
DROP INDEX IF EXISTS public.job_profit_change_events_job_idx;
DELETE FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1';
