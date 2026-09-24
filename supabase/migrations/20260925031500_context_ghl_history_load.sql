-- M4 (context build plan, Wave 5; design sms.md section 12 "M4 one-off history
-- load", INTEGRATION.md X15 and X27): the database side of the one-off GHL
-- history load for the contacts of live jobs, and of the link action that
-- first puts a GHL contact on live jobs that have none.
--
-- Captain's scope ruling, 24 Sep 2026: every backfill covers CURRENTLY LIVE
-- JOBS ONLY (accepted, scheduled, in progress, plus quotes sent in the last 60
-- days), never closed jobs, and each live job contact's history is loaded from
-- its first GHL message forward (this replaces the design's 30-day window for
-- live jobs). The 100-jobs-a-day limit stays. The live statuses are the live
-- production vocabulary for those stages (read 24 Sep 2026): accepted,
-- partially_accepted, scheduled, in_progress, processing, approvals,
-- order_materials, schedule_install, awaiting_supplier, awaiting_deposit,
-- final_payment, rectification. Captain, 24 Sep: "yes link all live jobs to
-- their contacts": a live job with no GHL contact gets one written only on an
-- exact phone or email key match to exactly one GHL contact.
--
-- What it adds (all new; nothing existing is replaced):
--  1. context_ghl_history_policy(): every number and allow-list, in one place.
--  2. context_ghl_history_live_jobs(): the live jobs, bounded here in code:
--       a status on the live allow-list above; or status draft or quoted with
--       a quote document sent (job_documents type 'quote', sent_at, the D1
--       definition of a sent quote) in the last 60 days. Never archived, never
--       a holding job (metadata.do_not_schedule). Every other status
--       (complete, invoiced, cancelled, lost, get_review, archived and any
--       value not on the allow-list) is out. Jobs with and without a GHL
--       contact: the load reads only those with one, the link action only
--       those without.
--  3. context_ghl_history_contacts: one row per GHL contact whose history the
--     load has attempted (done, partial with a resume point, or failed with a
--     code). Ids, times, counts and codes only, never message text. Written
--     only through record_ghl_history_contact(). RLS on, no policies, revoked
--     from PUBLIC, anon, authenticated; service_role may read.
--  4. context_ghl_history_due(p_max_jobs): the next contacts to load, grouped
--     from the live jobs, under a strict daily bound: the jobs reserved by
--     today's real runs (Perth day, the ghl_history_load run rows written
--     through record_capture_run) plus the jobs offered never exceed 100. A
--     contact whose live jobs do not fit what is left today waits for a later
--     day; one with more live jobs than a whole day is never offered and is
--     counted. Partial loads resume first; a failed contact is offered again
--     on a later day. Read only.
--     reserve_ghl_history_run(p_max_jobs, p_actor): how a real run starts.
--     Under one transaction-scoped advisory lock it closes an abandoned run,
--     refuses while another real run is live, selects the due contacts and
--     creates the run row with those jobs already counted (jobs_covered), so
--     two simultaneous runs can never take the same remaining quota.
--  5. record_ghl_history_contact(p_row): the one writer of the ledger.
--  6. capture_ghl_history_event(p_row): the history load's only way to save a
--     row. It accepts only a backfill row from source ghl-history-load that
--     names no job (a history row never asserts a job; the ladder decides),
--     refuses while the attribution lane is off, and saves it through the one
--     writer capture_business_event (C1a). It writes no placement field: the
--     placement-owned BEFORE INSERT trigger places the row, and the load
--     leaves it as the trigger leaves it. The live ladder (P1a) does not yet
--     treat backfill rows differently, so a history row it sends to review
--     stays pending_luna; X27's "backfill never goes to the model" is a
--     placement-track follow-up, not something this slice writes around.
--  7. The link action (runs before the load, so linked jobs fold into it):
--     context_ghl_history_link_candidates(p_after, p_limit): one keyset page
--       (by job id) of the live jobs whose ghl_contact_id is null or blank, with their B0 phone and email keys (context_phone_key,
--       context_email_key) and the contact our own records already give those
--       keys (context_contact_for_key). The edge function searches GHL with
--       the keys and decides certain (exactly one contact), ambiguous or none.
--     context_ghl_contact_links: one audit row per change (job, old value,
--       new contact, key kind, run, actor), reversible. RLS on, revoked.
--     link_job_ghl_contact(p_row): writes jobs.ghl_contact_id only while it is
--       still null or blank and the job is still live (compare and set, never
--       an overwrite) and writes the audit row in the same transaction.
--     reverse_ghl_contact_link(p_link_id, p_actor): puts the old value back,
--       only while the job still carries the linked contact.
--
-- Nothing here wakes an extraction read: history rows carry capture_mode
-- backfill (X15), which the cadence rule (K1) never counts as waking.
--
-- No flag or switch changes, no cron job, no business_events or jobs row
-- written by the migration itself. No
-- grant, policy or view for anon or authenticated. Every new function: fixed
-- search_path, SECURITY DEFINER where it reads or writes protected tables,
-- EXECUTE revoked from PUBLIC, anon, authenticated, granted to service_role.
--
-- Built on the LIVE production definitions it calls (read from production,
-- see the guard): capture_business_event(jsonb) is the C1a body
-- (md5 4819869e6dcc40d5cd19a7eba295392c); record_capture_run(jsonb) the F1b
-- body (md5 db03c98a6da49f128595342f5a93f84c). The load relies on the
-- writer's contract (its outcome names the ladder's attribution_status) and
-- the reservation on the run writer's, so the guard pins both.
--
-- Rollback: supabase/rollbacks/20260925031500_context_ghl_history_load_down.sql
-- drops the new objects. It refuses while the ledger or the link audit holds a
-- row, so loaded history never loses its record of which run loaded it, and a
-- link is never left without the record that reverses it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Called, never replaced: the live bodies this slice was built against.
  ('public.capture_business_event(jsonb)',ARRAY['4819869e6dcc40d5cd19a7eba295392c'],false),
  ('public.record_capture_run(jsonb)',ARRAY['db03c98a6da49f128595342f5a93f84c'],false),
  ('public.automation_lane_enabled(text)',NULL::text[],false),
  -- New: absent, or already this migration's body (a re-apply).
  ('public.context_ghl_history_policy()',ARRAY['ae330644d6d87cf4be51f7adb2191891'],true),
  ('public.context_ghl_history_live_jobs()',ARRAY['49eb23015b724a29058c11b2743954bf'],true),
  ('public.reserve_ghl_history_run(integer,text)',ARRAY['dc0848e3b103f0e5c8a9a3947bebc154'],true),
  ('public.context_ghl_history_due(integer)',ARRAY['a52b2ffa5db7ca748e1d1069ec97da00'],true),
  ('public.record_ghl_history_contact(jsonb)',ARRAY['4880dd100bc6161d61b91695231acb52'],true),
  ('public.capture_ghl_history_event(jsonb)',ARRAY['3e51278532e7c92a64b0cc9935ce2652'],true),
  ('public.context_ghl_history_link_candidates(uuid,integer)',ARRAY['8b250cbde48e1d0067c541fa10d3c506'],true),
  ('public.link_job_ghl_contact(jsonb)',ARRAY['713bf6bd8950d2ed1f363ff68f17e624'],true),
  ('public.reverse_ghl_contact_link(uuid,text)',ARRAY['bc62193d8d08ecdfe0a4c3ad2b0bacfe'],true),
  -- Called B0 helpers (the placement track's key rule).
  ('public.context_phone_key(text)',ARRAY['ad18564daffd9bb955949dbd4a5282c1'],false),
  ('public.context_email_key(text)',ARRAY['bccbc990823518e71004ed4bd1d4b54b'],false),
  ('public.context_contact_for_key(text,text)',ARRAY['78eedc7273576c02e8aa119924c6d5fd'],false)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR (x.accepted IS NOT NULL AND NOT live=ANY(x.accepted)) THEN
   problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>'));
  END IF;
 END LOOP;
 -- Any other overload of a name this migration owns is a live change nobody read.
 FOR x IN SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('context_ghl_history_policy','context_ghl_history_live_jobs','context_ghl_history_due',
   'reserve_ghl_history_run',
   'record_ghl_history_contact','capture_ghl_history_event','context_ghl_history_link_candidates','link_job_ghl_contact',
   'reverse_ghl_contact_link')
  AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' NOT IN (
   'context_ghl_history_policy()','context_ghl_history_live_jobs()',
   'context_ghl_history_due(p_max_jobs integer)','reserve_ghl_history_run(p_max_jobs integer, p_actor text)',
   'record_ghl_history_contact(p_row jsonb)','capture_ghl_history_event(p_row jsonb)','context_ghl_history_link_candidates(p_after uuid, p_limit integer)',
   'link_job_ghl_contact(p_row jsonb)','reverse_ghl_contact_link(p_link_id uuid, p_actor text)') LOOP
  problems:=problems||format('unexpected overload %s',x.sig);
 END LOOP;
 -- A ledger table that is not this migration's is a live object nobody read.
 IF to_regclass('public.context_ghl_history_contacts') IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_ghl_history_contacts') AND a.attname='skipped_calls' AND NOT a.attisdropped)
 THEN problems:=problems||'context_ghl_history_contacts exists with another shape'::text; END IF;
 IF to_regclass('public.context_ghl_contact_links') IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_ghl_contact_links') AND a.attname='key_kind' AND NOT a.attisdropped)
 THEN problems:=problems||'context_ghl_contact_links exists with another shape'::text; END IF;
 -- The link action UPDATEs jobs.ghl_contact_id. Every trigger on jobs must be
 -- one read from production on 24 Sep 2026; a new one is a side effect nobody
 -- has checked. (trg_jobs_updated stamps updated_at; the expected-costs guard
 -- refuses only a change to its own two columns; the SES money seal fires only
 -- on UPDATE OF its own columns; the other two fire on INSERT.)
 FOR x IN SELECT t.tgname::text AS name FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.jobs') AND NOT t.tgisinternal
  AND t.tgname NOT IN ('context_job_created_reconsider','trg_auto_job_number','trg_jobs_expected_costs_write_once',
   'trg_jobs_ses_money_seal_v1','trg_jobs_updated') LOOP
  problems:=problems||format('unexpected trigger on jobs: %s',x.name);
 END LOOP;
 -- Columns read or written.
 FOR x IN SELECT * FROM (VALUES
  ('jobs','id','uuid'),('jobs','job_number','text'),('jobs','ghl_contact_id','text'),('jobs','archived','boolean'),
  ('jobs','metadata','jsonb'),('jobs','created_at','timestamp with time zone'),('jobs','updated_at','timestamp with time zone'),
  ('job_documents','job_id','uuid'),('job_documents','type','text'),('job_documents','sent_at','timestamp with time zone'),
  -- Read by the edge function's duplicate check (provider_message_id, event_at).
  ('business_events','provider_message_id','text'),('business_events','event_at','timestamp with time zone'),
  ('context_capture_runs','source','text'),('context_capture_runs','started_at','timestamp with time zone'),
  ('context_capture_runs','counts','jsonb'),('jobs','status',NULL),('jobs','client_phone','text'),('jobs','client_email','text')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  -- A NULL type means the column only has to exist (the writer sets it to a
  -- literal its own type accepts).
  IF live IS NULL OR (x.typ IS NOT NULL AND live<>x.typ) THEN
   problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),coalesce(x.typ,'present'));
  END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'ghl_history_load_preimage_mismatch: %; read the live definitions before building on them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Every number and allow-list, in one place. Changed only by migration.
