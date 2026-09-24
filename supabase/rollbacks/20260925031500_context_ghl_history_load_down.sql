-- Roll back M4 (20260925031500_context_ghl_history_load).
--
-- Drops the objects M4 added: the history load's policy, live-job list, due
-- list, ledger writer and backfill writer, the link action's candidates,
-- writer and reversal, and the two tables. Nothing else is touched:
-- business_events rows the load saved stay (source ghl-history-load,
-- metadata.capture_mode backfill, metadata.history_run_id), and every
-- jobs.ghl_contact_id the link action wrote stays.
--
-- Refuses while either table holds a row: the ledger is the record of which run
-- loaded which contact, and the link audit is the only record that reverses a
-- link. To roll back after a production run, first reverse any links that must
-- go (SELECT public.reverse_ghl_contact_link(id,'<actor>') FROM
-- public.context_ghl_contact_links WHERE reversed_at IS NULL), then archive
-- both tables with the owner's word before deleting their rows. Redeploy
-- without the ghl-history-load edge function first; it is called by hand only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF to_regclass('public.context_ghl_history_contacts') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.context_ghl_history_contacts) THEN
  RAISE EXCEPTION 'm4_rollback_refused: context_ghl_history_contacts holds rows; archive the load record first';
 END IF;
 IF to_regclass('public.context_ghl_contact_links') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.context_ghl_contact_links) THEN
  RAISE EXCEPTION 'm4_rollback_refused: context_ghl_contact_links holds rows; reverse or archive the links first';
 END IF;
END $$;

DROP FUNCTION IF EXISTS public.reverse_ghl_contact_link(uuid,text);
DROP FUNCTION IF EXISTS public.link_job_ghl_contact(jsonb);
DROP FUNCTION IF EXISTS public.context_ghl_history_link_candidates();
DROP FUNCTION IF EXISTS public.capture_ghl_history_event(jsonb);
DROP FUNCTION IF EXISTS public.record_ghl_history_contact(jsonb);
DROP FUNCTION IF EXISTS public.context_ghl_history_due(integer,boolean);
DROP FUNCTION IF EXISTS public.context_ghl_history_live_jobs();
DROP FUNCTION IF EXISTS public.context_ghl_history_policy();
DROP TABLE IF EXISTS public.context_ghl_contact_links;
DROP TABLE IF EXISTS public.context_ghl_history_contacts;
