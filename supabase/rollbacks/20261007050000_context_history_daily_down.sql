-- Rollback of 20261007050000_context_history_daily (history daily).
--
-- Unschedules the daily Xero top-up, puts M4's context_ghl_history_live_jobs()
-- back word for word, takes the xero-history-daily row out of the lane list
-- (the 20261005210000 body back word for word; or, while the deep email
-- history PR (20261007080000) is in the stack too, whichever of the two
-- applied first, that PR's body back word for word, its row kept), and drops
-- the seven new functions. It refuses, changing nothing, when a body it would
-- restore was replaced by a later migration (restoring it would silently drop
-- that change).
--
-- Kept on purpose: the Xero evidence rows the top-up wrote (evidence a reader
-- may already have read; scripts/context-history-xero-daily-undo.sql retracts
-- one run's rows, context_xero_evidence_undo (B-4) removes every Xero history
-- row), the xero_history_daily run rows (the record of what ran), and every
-- contact link and history row the widened CRM list let the scheduled cycle
-- write (reverse_ghl_contact_link undoes a link; history rows are evidence).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE problems text[] := '{}'; live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure('public.context_ghl_history_live_jobs()');
 IF live IS DISTINCT FROM '036457fdaa73579ab9cc9881d3b82aef' AND live IS DISTINCT FROM '49eb23015b724a29058c11b2743954bf' THEN
  problems := problems || format('public.context_ghl_history_live_jobs() md5 %s is neither this migration''s nor M4''s', coalesce(live, '<missing>'));
 END IF;
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure('public.automation_switch_cron_lanes()');
 IF live IS NULL THEN
  problems := problems || 'public.automation_switch_cron_lanes() md5 <missing>'::text;
 ELSIF live NOT IN ('81cbebf914f537b0b85870196cbd0f75', '6498276b1eb16b527fb76dd2b0fa6d83')
  AND EXISTS (SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname = 'xero-history-daily') THEN
  problems := problems || format('public.automation_switch_cron_lanes() md5 %s names xero-history-daily and is not this migration''s', live);
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_history_daily_rollback_refused: %; read the live definitions first', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The daily Xero top-up stops.
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'history daily rollback: pg_cron absent, nothing to unschedule';
  RETURN;
 END IF;
 IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-history-daily') THEN
  PERFORM cron.unschedule('xero-history-daily');
 END IF;
END $cron$;

-- 2. M4's CRM list, word for word (md5 49eb23015b724a29058c11b2743954bf).
CREATE OR REPLACE FUNCTION public.context_ghl_history_live_jobs()
RETURNS TABLE(job_id uuid, job_number text, ghl_contact_id text, status text, live_basis text, tier integer, activity_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_ghl_history_policy() AS p),
 j AS (
  SELECT jb.id, jb.job_number, nullif(btrim(jb.ghl_contact_id),'') AS contact, jb.status::text AS status, jb.created_at, jb.updated_at,
   (SELECT max(d.sent_at) FROM public.job_documents d
    WHERE d.job_id=jb.id AND d.type='quote' AND d.sent_at IS NOT NULL
     AND d.sent_at>=now()-make_interval(days=>(pol.p->>'quote_sent_days')::integer) AND d.sent_at<=now()) AS quote_sent_at,
   jb.status::text IN (SELECT jsonb_array_elements_text(pol.p->'live_statuses')) AS live_status,
   jb.status::text IN (SELECT jsonb_array_elements_text(pol.p->'quote_statuses')) AS quote_status
  FROM public.jobs jb CROSS JOIN pol
  WHERE NOT coalesce(jb.archived,false)
   AND coalesce(jb.metadata->>'do_not_schedule','') NOT IN ('true','1')
 )
 SELECT j.id, j.job_number, j.contact, j.status,
  CASE WHEN j.live_status THEN 'status' ELSE 'quote_sent' END,
  CASE WHEN NOT j.live_status THEN 4
   WHEN j.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_1')) THEN 1
   WHEN j.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_2')) THEN 2 ELSE 3 END,
  greatest(j.created_at,j.updated_at,j.quote_sent_at)
 FROM j CROSS JOIN pol
 WHERE j.live_status OR (j.quote_status AND j.quote_sent_at IS NOT NULL)
$$;
COMMENT ON FUNCTION public.context_ghl_history_live_jobs() IS
 'M4: the live jobs (captain ruling 24 Sep 2026): a status on the policy''s live allow-list (accepted, scheduled and in-progress stages), or draft or quoted with a quote document sent in the last 60 days. Never archived, never a holding job. ghl_contact_id null when the job has none. Read only.';

-- 3. The lane list without the xero row, only while it is this migration's:
-- from this migration's body (md5 81cbebf914f537b0b85870196cbd0f75), the
-- 20261005210000 body word for word (md5 99e6d70e80a79e548f2478b65fc6cd78);
-- from the list naming both jobs (md5 6498276b1eb16b527fb76dd2b0fa6d83, in
-- either merge order with the deep email history PR), that PR's body word for
-- word (md5 250d7e9ec2ebecc7e83192a39b7da488).
DO $lanes$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = 'public.automation_switch_cron_lanes()'::regprocedure;
 IF live = '81cbebf914f537b0b85870196cbd0f75' THEN
  EXECUTE $def$
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    ('outlook-mail-poll', 'capture'),
    ('monitor-inbox-sweep', 'capture'),
    ('ghl-history-schedule', 'capture'),
    ('context-document-text', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$
$def$;
 ELSIF live = '6498276b1eb16b527fb76dd2b0fa6d83' THEN
  EXECUTE $def$
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    ('outlook-mail-poll', 'capture'),
    ('monitor-inbox-sweep', 'capture'),
    ('ghl-history-schedule', 'capture'),
    ('context-document-text', 'capture'),
    ('outlook-mail-deep-history', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$
$def$;
 END IF;
END $lanes$;

-- 4. The new functions go.
DROP FUNCTION IF EXISTS public.context_history_crm_summary();
DROP FUNCTION IF EXISTS public.context_history_crm_jobs(uuid[]);
DROP FUNCTION IF EXISTS public.context_history_crm_rows(uuid[], uuid[]);
DROP FUNCTION IF EXISTS public.context_history_xero_daily_status();
DROP FUNCTION IF EXISTS public.trigger_xero_history_daily(integer);
DROP FUNCTION IF EXISTS public.context_history_monitored_jobs(timestamptz, uuid[]);
DROP FUNCTION IF EXISTS public.context_history_daily_policy();

-- 5. Grants as M4 and 20261005210000 left them.
REVOKE ALL ON FUNCTION public.context_ghl_history_live_jobs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ghl_history_live_jobs() TO service_role;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