CREATE OR REPLACE FUNCTION public.context_ghl_history_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  -- Captain ruling 24 Sep 2026: live jobs only, never closed jobs.
  -- The live production vocabulary for accepted, scheduled and in-progress
  -- work (read 24 Sep 2026). Tier orders the work: 1 on site, 2 booked,
  -- 3 accepted and being prepared, 4 quotes.
  'live_statuses',jsonb_build_array('accepted','partially_accepted','scheduled','in_progress','processing','approvals',
   'order_materials','schedule_install','awaiting_supplier','awaiting_deposit','final_payment','rectification'),
  'tier_1',jsonb_build_array('in_progress','rectification'),
  'tier_2',jsonb_build_array('scheduled','schedule_install'),
  'quote_statuses',jsonb_build_array('draft','quoted'),
  'quote_sent_days',60,
  -- sms.md section 12 M4: at most 100 jobs a day.
  'daily_job_limit',100,
  'day_zone','Australia/Perth',
  -- A real run whose row has not moved for this long is abandoned.
  'running_stale_minutes',10,
  -- Link candidates per page (keyset by job id).
  'link_page_limit',500,
  'run_source','ghl_history_load',
  'dry_run_source','ghl_history_load_dry',
  'event_source','ghl-history-load',
  'link_run_source','ghl_history_link',
  'link_dry_run_source','ghl_history_link_dry')
$$;
COMMENT ON FUNCTION public.context_ghl_history_policy() IS
 'M4 GHL history load: live-job allow-lists (captain ruling 24 Sep 2026), the 60-day quote window, the strict 100-jobs-a-day limit, the abandoned-run window, the link page size and the run and event sources.';

-- 2. The live jobs. A job is live when its status is on the live allow-list,
-- or it is a draft or quoted job with a quote document sent in the last 60
-- days. Holding jobs and archived jobs are out. ghl_contact_id is null for a
-- job with none (the link action's list); the load reads only the others.
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

-- 3. The ledger: one row per GHL contact the load has attempted.
CREATE TABLE IF NOT EXISTS public.context_ghl_history_contacts (
 contact_id text PRIMARY KEY CHECK (contact_id ~ '^[A-Za-z0-9_-]{6,64}$'),
 status text NOT NULL CHECK (status IN ('done','partial','failed')),
 last_run_id uuid NOT NULL REFERENCES public.context_capture_runs(id),
 first_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 attempts integer NOT NULL DEFAULT 1 CHECK (attempts>=1),
 job_ids uuid[] NOT NULL DEFAULT '{}',
 jobs integer NOT NULL DEFAULT 0 CHECK (jobs>=0),
 earliest_message_at timestamptz,
 latest_message_at timestamptz,
 skipped_calls integer NOT NULL DEFAULT 0 CHECK (skipped_calls>=0),
 resume jsonb,
 counts jsonb NOT NULL DEFAULT '{}'::jsonb,
 error_code text CHECK (error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,119}$'),
 actor text NOT NULL CHECK (actor ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
 CONSTRAINT context_ghl_history_contacts_done CHECK (status<>'done' OR (completed_at IS NOT NULL AND resume IS NULL)),
 CONSTRAINT context_ghl_history_contacts_failed_code CHECK (status<>'failed' OR error_code IS NOT NULL),
 CONSTRAINT context_ghl_history_contacts_resume CHECK (resume IS NULL OR (jsonb_typeof(resume)='object' AND octet_length(resume::text)<=4096)),
 CONSTRAINT context_ghl_history_contacts_counts CHECK (jsonb_typeof(counts)='object'),
 CONSTRAINT context_ghl_history_contacts_times CHECK (earliest_message_at IS NULL OR latest_message_at IS NULL OR earliest_message_at<=latest_message_at)
);
CREATE INDEX IF NOT EXISTS context_ghl_history_contacts_status ON public.context_ghl_history_contacts(status,last_attempt_at);
ALTER TABLE public.context_ghl_history_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ghl_history_contacts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.context_ghl_history_contacts TO service_role;
COMMENT ON TABLE public.context_ghl_history_contacts IS
 'M4 GHL history load ledger: one row per GHL contact whose history was loaded (done), is part loaded (partial, with a resume point) or failed (with a code). Ids, times, counts and codes only, never message text. Written only through record_ghl_history_contact(); service_role has SELECT only.';

-- 4. The next contacts to load under the day's strict bound, and the atomic
-- reservation a real run starts with.
CREATE OR REPLACE FUNCTION public.context_ghl_history_due(p_max_jobs integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 pol jsonb:=public.context_ghl_history_policy(); lim integer; day_start timestamptz; counted integer; remaining integer;
 picked jsonb:='[]'::jsonb; used integer:=0; waiting_contacts integer:=0; waiting_jobs integer:=0; over_contacts integer:=0; over_jobs integer:=0;
 r record; bad_ids integer;
BEGIN
 IF p_max_jobs IS NULL OR p_max_jobs<1 THEN RAISE EXCEPTION 'history_due_max_jobs_invalid'; END IF;
 lim:=(pol->>'daily_job_limit')::integer;
 day_start:=(date_trunc('day',now() AT TIME ZONE (pol->>'day_zone'))) AT TIME ZONE (pol->>'day_zone');
 SELECT coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'jobs_covered')='number' THEN (c.counts->>'jobs_covered')::integer ELSE 0 END),0)::integer
 INTO counted FROM public.context_capture_runs c WHERE c.source=pol->>'run_source' AND c.started_at>=day_start;
 remaining:=greatest(0,lim-counted);
 -- A contact id that is not a GHL id cannot be read from GHL: counted, never offered.
 SELECT count(*)::integer INTO bad_ids FROM public.context_ghl_history_live_jobs() l
 WHERE l.ghl_contact_id IS NOT NULL AND l.ghl_contact_id !~ '^[A-Za-z0-9_-]{6,64}$';
 FOR r IN
  WITH live AS (SELECT * FROM public.context_ghl_history_live_jobs() l WHERE l.ghl_contact_id ~ '^[A-Za-z0-9_-]{6,64}$'),
  by_contact AS (
   SELECT l.ghl_contact_id AS contact_id, array_agg(l.job_id ORDER BY l.job_id) AS job_ids, count(*)::integer AS jobs,
    min(l.tier) AS tier, max(l.activity_at) AS activity_at
   FROM live l GROUP BY l.ghl_contact_id
  )
  SELECT b.*, h.status AS prior_status, h.resume, coalesce(h.attempts,0) AS attempts
  FROM by_contact b LEFT JOIN public.context_ghl_history_contacts h ON h.contact_id=b.contact_id
  -- Never loaded, part loaded, or failed on an earlier day (retried, never given up on).
  WHERE h.contact_id IS NULL OR h.status='partial' OR (h.status='failed' AND h.last_attempt_at<day_start)
  ORDER BY (h.status='partial') DESC NULLS LAST, b.tier, b.activity_at DESC NULLS LAST, b.contact_id
 LOOP
  IF r.jobs>lim THEN
   -- More live jobs than a whole day allows: never inside the bound, so never offered.
   over_contacts:=over_contacts+1; over_jobs:=over_jobs+r.jobs;
  ELSIF used<p_max_jobs AND used+r.jobs<=remaining THEN
   picked:=picked||jsonb_build_array(jsonb_build_object('contact_id',r.contact_id,'job_ids',to_jsonb(r.job_ids),'jobs',r.jobs,
    'prior_status',r.prior_status,'resume',r.resume,'attempts',r.attempts));
   used:=used+r.jobs;
  ELSE
   waiting_contacts:=waiting_contacts+1; waiting_jobs:=waiting_jobs+r.jobs;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('daily_job_limit',lim,'jobs_counted_today',counted,'daily_remaining',remaining,'max_jobs',p_max_jobs,
  'day_start',day_start,'contacts',picked,'jobs_offered',used,'contacts_waiting',waiting_contacts,'jobs_waiting',waiting_jobs,
  'contacts_over_daily_limit',over_contacts,'jobs_over_daily_limit',over_jobs,
  'daily_limit_reached',remaining=0,'jobs_invalid_contact_id',bad_ids);
END $$;
COMMENT ON FUNCTION public.context_ghl_history_due(integer) IS
 'M4: the next GHL contacts to load, from the live jobs grouped by contact: partial loads first, then in progress, booked, accepted, quotes, newest activity first. The jobs offered never exceed 100 minus the jobs counted by today''s ghl_history_load runs (Perth day); contacts are added while fewer than p_max_jobs are offered and the whole contact fits. A contact with more live jobs than a whole day is never offered (counted). Done contacts are not offered; failed ones are offered again on a later day. Read only.';

CREATE OR REPLACE FUNCTION public.reserve_ghl_history_run(p_max_jobs integer, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); v_actor text:=coalesce(nullif(p_actor,''),'actor_missing');
 live_run record; due jsonb; created jsonb;
BEGIN
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'history_reserve_actor_invalid'; END IF;
 -- One reservation at a time: a second caller waits here, then sees the first
 -- run's counted jobs.
 PERFORM pg_advisory_xact_lock(hashtextextended('context_ghl_history_load',0));
 SELECT c.id, c.updated_at INTO live_run FROM public.context_capture_runs c
 WHERE c.source=pol->>'run_source' AND c.status='running' ORDER BY c.started_at DESC LIMIT 1;
 IF FOUND THEN
  IF live_run.updated_at>clock_timestamp()-make_interval(mins=>(pol->>'running_stale_minutes')::integer) THEN
   RETURN jsonb_build_object('outcome','run_in_progress','run_id',live_run.id);
  END IF;
  -- The worker died mid-run. Its counted jobs stay counted.
  PERFORM public.record_capture_run(jsonb_build_object('run_id',live_run.id,'source',pol->>'run_source','status','failed','error_code','run_abandoned'));
 END IF;
 due:=public.context_ghl_history_due(p_max_jobs);
 created:=public.record_capture_run(jsonb_build_object('source',pol->>'run_source','status','running','window_to',clock_timestamp(),
  'cursor',jsonb_build_object('v',1,'actor',v_actor),
  'counts',jsonb_build_object('dry_run',0,'jobs_covered',(due->>'jobs_offered')::integer,'daily_job_limit',(due->>'daily_job_limit')::integer,
   'jobs_counted_before',(due->>'jobs_counted_today')::integer,'daily_remaining',(due->>'daily_remaining')::integer,
   'contacts_due',jsonb_array_length(due->'contacts'))));
 RETURN jsonb_build_object('outcome','reserved','run_id',created->>'run_id','due',due);
END $$;
COMMENT ON FUNCTION public.reserve_ghl_history_run(integer,text) IS
 'M4: starts a real history-load run atomically. Under one transaction-scoped advisory lock: refuses while another real run is live (run_in_progress), closes an abandoned one (run_abandoned), selects the due contacts and creates the run row with their jobs already counted in jobs_covered, so simultaneous callers never share the remaining daily quota. Returns {outcome: reserved, run_id, due} or {outcome: run_in_progress, run_id}.';

-- 5. The one writer of the ledger. p_row keys: contact_id, run_id, status
-- (done, partial, failed), job_ids, jobs, earliest_message_at,
-- latest_message_at, skipped_calls, resume, counts (object of non-negative
-- integers, at most 40), error_code, actor. The run must be a ghl_history_load
-- run (a dry run never writes the ledger). An existing row is updated and its
-- attempts counted; first_attempt_at is kept.
CREATE OR REPLACE FUNCTION public.record_ghl_history_contact(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 pol jsonb:=public.context_ghl_history_policy(); v_contact text; v_status text; v_run uuid; v_jobs uuid[]; v_counts jsonb; k text;
 v_resume jsonb; v_code text; v_actor text; v_early timestamptz; v_late timestamptz; v_calls integer; v_njobs integer; out_row public.context_ghl_history_contacts;
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_row) x WHERE x NOT IN ('contact_id','run_id','status','job_ids','jobs','earliest_message_at',
   'latest_message_at','skipped_calls','resume','counts','error_code','actor'))
 THEN RAISE EXCEPTION 'history_contact_invalid'; END IF;
 v_contact:=p_row->>'contact_id';
 IF v_contact IS NULL OR v_contact !~ '^[A-Za-z0-9_-]{6,64}$' THEN RAISE EXCEPTION 'history_contact_id_invalid'; END IF;
 v_status:=p_row->>'status';
 IF v_status IS NULL OR v_status NOT IN ('done','partial','failed') THEN RAISE EXCEPTION 'history_contact_status_invalid'; END IF;
 v_actor:=coalesce(nullif(p_row->>'actor',''),'actor_missing');
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'history_contact_actor_invalid'; END IF;
 v_counts:=coalesce(p_row->'counts','{}'::jsonb);
 IF jsonb_typeof(v_counts)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(v_counts))>40 THEN RAISE EXCEPTION 'history_contact_counts_invalid'; END IF;
 FOR k IN SELECT jsonb_object_keys(v_counts) LOOP
  IF k !~ '^[a-z][a-z0-9_]{0,62}$' OR jsonb_typeof(v_counts->k)<>'number' OR (v_counts->>k)::numeric<0
   OR (v_counts->>k)::numeric<>trunc((v_counts->>k)::numeric) OR (v_counts->>k)::numeric>2147483647
  THEN RAISE EXCEPTION 'history_contact_counts_invalid'; END IF;
 END LOOP;
 v_resume:=CASE WHEN jsonb_typeof(p_row->'resume')='object' THEN p_row->'resume' END;
 IF p_row ? 'resume' AND jsonb_typeof(p_row->'resume') NOT IN ('object','null') THEN RAISE EXCEPTION 'history_contact_resume_invalid'; END IF;
 IF v_status='done' THEN v_resume:=NULL; END IF;
 v_code:=nullif(p_row->>'error_code','');
 IF v_code IS NOT NULL AND v_code !~ '^[a-z0-9][a-z0-9_.:-]{0,119}$' THEN RAISE EXCEPTION 'history_contact_error_code_invalid'; END IF;
 IF v_status='failed' AND v_code IS NULL THEN RAISE EXCEPTION 'history_contact_error_code_required'; END IF;
 BEGIN
  v_run:=(p_row->>'run_id')::uuid;
  v_early:=(p_row->>'earliest_message_at')::timestamptz; v_late:=(p_row->>'latest_message_at')::timestamptz;
  v_calls:=coalesce((p_row->>'skipped_calls')::integer,0); v_njobs:=coalesce((p_row->>'jobs')::integer,0);
  SELECT coalesce(array_agg(x::uuid ORDER BY x::uuid),'{}') INTO v_jobs FROM jsonb_array_elements_text(coalesce(p_row->'job_ids','[]'::jsonb)) x;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range
  OR invalid_parameter_value OR cannot_coerce OR data_exception THEN RAISE EXCEPTION 'history_contact_invalid';
 END;
 IF v_run IS NULL OR NOT EXISTS(SELECT 1 FROM public.context_capture_runs c WHERE c.id=v_run AND c.source=pol->>'run_source')
 THEN RAISE EXCEPTION 'history_contact_run_invalid'; END IF;
 IF v_calls<0 OR v_njobs<0 THEN RAISE EXCEPTION 'history_contact_invalid'; END IF;
 BEGIN
  INSERT INTO public.context_ghl_history_contacts AS h(contact_id,status,last_run_id,first_attempt_at,last_attempt_at,completed_at,attempts,
   job_ids,jobs,earliest_message_at,latest_message_at,skipped_calls,resume,counts,error_code,actor)
  VALUES(v_contact,v_status,v_run,clock_timestamp(),clock_timestamp(),CASE WHEN v_status='done' THEN clock_timestamp() END,1,
   v_jobs,v_njobs,v_early,v_late,v_calls,v_resume,v_counts,v_code,v_actor)
  ON CONFLICT (contact_id) DO UPDATE SET status=EXCLUDED.status,last_run_id=EXCLUDED.last_run_id,last_attempt_at=EXCLUDED.last_attempt_at,
   completed_at=EXCLUDED.completed_at,attempts=h.attempts+1,job_ids=EXCLUDED.job_ids,jobs=EXCLUDED.jobs,
   earliest_message_at=CASE WHEN h.earliest_message_at IS NULL THEN EXCLUDED.earliest_message_at
    WHEN EXCLUDED.earliest_message_at IS NULL THEN h.earliest_message_at ELSE least(h.earliest_message_at,EXCLUDED.earliest_message_at) END,
   latest_message_at=CASE WHEN h.latest_message_at IS NULL THEN EXCLUDED.latest_message_at
    WHEN EXCLUDED.latest_message_at IS NULL THEN h.latest_message_at ELSE greatest(h.latest_message_at,EXCLUDED.latest_message_at) END,
   skipped_calls=EXCLUDED.skipped_calls,resume=EXCLUDED.resume,counts=EXCLUDED.counts,error_code=EXCLUDED.error_code,actor=EXCLUDED.actor
  RETURNING * INTO out_row;
 EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'history_contact_invalid';
 END;
 RETURN jsonb_build_object('outcome',CASE WHEN out_row.attempts=1 THEN 'created' ELSE 'updated' END,'contact_id',out_row.contact_id,
  'status',out_row.status,'attempts',out_row.attempts);
END $$;
COMMENT ON FUNCTION public.record_ghl_history_contact(jsonb) IS
 'The one writer of context_ghl_history_contacts (M4). Upserts one contact''s load record against a ghl_history_load run; attempts counted, first attempt kept, a done row clears its resume point. Refusal codes: history_contact_invalid, history_contact_id_invalid, history_contact_status_invalid, history_contact_actor_invalid, history_contact_counts_invalid, history_contact_resume_invalid, history_contact_error_code_invalid, history_contact_error_code_required, history_contact_run_invalid.';

-- 6. The history load's only way to save a row. It writes no placement field:
-- the placement-owned trigger places the row as it places every row.
CREATE OR REPLACE FUNCTION public.capture_ghl_history_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy();
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row)<>'object' THEN RETURN jsonb_build_object('outcome','error','code','capture_row_invalid'); END IF;
 IF jsonb_typeof(p_row->'metadata')<>'object' OR p_row->'metadata'->>'capture_mode' IS DISTINCT FROM 'backfill' THEN
  RETURN jsonb_build_object('outcome','error','code','history_row_not_backfill');
 END IF;
 IF p_row->>'source' IS DISTINCT FROM pol->>'event_source' THEN RETURN jsonb_build_object('outcome','error','code','history_row_source_invalid'); END IF;
 -- A history row never asserts a job: the ladder decides, and the writer's
 -- upgrade rule (a verified direct job id) can never fire from this door.
 IF nullif(p_row->>'job_id','') IS NOT NULL OR coalesce(nullif(p_row->>'match_method',''),'none')<>'none' THEN
  RETURN jsonb_build_object('outcome','error','code','history_row_job_refused');
 END IF;
 -- With the attribution lane off the ladder places nothing; history is loaded
 -- only while it is on, so every row is placed at its own time on insert.
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','error','code','attribution_disabled'); END IF;
 RETURN public.capture_business_event(p_row);
END $$;
COMMENT ON FUNCTION public.capture_ghl_history_event(jsonb) IS
 'M4: the GHL history load''s only writer. Accepts only a capture_mode backfill row from source ghl-history-load that names no job, only while the attribution lane is on, and saves it through capture_business_event; the placement-owned trigger places it. Writes no placement field. Returns the writer''s outcome.';

-- 7. The link action. A live job with no GHL contact gets one only on an exact
-- key match to exactly one contact (decided by the edge function against GHL
-- and against the contact our own records give the same keys). Captain,
-- 24 Sep 2026: "yes link all live jobs to their contacts".
-- One keyset page by job id: p_after is the last job id of the previous page
-- (null for the first page), so repeated runs reach every job without a contact.
CREATE OR REPLACE FUNCTION public.context_ghl_history_link_candidates(p_after uuid, p_limit integer)
RETURNS TABLE(job_id uuid, job_number text, tier integer, phone_key text, email_key text, own_contact_id text, own_contacts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT l.job_id, l.job_number, l.tier, k.phone_key, k.email_key, o.contact_id, coalesce(o.contacts,0)
 FROM public.context_ghl_history_live_jobs() l
 JOIN public.jobs j ON j.id=l.job_id
 CROSS JOIN LATERAL (SELECT public.context_phone_key(j.client_phone) AS phone_key, public.context_email_key(j.client_email) AS email_key) k
 LEFT JOIN LATERAL (SELECT * FROM public.context_contact_for_key(k.email_key,k.phone_key)) o ON k.phone_key IS NOT NULL OR k.email_key IS NOT NULL
 WHERE l.ghl_contact_id IS NULL AND (p_after IS NULL OR l.job_id>p_after)
 ORDER BY l.job_id
 LIMIT greatest(1,least(coalesce(p_limit,500),(public.context_ghl_history_policy()->>'link_page_limit')::integer))
$$;
COMMENT ON FUNCTION public.context_ghl_history_link_candidates(uuid,integer) IS
 'M4 link action: one keyset page (job id after p_after, at most 500) of live jobs with no GHL contact, with their B0 phone and email keys and the one contact our own records give those keys (context_contact_for_key; own_contacts counts several). Read only; the keys go only to the service-role edge function.';

CREATE TABLE IF NOT EXISTS public.context_ghl_contact_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL,
 job_number text,
 old_value text,
 new_contact_id text NOT NULL CHECK (new_contact_id ~ '^[A-Za-z0-9_-]{6,64}$'),
 key_kind text NOT NULL CHECK (key_kind IN ('phone','email','phone_and_email')),
 run_id uuid NOT NULL REFERENCES public.context_capture_runs(id),
 actor text NOT NULL CHECK (actor ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reversed_at timestamptz,
 reversed_by text CHECK (reversed_by IS NULL OR reversed_by ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
 CONSTRAINT context_ghl_contact_links_old_blank CHECK (old_value IS NULL OR btrim(old_value)=''),
 CONSTRAINT context_ghl_contact_links_reversed CHECK ((reversed_at IS NULL)=(reversed_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS context_ghl_contact_links_one_open ON public.context_ghl_contact_links(job_id) WHERE reversed_at IS NULL;
ALTER TABLE public.context_ghl_contact_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ghl_contact_links FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.context_ghl_contact_links TO service_role;
COMMENT ON TABLE public.context_ghl_contact_links IS
 'M4 link action audit: one row per jobs.ghl_contact_id written (job, the old null or blank value, the new GHL contact, the key kind that matched, run, actor), and its reversal. Ids and codes only. Written only through link_job_ghl_contact() and reverse_ghl_contact_link(); service_role has SELECT only.';

-- p_row keys: job_id, contact_id, key_kind (phone, email, phone_and_email),
-- run_id (a ghl_history_link run; a dry run never writes), actor.
CREATE OR REPLACE FUNCTION public.link_job_ghl_contact(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); v_job uuid; v_contact text; v_kind text; v_run uuid; v_actor text;
 j record; link_id uuid;
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_row) x WHERE x NOT IN ('job_id','contact_id','key_kind','run_id','actor','phone_key','email_key'))
 THEN RAISE EXCEPTION 'link_invalid'; END IF;
 BEGIN
  v_job:=(p_row->>'job_id')::uuid; v_run:=(p_row->>'run_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'link_invalid';
 END;
 v_contact:=p_row->>'contact_id'; v_kind:=p_row->>'key_kind';
 v_actor:=coalesce(nullif(p_row->>'actor',''),'actor_missing');
 IF v_job IS NULL OR v_contact IS NULL OR v_contact !~ '^[A-Za-z0-9_-]{6,64}$' THEN RAISE EXCEPTION 'link_invalid'; END IF;
 IF v_kind IS NULL OR v_kind NOT IN ('phone','email','phone_and_email') THEN RAISE EXCEPTION 'link_key_kind_invalid'; END IF;
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'link_actor_invalid'; END IF;
 IF v_run IS NULL OR NOT EXISTS(SELECT 1 FROM public.context_capture_runs c WHERE c.id=v_run AND c.source=pol->>'link_run_source')
 THEN RAISE EXCEPTION 'link_run_invalid'; END IF;
 SELECT jb.id, jb.job_number, jb.ghl_contact_id, jb.status::text AS status, jb.metadata, jb.client_phone, jb.client_email INTO j FROM public.jobs jb WHERE jb.id=v_job FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','job_missing','job_id',v_job); END IF;
 -- Never an overwrite: a job that has any contact keeps it.
 IF nullif(btrim(j.ghl_contact_id),'') IS NOT NULL THEN
  RETURN jsonb_build_object('outcome','already_linked','job_id',v_job,'same_contact',btrim(j.ghl_contact_id)=v_contact);
 END IF;
 -- Only a job that is live now.
 IF NOT EXISTS(SELECT 1 FROM public.context_ghl_history_live_jobs() l WHERE l.job_id=v_job) THEN
  RETURN jsonb_build_object('outcome','not_live','job_id',v_job);
 END IF;
 IF public.context_phone_key(j.client_phone) IS DISTINCT FROM (p_row->>'phone_key')
  OR public.context_email_key(j.client_email) IS DISTINCT FROM (p_row->>'email_key') THEN
  RETURN jsonb_build_object('outcome','key_changed','job_id',v_job);
 END IF;
 -- A booking-intake draft is unique per contact
 -- (jobs_booking_intake_draft_ghl_contact_id): never a second one.
 IF j.status='draft' AND coalesce(j.metadata->>'booking_intake_draft','')='true' AND EXISTS(
   SELECT 1 FROM public.jobs o WHERE o.id<>v_job AND o.ghl_contact_id=v_contact AND o.status='draft'
    AND coalesce(o.metadata->>'booking_intake_draft','')='true')
 THEN RETURN jsonb_build_object('outcome','booking_draft_conflict','job_id',v_job); END IF;
 BEGIN
  -- Only ghl_contact_id changes.
  UPDATE public.jobs SET ghl_contact_id=v_contact WHERE id=v_job AND nullif(btrim(ghl_contact_id),'') IS NULL;
  INSERT INTO public.context_ghl_contact_links(job_id,job_number,old_value,new_contact_id,key_kind,run_id,actor)
  VALUES(v_job,j.job_number,j.ghl_contact_id,v_contact,v_kind,v_run,v_actor) RETURNING id INTO link_id;
 EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('outcome','unique_conflict','job_id',v_job);
 END;
 RETURN jsonb_build_object('outcome','linked','job_id',v_job,'link_id',link_id);
END $$;
COMMENT ON FUNCTION public.link_job_ghl_contact(jsonb) IS
 'M4 link action writer: sets jobs.ghl_contact_id on a live job only while it is null or blank (never an overwrite), with one context_ghl_contact_links audit row in the same transaction. Outcomes: linked, already_linked, not_live, job_missing, booking_draft_conflict, unique_conflict (nothing written for any but linked). Refusal codes: link_invalid, link_key_kind_invalid, link_actor_invalid, link_run_invalid.';

-- Reverse one link: the old value goes back only while the job still carries
-- the contact the link wrote. Evidence already placed by the ladder is not
-- moved (a later re-run decides it).
CREATE OR REPLACE FUNCTION public.reverse_ghl_contact_link(p_link_id uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l public.context_ghl_contact_links; cur text; v_actor text:=coalesce(nullif(p_actor,''),'actor_missing');
BEGIN
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'link_actor_invalid'; END IF;
 SELECT * INTO l FROM public.context_ghl_contact_links WHERE id=p_link_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','link_missing'); END IF;
 IF l.reversed_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','already_reversed','link_id',l.id); END IF;
 SELECT ghl_contact_id INTO cur FROM public.jobs WHERE id=l.job_id FOR UPDATE;
 IF cur IS DISTINCT FROM l.new_contact_id THEN RETURN jsonb_build_object('outcome','link_superseded','link_id',l.id); END IF;
 UPDATE public.jobs SET ghl_contact_id=l.old_value WHERE id=l.job_id AND ghl_contact_id=l.new_contact_id;
 UPDATE public.context_ghl_contact_links SET reversed_at=clock_timestamp(),reversed_by=v_actor WHERE id=l.id;
 RETURN jsonb_build_object('outcome','reversed','link_id',l.id,'job_id',l.job_id);
END $$;
COMMENT ON FUNCTION public.reverse_ghl_contact_link(uuid,text) IS
 'M4 link action reversal: restores the job''s old null or blank ghl_contact_id and stamps the audit row, only while the job still carries the linked contact (link_superseded otherwise). Outcomes: reversed, already_reversed, link_superseded, link_missing.';

-- 8. Grants: nothing reachable by the public key or a signed-in login.
REVOKE ALL ON FUNCTION
 public.context_ghl_history_policy(),public.context_ghl_history_live_jobs(),public.context_ghl_history_due(integer),public.reserve_ghl_history_run(integer,text),
 public.record_ghl_history_contact(jsonb),public.capture_ghl_history_event(jsonb),
 public.context_ghl_history_link_candidates(uuid,integer),public.link_job_ghl_contact(jsonb),public.reverse_ghl_contact_link(uuid,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_ghl_history_policy(),public.context_ghl_history_live_jobs(),public.context_ghl_history_due(integer),public.reserve_ghl_history_run(integer,text),
 public.record_ghl_history_contact(jsonb),public.capture_ghl_history_event(jsonb),
 public.context_ghl_history_link_candidates(uuid,integer),public.link_job_ghl_contact(jsonb),public.reverse_ghl_contact_link(uuid,text)
TO service_role;
