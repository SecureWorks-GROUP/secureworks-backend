-- B-2 (context gap plan, section 6 (d) GHL history): the GHL history load runs
-- on its own until every live job is done, charges the day only for jobs it
-- actually loads, and hands loaded jobs to the reader. Built on M4
-- (20260925031500), which had no schedule and charged a run for every job it
-- reserved, so a run cut short by its 100 s budget spent the whole day.
--
-- Desk decision, 5 Oct 2026 (under the owner's standing yes): run at 250 jobs a
-- day for 7 days from the first scheduled run, drop back to 100 automatically
-- and stay there on the first GHL rate limit (429), and record each switch on
-- the run row. A live job with no GHL contact counts as done for this load once
-- the link step has tried it.
--
-- What it does:
--  1. context_ghl_history_schedule_policy(): the schedule's numbers in one
--     place (the 250-a-day boost, its 7 days, the schedule's actor name, the
--     link retry window, the reading priorities).
--  2. context_ghl_history_day_limit(p_scheduled): the day's job limit and why:
--     boost (250, within 7 days of the first scheduled run), boost_ended (100),
--     rate_limited (100 from the first ghl_history_load or ghl_history_link run
--     since the boost began whose error_code names ghl_rate_limited), or base
--     (100, never scheduled). p_scheduled true means the caller is the
--     scheduled cycle: with no scheduled run yet, the boost starts now.
--  3. context_ghl_history_due_at(p_max_jobs, p_limit): M4's due list under the
--     given limit, with one change: a contact attempted earlier today (the
--     ledger's last_attempt_at in today's Perth day) costs nothing against
--     today's limit, because today already paid for it (a partial load
--     resuming). Each offered contact says charged_today; the list reports
--     jobs_charged (what the offered contacts cost) and the limit.
--     REPLACES context_ghl_history_due(integer) (M4): now
--     context_ghl_history_due_at(p_max_jobs, context_ghl_history_day_limit(false)).
--     REPLACES reserve_ghl_history_run(integer,text) (M4): same lock and
--     one-live-run rule; it counts jobs_charged (not every offered job) on the
--     new run row; it creates NO run row when nothing is due (outcome
--     nothing_due), so a finished load idles without filling the run table;
--     an abandoned run keeps only the jobs of the contacts it recorded (never
--     more than it reserved); the run row's cursor carries the limit and, when
--     the limit differs from the previous real run's, limit_switch {from, to}.
--     The edge function sets jobs_covered at the end of the run to the jobs of
--     the contacts it attempted, so unreached contacts give their quota back.
--  4. The link step's record: context_ghl_history_link_attempts, one row per
--     live job the link step has judged (verdict certain, ambiguous, none or
--     failed, a short reason code, the run, the actor; never a key), written
--     only through record_ghl_link_attempt(). context_ghl_history_link_due(p_limit):
--     live jobs with no GHL contact never tried, or whose try failed before
--     today, or whose other verdict is older than 7 days, with the same keys as
--     M4's context_ghl_history_link_candidates.
--  5. Reading: context_ghl_history_contacts gains reads_requested_at.
--     context_ghl_history_request_reads(p_dry_run, p_limit) lists, for every
--     contact whose history is done and not yet handed over since it finished,
--     its live jobs on the catch-up list (context_catchup_jobs, scope backlog)
--     with the backlog writer's rule (20261004100000): never read and not
--     listed, mode full; otherwise mode unread; a pending row is never lowered;
--     a done row re-opens only with unread rows; nothing to read, no row. The
--     reader takes them under its unchanged caps (400 calls a day). History rows
--     are capture_mode backfill and never wake a read on their own, which is why
--     this hand-over exists.
--  6. context_ghl_history_progress(): the after-check in one read (live jobs,
--     done, link-tried, waiting, today's charge and limit).
--  7. The schedule: trigger_ghl_history_schedule() posts {action: scheduled}
--     to the ghl-history-load edge function with the service key while the
--     live-texts flag (ghl_message_capture_v2) and the attribution lane are
--     on; pg_cron job ghl-history-schedule every 15 minutes, wrapped in
--     WHERE public.automation_lane_enabled('capture').
--     REPLACES automation_switch_cron_lanes() (20261002150000 body) with one
--     row added: ('ghl-history-schedule','capture').
--
-- No flag or switch changes, no business_events, jobs or catch-up row written
-- by the migration itself, no grant, policy or view for anon or authenticated.
-- Every new or replaced function: fixed search_path, EXECUTE revoked from
-- PUBLIC, anon, authenticated.
--
-- Pre-image (repository bodies; production once 20261005090000 has applied):
--   context_ghl_history_due(integer)        a52b2ffa5db7ca748e1d1069ec97da00 (M4)
--   reserve_ghl_history_run(integer,text)   dc0848e3b103f0e5c8a9a3947bebc154 (M4)
--   automation_switch_cron_lanes()          5c1e0e526a74d5b4ad612792c7f076cc (20261002150000)
--   called, never replaced: record_capture_run (F1b db03c98a...),
--   context_ghl_history_policy (ae330644...), context_ghl_history_live_jobs
--   (49eb2301...), record_ghl_history_contact (4880dd10...),
--   context_catchup_pending_rows (65f9a648..., 20261004100000),
--   context_unread_rows (bb5ec9f1...), context_catchup_eligible_rows
--   (f4ee5a7b...), the B0 keys, context_ghl_item_flag.
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply).
--
-- Stop the schedule at once: SELECT cron.unschedule('ghl-history-schedule');
-- (or turn the capture lane off). Rollback:
-- supabase/rollbacks/20261005190000_context_ghl_history_schedule_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cmd text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: M4's or 20261002150000's body, or this migration's (a re-apply).
  ('public.context_ghl_history_due(integer)',ARRAY['a52b2ffa5db7ca748e1d1069ec97da00','8c5d9bbb35b8b74533b2817e2df283fe'],false),
  ('public.reserve_ghl_history_run(integer,text)',ARRAY['dc0848e3b103f0e5c8a9a3947bebc154','03b81ce45883b2ed31a8e5e5a5c88aec'],false),
  ('public.automation_switch_cron_lanes()',ARRAY['5c1e0e526a74d5b4ad612792c7f076cc','8c99245789cadf661d4b6be1207f0887'],false),
  -- Called, never replaced.
  ('public.record_capture_run(jsonb)',ARRAY['db03c98a6da49f128595342f5a93f84c'],false),
  ('public.context_ghl_history_policy()',ARRAY['ae330644d6d87cf4be51f7adb2191891'],false),
  ('public.context_ghl_history_live_jobs()',ARRAY['49eb23015b724a29058c11b2743954bf'],false),
  ('public.record_ghl_history_contact(jsonb)',ARRAY['4880dd100bc6161d61b91695231acb52'],false),
  ('public.context_catchup_pending_rows(uuid[])',ARRAY['65f9a648e73e417df6ddb2f061160519'],false),
  ('public.context_unread_rows(uuid[])',ARRAY['bb5ec9f11d525b8d420739fa3d8c4d54'],false),
  ('public.context_catchup_eligible_rows(uuid[])',ARRAY['f4ee5a7b0161d4e8aae729c35b86d7ed'],false),
  ('public.context_phone_key(text)',ARRAY['ad18564daffd9bb955949dbd4a5282c1'],false),
  ('public.context_email_key(text)',ARRAY['bccbc990823518e71004ed4bd1d4b54b'],false),
  ('public.context_contact_for_key(text,text)',ARRAY['78eedc7273576c02e8aa119924c6d5fd'],false),
  ('public.context_ghl_item_flag()',NULL::text[],false),
  ('public.automation_lane_enabled(text)',NULL::text[],false),
  -- New: absent, or already this migration's body.
  ('public.context_ghl_history_schedule_policy()',ARRAY['bd122c72ca855e5b58286476d95bdd07'],true),
  ('public.context_ghl_history_day_limit(boolean)',ARRAY['f924f4c9f9ceabc79297f496c01d93df'],true),
  ('public.context_ghl_history_due_at(integer,jsonb)',ARRAY['2c7784f547ced44353b3ae845c3bf029'],true),
  ('public.record_ghl_link_attempt(jsonb)',ARRAY['bfec08e4fc653ab9b4f150fe07317d43'],true),
  ('public.context_ghl_history_link_due(integer)',ARRAY['766586ede803cdac667ea0c52e1c6411'],true),
  ('public.context_ghl_history_request_reads(boolean,integer)',ARRAY['b6bb1c72d125f2b578fa155dc9458a11'],true),
  ('public.context_ghl_history_progress()',ARRAY['7732f6d4dd0fe3e2350f8cd0b69d71bf'],true),
  ('public.trigger_ghl_history_schedule()',ARRAY['87de4d4c12adc14b98fb3c1098aea08f'],true)
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
  WHERE n.nspname='public' AND p.proname IN ('context_ghl_history_schedule_policy','context_ghl_history_day_limit','context_ghl_history_due_at',
   'record_ghl_link_attempt','context_ghl_history_link_due','context_ghl_history_request_reads','context_ghl_history_progress',
   'trigger_ghl_history_schedule','context_ghl_history_due','reserve_ghl_history_run')
  AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' NOT IN (
   'context_ghl_history_schedule_policy()','context_ghl_history_day_limit(p_scheduled boolean)',
   'context_ghl_history_due_at(p_max_jobs integer, p_limit jsonb)','record_ghl_link_attempt(p_row jsonb)',
   'context_ghl_history_link_due(p_limit integer)','context_ghl_history_request_reads(p_dry_run boolean, p_limit integer)',
   'context_ghl_history_progress()','trigger_ghl_history_schedule()','context_ghl_history_due(p_max_jobs integer)',
   'reserve_ghl_history_run(p_max_jobs integer, p_actor text)') LOOP
  problems:=problems||format('unexpected overload %s',x.sig);
 END LOOP;
 IF to_regclass('public.context_ghl_history_contacts') IS NULL THEN
  problems:=problems||'context_ghl_history_contacts missing (apply 20260925031500 first)'::text;
 ELSIF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.context_ghl_history_contacts'::regclass AND a.attname='reads_requested_at'
   AND NOT a.attisdropped AND NOT EXISTS(SELECT 1 FROM pg_description d WHERE d.objoid=a.attrelid AND d.classoid='pg_class'::regclass
    AND d.objsubid=a.attnum AND d.description LIKE 'GHL history schedule (20261005190000):%'))
 THEN problems:=problems||'context_ghl_history_contacts.reads_requested_at exists and is not this migration''s'::text; END IF;
 IF to_regclass('public.context_ghl_history_link_attempts') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_description d
   WHERE d.objoid=to_regclass('public.context_ghl_history_link_attempts') AND d.classoid='pg_class'::regclass AND d.objsubid=0
    AND d.description LIKE 'GHL history schedule (20261005190000):%')
 THEN problems:=problems||'context_ghl_history_link_attempts exists and is not this migration''s'::text; END IF;
 -- The reading hand-over writes the backlog writer's list shape.
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_catchup_jobs') AND a.attname='scope' AND NOT a.attisdropped)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_catchup_jobs') AND a.attname='mode' AND NOT a.attisdropped)
 THEN problems:=problems||'context_catchup_jobs lacks mode or scope (apply 20261004100000 first)'::text; END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT string_agg(command,'' | '') FROM cron.job WHERE jobname=''ghl-history-schedule''' INTO cmd;
  IF cmd IS NOT NULL AND cmd<>'SELECT public.trigger_ghl_history_schedule() WHERE public.automation_lane_enabled(''capture'')'
  THEN problems:=problems||'cron job ghl-history-schedule exists with another command'::text; END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'ghl_history_schedule_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The schedule's numbers, in one place. Changed only by migration.
CREATE OR REPLACE FUNCTION public.context_ghl_history_schedule_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  -- Desk decision 5 Oct 2026: 250 jobs a day for 7 days from the first
  -- scheduled run, back to M4's 100 after, and 100 from the first GHL rate
  -- limit on.
  'boost_daily_job_limit',250,
  'boost_days',7,
  -- The actor every scheduled cycle records (handler.ts SCHEDULE_ACTOR).
  'schedule_actor','cron:ghl-history-schedule',
  'cron_jobname','ghl-history-schedule',
  -- A none or ambiguous link verdict is tried again after this many days (the
  -- job's phone or email may have changed); a failed try the next Perth day.
  'link_retry_days',7,
  -- Catch-up priority for loaded jobs: the backlog writer's tiers (2 work in
  -- hand, 3 quotes).
  'reads_priority_status',2,
  'reads_priority_quote',3)
$$;
COMMENT ON FUNCTION public.context_ghl_history_schedule_policy() IS
 'GHL history schedule (B-2): the 250-jobs-a-day boost and its 7 days (desk decision 5 Oct 2026), the scheduled actor, the cron job name, the link retry window and the reading priorities.';

-- 2. The day's limit and why.
CREATE OR REPLACE FUNCTION public.context_ghl_history_day_limit(p_scheduled boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); sp jsonb:=public.context_ghl_history_schedule_policy();
 base integer; boost integer; boost_start timestamptz; boost_until timestamptz; limited_at timestamptz; lim integer; basis text;
BEGIN
 base:=(pol->>'daily_job_limit')::integer;
 boost:=(sp->>'boost_daily_job_limit')::integer;
 SELECT min(c.started_at) INTO boost_start FROM public.context_capture_runs c
 WHERE c.source IN (pol->>'run_source',pol->>'link_run_source') AND c.cursor->>'actor'=sp->>'schedule_actor';
 IF boost_start IS NULL AND coalesce(p_scheduled,false) THEN boost_start:=now(); END IF;
 IF boost_start IS NOT NULL THEN
  boost_until:=boost_start+make_interval(days=>(sp->>'boost_days')::integer);
  -- The first GHL rate limit since the boost began, on a real load or link run.
  SELECT min(c.started_at) INTO limited_at FROM public.context_capture_runs c
  WHERE c.source IN (pol->>'run_source',pol->>'link_run_source') AND c.started_at>=boost_start
   AND (c.error_code LIKE '%ghl_rate_limited%' OR c.cursor->'quota'->>'rate_limited'='true');
 END IF;
 IF limited_at IS NOT NULL THEN lim:=base; basis:='rate_limited';
 ELSIF boost_start IS NULL THEN lim:=base; basis:='base';
 ELSIF now()<boost_until THEN lim:=boost; basis:='boost';
 ELSE lim:=base; basis:='boost_ended';
 END IF;
 RETURN jsonb_build_object('daily_job_limit',lim,'basis',basis,'base_daily_job_limit',base,'boost_daily_job_limit',boost,
  'boost_started_at',boost_start,'boost_until',boost_until,'rate_limited_at',limited_at);
END $$;
COMMENT ON FUNCTION public.context_ghl_history_day_limit(boolean) IS
 'GHL history schedule (B-2): the day''s job limit {daily_job_limit, basis, boost_started_at, boost_until, rate_limited_at}. basis boost (250, within 7 days of the first run whose cursor actor is the scheduled actor), boost_ended (100), rate_limited (100 from the first real load or link run since the boost began whose error_code names ghl_rate_limited, for good), base (100, never scheduled). p_scheduled true: with no scheduled run yet the boost starts now. Read only.';

-- 3. The due list under a given limit, charging each contact once a day.
CREATE OR REPLACE FUNCTION public.context_ghl_history_due_at(p_max_jobs integer, p_limit jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 pol jsonb:=public.context_ghl_history_policy(); lim integer; day_start timestamptz; counted integer; remaining integer;
 picked jsonb:='[]'::jsonb; used integer:=0; charged integer:=0; waiting_contacts integer:=0; waiting_jobs integer:=0;
 over_contacts integer:=0; over_jobs integer:=0; r record; bad_ids integer; cost integer;
BEGIN
 IF p_max_jobs IS NULL OR p_max_jobs<1 THEN RAISE EXCEPTION 'history_due_max_jobs_invalid'; END IF;
 lim:=(p_limit->>'daily_job_limit')::integer;
 IF lim IS NULL OR lim<1 THEN RAISE EXCEPTION 'history_due_limit_invalid'; END IF;
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
  SELECT b.*, h.status AS prior_status, h.resume, coalesce(h.attempts,0) AS attempts,
   coalesce(h.last_attempt_at>=day_start,false) AS charged_today
  FROM by_contact b LEFT JOIN public.context_ghl_history_contacts h ON h.contact_id=b.contact_id
  -- Never loaded, part loaded, or failed on an earlier day (retried, never given up on).
  WHERE h.contact_id IS NULL OR h.status='partial' OR (h.status='failed' AND h.last_attempt_at<day_start)
  ORDER BY (h.status='partial') DESC NULLS LAST, b.tier, b.activity_at DESC NULLS LAST, b.contact_id
 LOOP
  -- Attempted earlier today: today already paid for it.
  cost:=CASE WHEN r.charged_today THEN 0 ELSE r.jobs END;
  IF r.jobs>lim AND NOT r.charged_today THEN
   -- More live jobs than a whole day allows: never inside the bound, so never offered.
   over_contacts:=over_contacts+1; over_jobs:=over_jobs+r.jobs;
  ELSIF used<p_max_jobs AND charged+cost<=remaining THEN
   picked:=picked||jsonb_build_array(jsonb_build_object('contact_id',r.contact_id,'job_ids',to_jsonb(r.job_ids),'jobs',r.jobs,
    'prior_status',r.prior_status,'resume',r.resume,'attempts',r.attempts,'charged_today',r.charged_today));
   used:=used+r.jobs; charged:=charged+cost;
  ELSE
   waiting_contacts:=waiting_contacts+1; waiting_jobs:=waiting_jobs+r.jobs;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('daily_job_limit',lim,'jobs_counted_today',counted,'daily_remaining',remaining,'max_jobs',p_max_jobs,
  'day_start',day_start,'contacts',picked,'jobs_offered',used,'jobs_charged',charged,'contacts_waiting',waiting_contacts,'jobs_waiting',waiting_jobs,
  'contacts_over_daily_limit',over_contacts,'jobs_over_daily_limit',over_jobs,
  'daily_limit_reached',remaining=0,'jobs_invalid_contact_id',bad_ids,'limit',p_limit);
END $$;
COMMENT ON FUNCTION public.context_ghl_history_due_at(integer,jsonb) IS
 'GHL history schedule (B-2): M4''s due list under the given day limit (context_ghl_history_day_limit): partial loads first, then in progress, booked, accepted, quotes, newest activity first; a contact attempted earlier today (Perth) costs nothing against today''s limit (charged_today); jobs_charged is what the offered contacts cost. Read only.';

CREATE OR REPLACE FUNCTION public.context_ghl_history_due(p_max_jobs integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.context_ghl_history_due_at(p_max_jobs,public.context_ghl_history_day_limit(false))
$$;
COMMENT ON FUNCTION public.context_ghl_history_due(integer) IS
 'M4 due list, under the day limit of context_ghl_history_day_limit (B-2, 20261005190000): partial loads first, then in progress, booked, accepted, quotes, newest activity first. The jobs charged never exceed the day''s limit minus the jobs charged by today''s ghl_history_load runs (Perth day); a contact attempted earlier today costs nothing again. Done contacts are not offered; failed ones are offered again on a later day. Read only.';

CREATE OR REPLACE FUNCTION public.reserve_ghl_history_run(p_max_jobs integer, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); sp jsonb:=public.context_ghl_history_schedule_policy();
 v_actor text:=coalesce(nullif(p_actor,''),'actor_missing');
 live_run record; due jsonb; created jsonb; lim jsonb; prev jsonb; cur jsonb; kept integer; reserved integer;
BEGIN
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'history_reserve_actor_invalid'; END IF;
 -- One reservation at a time: a second caller waits here, then sees the first
 -- run's counted jobs.
 PERFORM pg_advisory_xact_lock(hashtextextended('context_ghl_history_load',0));
 SELECT c.id, c.updated_at, c.counts, c.cursor INTO live_run FROM public.context_capture_runs c
 WHERE c.source=pol->>'run_source' AND c.status='running' ORDER BY c.started_at DESC LIMIT 1;
 IF FOUND THEN
  IF live_run.updated_at>clock_timestamp()-make_interval(mins=>(pol->>'running_stale_minutes')::integer) THEN
   RETURN jsonb_build_object('outcome','run_in_progress','run_id',live_run.id);
  END IF;
  -- The worker died mid-run. It keeps the jobs of the contacts it recorded,
  -- never more than it reserved; the contacts it never reached give theirs back.
  reserved:=CASE WHEN jsonb_typeof(live_run.counts->'jobs_covered')='number' THEN (live_run.counts->>'jobs_covered')::integer ELSE 0 END;
  SELECT least(reserved,coalesce(sum(h.jobs),0))::integer INTO kept FROM public.context_ghl_history_contacts h WHERE h.last_run_id=live_run.id;
  PERFORM public.record_capture_run(jsonb_build_object('run_id',live_run.id,'source',pol->>'run_source','status','failed','error_code','run_abandoned',
   'counts',coalesce(live_run.counts,'{}'::jsonb)||jsonb_build_object('jobs_covered',kept),
   'cursor',coalesce(live_run.cursor,'{}'::jsonb)||jsonb_build_object('quota',jsonb_build_object('jobs_reserved',reserved,'jobs_charged',kept,
    'jobs_refunded',reserved-kept,'abandoned',true))));
 END IF;
 lim:=public.context_ghl_history_day_limit(v_actor=sp->>'schedule_actor');
 due:=public.context_ghl_history_due_at(p_max_jobs,lim);
 -- Nothing to load now: no run row (a finished load idles quietly).
 IF jsonb_array_length(due->'contacts')=0 THEN
  RETURN jsonb_build_object('outcome','nothing_due','due',due);
 END IF;
 SELECT c.cursor->'limit' INTO prev FROM public.context_capture_runs c
 WHERE c.source=pol->>'run_source' ORDER BY c.started_at DESC LIMIT 1;
 IF prev IS NULL OR jsonb_typeof(prev)<>'object' THEN
  prev:=jsonb_build_object('daily_job_limit',(pol->>'daily_job_limit')::integer,'basis','base');
 END IF;
 cur:=jsonb_build_object('v',1,'actor',v_actor,'limit',lim);
 IF (prev->>'daily_job_limit',prev->>'basis') IS DISTINCT FROM (lim->>'daily_job_limit',lim->>'basis') THEN
  cur:=cur||jsonb_build_object('limit_switch',jsonb_build_object(
   'from',jsonb_build_object('daily_job_limit',(prev->>'daily_job_limit')::integer,'basis',prev->>'basis'),
   'to',jsonb_build_object('daily_job_limit',(lim->>'daily_job_limit')::integer,'basis',lim->>'basis')));
 END IF;
 created:=public.record_capture_run(jsonb_build_object('source',pol->>'run_source','status','running','window_to',clock_timestamp(),
  'cursor',cur,
  'counts',jsonb_build_object('dry_run',0,'jobs_covered',(due->>'jobs_charged')::integer,'daily_job_limit',(due->>'daily_job_limit')::integer,
   'jobs_counted_before',(due->>'jobs_counted_today')::integer,'daily_remaining',(due->>'daily_remaining')::integer,
   'contacts_due',jsonb_array_length(due->'contacts'))));
 RETURN jsonb_build_object('outcome','reserved','run_id',created->>'run_id','due',due,'cursor',cur);
END $$;
COMMENT ON FUNCTION public.reserve_ghl_history_run(integer,text) IS
 'M4, replaced by B-2 (20261005190000): starts a real history-load run atomically. Under one transaction-scoped advisory lock: refuses while another real run is live (run_in_progress), closes an abandoned one (run_abandoned, keeping only the jobs of the contacts it recorded), selects the due contacts under the day''s limit (context_ghl_history_day_limit; the scheduled actor starts the boost) and creates the run row with the jobs they charge counted in jobs_covered, the limit on its cursor, and limit_switch when the limit changed since the previous run. With nothing due it creates no run row (nothing_due). The edge function lowers jobs_covered at the end to the jobs it actually loaded. Returns {outcome: reserved, run_id, due, cursor}, {outcome: run_in_progress, run_id} or {outcome: nothing_due, due}.';

-- 4. The link step's record of every job it has tried.
CREATE TABLE IF NOT EXISTS public.context_ghl_history_link_attempts (
 job_id uuid PRIMARY KEY,
 verdict text NOT NULL CHECK (verdict IN ('certain','ambiguous','none','failed')),
 reason text NOT NULL CHECK (reason ~ '^[a-z0-9][a-z0-9_.:-]{0,119}$'),
 last_run_id uuid NOT NULL REFERENCES public.context_capture_runs(id),
 attempts integer NOT NULL DEFAULT 1 CHECK (attempts>=1),
 first_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor text NOT NULL CHECK (actor ~ '^[A-Za-z0-9_.:@-]{1,128}$')
);
CREATE INDEX IF NOT EXISTS context_ghl_history_link_attempts_verdict ON public.context_ghl_history_link_attempts(verdict,last_attempt_at);
ALTER TABLE public.context_ghl_history_link_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ghl_history_link_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.context_ghl_history_link_attempts TO service_role;
COMMENT ON TABLE public.context_ghl_history_link_attempts IS
 'GHL history schedule (20261005190000): one row per live job the M4 link step has judged in a real run: verdict (certain, ambiguous, none, failed), a reason code, the run and the actor. Ids and codes only, never a phone or email key. Written only through record_ghl_link_attempt(); service_role has SELECT only. A live job with no GHL contact counts as done for the history load once it has a row other than failed.';

-- p_row keys: job_id, run_id (a ghl_history_link run; a dry run never writes),
-- verdict, reason, actor. An existing row is updated and its attempts counted.
CREATE OR REPLACE FUNCTION public.record_ghl_link_attempt(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); v_job uuid; v_run uuid; v_verdict text; v_reason text; v_actor text;
 out_row public.context_ghl_history_link_attempts;
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_row) x WHERE x NOT IN ('job_id','run_id','verdict','reason','actor'))
 THEN RAISE EXCEPTION 'history_link_attempt_invalid'; END IF;
 BEGIN
  v_job:=(p_row->>'job_id')::uuid; v_run:=(p_row->>'run_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'history_link_attempt_invalid';
 END;
 v_verdict:=p_row->>'verdict'; v_reason:=p_row->>'reason';
 v_actor:=coalesce(nullif(p_row->>'actor',''),'actor_missing');
 IF v_job IS NULL THEN RAISE EXCEPTION 'history_link_attempt_invalid'; END IF;
 IF v_verdict IS NULL OR v_verdict NOT IN ('certain','ambiguous','none','failed') THEN RAISE EXCEPTION 'history_link_attempt_verdict_invalid'; END IF;
 IF v_reason IS NULL OR v_reason !~ '^[a-z0-9][a-z0-9_.:-]{0,119}$' THEN RAISE EXCEPTION 'history_link_attempt_reason_invalid'; END IF;
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'history_link_attempt_actor_invalid'; END IF;
 IF v_run IS NULL OR NOT EXISTS(SELECT 1 FROM public.context_capture_runs c WHERE c.id=v_run AND c.source=pol->>'link_run_source')
 THEN RAISE EXCEPTION 'history_link_attempt_run_invalid'; END IF;
 INSERT INTO public.context_ghl_history_link_attempts AS a(job_id,verdict,reason,last_run_id,attempts,first_attempt_at,last_attempt_at,actor)
 VALUES(v_job,v_verdict,v_reason,v_run,1,clock_timestamp(),clock_timestamp(),v_actor)
 ON CONFLICT (job_id) DO UPDATE SET verdict=EXCLUDED.verdict,reason=EXCLUDED.reason,last_run_id=EXCLUDED.last_run_id,
  attempts=a.attempts+1,last_attempt_at=EXCLUDED.last_attempt_at,actor=EXCLUDED.actor
 RETURNING * INTO out_row;
 RETURN jsonb_build_object('outcome',CASE WHEN out_row.attempts=1 THEN 'created' ELSE 'updated' END,'job_id',out_row.job_id,
  'verdict',out_row.verdict,'attempts',out_row.attempts);
END $$;
COMMENT ON FUNCTION public.record_ghl_link_attempt(jsonb) IS
 'The one writer of context_ghl_history_link_attempts (B-2). Upserts one job''s link verdict against a real ghl_history_link run; attempts counted, first attempt kept. Refusal codes: history_link_attempt_invalid, history_link_attempt_verdict_invalid, history_link_attempt_reason_invalid, history_link_attempt_actor_invalid, history_link_attempt_run_invalid.';

-- The live jobs with no GHL contact that are due a link try: never tried
-- first, then by tier. Same columns and keys as M4's candidates page.
CREATE OR REPLACE FUNCTION public.context_ghl_history_link_due(p_limit integer)
RETURNS TABLE(job_id uuid, job_number text, tier integer, phone_key text, email_key text, own_contact_id text, own_contacts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_ghl_history_policy() AS p, public.context_ghl_history_schedule_policy() AS s),
 day AS (SELECT (date_trunc('day',now() AT TIME ZONE (pol.p->>'day_zone'))) AT TIME ZONE (pol.p->>'day_zone') AS start FROM pol),
 due AS (
  SELECT l.job_id, l.job_number, l.tier, (a.job_id IS NULL) AS never
  FROM public.context_ghl_history_live_jobs() l
  LEFT JOIN public.context_ghl_history_link_attempts a ON a.job_id=l.job_id
  CROSS JOIN pol CROSS JOIN day
  WHERE l.ghl_contact_id IS NULL
   AND (a.job_id IS NULL
    OR (a.verdict='failed' AND a.last_attempt_at<day.start)
    OR (a.verdict<>'failed' AND a.last_attempt_at<now()-make_interval(days=>(pol.s->>'link_retry_days')::integer)))
  ORDER BY (a.job_id IS NULL) DESC, l.tier, l.job_id
  LIMIT greatest(1,least(coalesce(p_limit,100),(SELECT (pol.p->>'link_page_limit')::integer FROM pol)))
 )
 SELECT d.job_id, d.job_number, d.tier, k.phone_key, k.email_key, o.contact_id, coalesce(o.contacts,0)
 FROM due d
 JOIN public.jobs j ON j.id=d.job_id
 CROSS JOIN LATERAL (SELECT public.context_phone_key(j.client_phone) AS phone_key, public.context_email_key(j.client_email) AS email_key) k
 LEFT JOIN LATERAL (SELECT * FROM public.context_contact_for_key(k.email_key,k.phone_key)) o ON k.phone_key IS NOT NULL OR k.email_key IS NOT NULL
 ORDER BY d.never DESC, d.tier, d.job_id
$$;
COMMENT ON FUNCTION public.context_ghl_history_link_due(integer) IS
 'GHL history schedule (B-2): live jobs with no GHL contact due a link try (never tried, a failed try before today in Perth, or another verdict older than the retry window), never-tried first, then by tier, at most 500, with M4''s B0 phone and email keys and the contact our own records give them. Read only; the keys go only to the service-role edge function.';

-- 5. Reading: hand the live jobs of every completed contact to the reader.
ALTER TABLE public.context_ghl_history_contacts ADD COLUMN IF NOT EXISTS reads_requested_at timestamptz;
COMMENT ON COLUMN public.context_ghl_history_contacts.reads_requested_at IS
 'GHL history schedule (20261005190000): when context_ghl_history_request_reads last handed this contact''s live jobs to the reader. Null or older than completed_at: not yet handed over since the history finished.';

CREATE OR REPLACE FUNCTION public.context_ghl_history_request_reads(p_dry_run boolean DEFAULT true, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dry boolean:=coalesce(p_dry_run,true); lim integer:=coalesce(p_limit,200); sp jsonb:=public.context_ghl_history_schedule_policy();
 ready text[]; waiting integer; judged jsonb; added integer:=0; reopened integer:=0; raised integer:=0; stamped integer:=0;
BEGIN
 IF lim NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'history_reads_limit_invalid: limit must be 1 to 1000'; END IF;
 -- The catch-up writers' lock (context_catchup_request, the backlog writer).
 PERFORM pg_advisory_xact_lock(20260924,22);
 SELECT coalesce(array_agg(x.contact_id ORDER BY x.completed_at, x.contact_id),'{}') INTO ready FROM (
  SELECT h.contact_id, h.completed_at FROM public.context_ghl_history_contacts h
  WHERE h.status='done' AND (h.reads_requested_at IS NULL OR h.reads_requested_at<h.completed_at)
  ORDER BY h.completed_at, h.contact_id LIMIT lim) x;
 SELECT count(*)::integer-cardinality(ready) INTO waiting FROM public.context_ghl_history_contacts h
 WHERE h.status='done' AND (h.reads_requested_at IS NULL OR h.reads_requested_at<h.completed_at);

 -- The backlog writer's per-job rule (20261004100000), for these jobs only.
 WITH member AS (
  SELECT l.job_id AS id, l.job_number, l.ghl_contact_id AS contact_id,
   CASE WHEN l.live_basis='status' THEN (sp->>'reads_priority_status')::integer ELSE (sp->>'reads_priority_quote')::integer END AS tier,
   (SELECT max(r.finished_at) FROM public.context_extraction_runs r
    WHERE r.job_id=l.job_id AND r.phase='extraction' AND r.status='done') AS last_read
  FROM public.context_ghl_history_live_jobs() l WHERE l.ghl_contact_id=ANY(ready)
 ), el AS (
  SELECT e.job_id, count(*) AS eligible_n,
   count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)) AS full_n
  FROM public.context_catchup_eligible_rows(ARRAY(SELECT m.id FROM member m)) e GROUP BY e.job_id
 ), un AS (
  SELECT u.job_id, count(*) AS unread_n FROM public.context_unread_rows(ARRAY(SELECT m.id FROM member m)) u
  WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=u.job_id AND r.event_id=u.id)
  GROUP BY u.job_id
 ), pe AS (
  SELECT p.job_id, count(*) AS pending_n FROM public.context_catchup_pending_rows(ARRAY(SELECT m.id FROM member m)) p GROUP BY p.job_id
 ), base AS (
  SELECT m.*, coalesce(el.eligible_n,0) AS eligible_n, coalesce(el.full_n,0) AS full_n, coalesce(un.unread_n,0) AS unread_n,
   coalesce(pe.pending_n,0) AS listed_pending_n, c.job_id IS NOT NULL AS listed, c.done_at IS NOT NULL AS was_done,
   c.priority AS old_priority, c.mode AS old_mode
  FROM member m LEFT JOIN el ON el.job_id=m.id LEFT JOIN un ON un.job_id=m.id LEFT JOIN pe ON pe.job_id=m.id
  LEFT JOIN public.context_catchup_jobs c ON c.job_id=m.id
 ), moded AS (
  SELECT b.*,
   CASE WHEN b.listed AND NOT b.was_done THEN b.old_mode WHEN b.last_read IS NULL AND NOT b.listed THEN 'full' ELSE 'unread' END AS mode,
   CASE WHEN b.listed AND NOT b.was_done THEN b.listed_pending_n WHEN b.last_read IS NULL AND NOT b.listed THEN b.full_n ELSE b.unread_n END AS pending_n
  FROM base b
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',d.id,'job_number',d.job_number,'contact_id',d.contact_id,'tier',d.tier,
   'mode',d.mode,'pending_rows',d.pending_n,'action',CASE
   WHEN d.eligible_n=0 THEN 'no_evidence'
   WHEN d.listed AND NOT d.was_done AND d.tier<d.old_priority THEN 'raise'
   WHEN d.listed AND NOT d.was_done THEN 'already_listed'
   WHEN d.pending_n=0 THEN 'nothing_unread'
   WHEN d.listed THEN 'reopen'
   ELSE 'add' END) ORDER BY d.job_number, d.id),'[]'::jsonb)
 INTO judged FROM moded d;

 IF NOT dry THEN
  WITH src AS (SELECT (x->>'job_id')::uuid AS job_id, x->>'action' AS action, x->>'mode' AS mode, (x->>'tier')::integer AS tier
   FROM jsonb_array_elements(judged) x),
  ins AS (INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope)
   SELECT s.job_id, coalesce(j.job_number,''), s.tier, s.mode, 'backlog' FROM src s JOIN public.jobs j ON j.id=s.job_id WHERE s.action='add'
   ON CONFLICT (job_id) DO NOTHING RETURNING job_id),
  reo AS (UPDATE public.context_catchup_jobs c SET done_at=NULL,done_run_id=NULL,requested_at=now(),mode='unread',scope='backlog',priority=s.tier
   FROM src s WHERE c.job_id=s.job_id AND s.action='reopen' AND c.done_at IS NOT NULL RETURNING c.job_id),
  rai AS (UPDATE public.context_catchup_jobs c SET priority=s.tier
   FROM src s WHERE c.job_id=s.job_id AND s.action='raise' AND c.done_at IS NULL AND c.priority>s.tier RETURNING c.job_id)
  SELECT (SELECT count(*) FROM ins),(SELECT count(*) FROM reo),(SELECT count(*) FROM rai) INTO added, reopened, raised;
  UPDATE public.context_ghl_history_contacts h SET reads_requested_at=clock_timestamp() WHERE h.contact_id=ANY(ready);
  GET DIAGNOSTICS stamped=ROW_COUNT;
 END IF;

 RETURN jsonb_build_object('dry_run',dry,'as_of',now(),'limit',lim,
  'contacts_handled',cardinality(ready),'contacts_more',waiting,
  'jobs_considered',jsonb_array_length(judged),
  'jobs_listed',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action' IN ('add','reopen','raise')),
  'by_action',jsonb_build_object(
   'add',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='add'),
   'reopen',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='reopen'),
   'raise',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='raise'),
   'already_listed',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='already_listed'),
   'nothing_unread',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='nothing_unread'),
   'no_evidence',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='no_evidence')),
  'estimated_runs',(SELECT coalesce(sum(ceil((x->>'pending_rows')::numeric/25)),0)::integer FROM jsonb_array_elements(judged) x
   WHERE x->>'action' IN ('add','reopen')),
  'jobs',judged,
  'written',CASE WHEN dry THEN NULL ELSE jsonb_build_object('added',added,'reopened',reopened,'priority_raised',raised,'contacts_stamped',stamped) END);
END $$;
COMMENT ON FUNCTION public.context_ghl_history_request_reads(boolean,integer) IS
 'GHL history schedule (B-2): for up to p_limit contacts whose history is done and not handed to the reader since it finished, lists their live jobs on the catch-up list (scope backlog, priority 2 for work in hand and 3 for quotes) with the backlog writer''s rule: never read and not listed reads in full, otherwise only unread rows; a pending row is never lowered; a done row re-opens only with unread rows; a job with nothing to read gets no row. Stamps reads_requested_at. Dry run (the default) writes nothing. The reader takes the jobs under its unchanged caps. Service role only.';

-- 6. The after-check in one read.
CREATE OR REPLACE FUNCTION public.context_ghl_history_progress() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_ghl_history_policy() AS p),
 day AS (SELECT (date_trunc('day',now() AT TIME ZONE (pol.p->>'day_zone'))) AT TIME ZONE (pol.p->>'day_zone') AS start FROM pol),
 per AS (
  SELECT l.job_id, l.ghl_contact_id, l.ghl_contact_id ~ '^[A-Za-z0-9_-]{6,64}$' AS valid_contact, h.status AS history, a.verdict
  FROM public.context_ghl_history_live_jobs() l
  LEFT JOIN public.context_ghl_history_contacts h ON h.contact_id=l.ghl_contact_id
  LEFT JOIN public.context_ghl_history_link_attempts a ON a.job_id=l.job_id
 ), today AS (
  SELECT count(*) FILTER (WHERE c.source=pol.p->>'run_source') AS load_runs,
   count(*) FILTER (WHERE c.source=pol.p->>'link_run_source') AS link_runs,
   coalesce(sum(CASE WHEN c.source=pol.p->>'run_source' AND jsonb_typeof(c.counts->'jobs_covered')='number'
    THEN (c.counts->>'jobs_covered')::integer ELSE 0 END),0) AS jobs_charged
  FROM public.context_capture_runs c CROSS JOIN pol CROSS JOIN day
  WHERE c.source IN (pol.p->>'run_source',pol.p->>'link_run_source') AND c.started_at>=day.start
 )
 SELECT jsonb_build_object('as_of',now(),
  'live_jobs',(SELECT count(*) FROM per),
  'jobs_done',(SELECT count(*) FROM per WHERE history='done' OR (ghl_contact_id IS NULL AND verdict IN ('certain','ambiguous','none'))),
  'with_contact',(SELECT count(*) FROM per WHERE ghl_contact_id IS NOT NULL),
  'history_done',(SELECT count(*) FROM per WHERE history='done'),
  'history_partial',(SELECT count(*) FROM per WHERE history='partial'),
  'history_failed',(SELECT count(*) FROM per WHERE history='failed'),
  'history_not_started',(SELECT count(*) FROM per WHERE ghl_contact_id IS NOT NULL AND valid_contact AND history IS NULL),
  'invalid_contact_id',(SELECT count(*) FROM per WHERE ghl_contact_id IS NOT NULL AND NOT valid_contact),
  'no_contact',(SELECT count(*) FROM per WHERE ghl_contact_id IS NULL),
  'no_contact_tried',(SELECT count(*) FROM per WHERE ghl_contact_id IS NULL AND verdict IN ('certain','ambiguous','none')),
  'no_contact_failed_try',(SELECT count(*) FROM per WHERE ghl_contact_id IS NULL AND verdict='failed'),
  'no_contact_untried',(SELECT count(*) FROM per WHERE ghl_contact_id IS NULL AND verdict IS NULL),
  'contacts_reads_pending',(SELECT count(*) FROM public.context_ghl_history_contacts h
   WHERE h.status='done' AND (h.reads_requested_at IS NULL OR h.reads_requested_at<h.completed_at)),
  'today',(SELECT jsonb_build_object('load_runs',t.load_runs,'link_runs',t.link_runs,'jobs_charged',t.jobs_charged) FROM today t),
  'limit',public.context_ghl_history_day_limit(false))
$$;
COMMENT ON FUNCTION public.context_ghl_history_progress() IS
 'GHL history schedule (B-2): the after-check in one read. jobs_done counts live jobs whose GHL contact''s history is done plus live jobs with no GHL contact that the link step has tried (certain, ambiguous or none); the rest split by state; today''s runs and the jobs charged against today''s limit; the limit and why. Read only.';

-- 7. The schedule. Idle while live texts or the attribution lane are off
-- (the load would idle anyway; this spares the call).
CREATE OR REPLACE FUNCTION public.trigger_ghl_history_schedule() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_ghl_item_flag(); sp jsonb:=public.context_ghl_history_schedule_policy();
BEGIN
 IF coalesce((f->>'enabled')::boolean,false) IS NOT TRUE OR NOT public.automation_lane_enabled('attribution') THEN RETURN; END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-history-load',
  body := jsonb_build_object('action','scheduled'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json',
   'x-sw-actor',sp->>'schedule_actor'),
  timeout_milliseconds := 5000
 );
END $$;
COMMENT ON FUNCTION public.trigger_ghl_history_schedule() IS
 'pg_cron ghl-history-schedule (every 15 minutes, capture lane): posts {action: scheduled} to the ghl-history-load edge function with the service key while ghl_message_capture_v2 and the attribution lane are on. One cycle: link the jobs due a try, load the due contacts, hand completed contacts'' jobs to the reader; each step idles when nothing is due. B-2.';

-- The capture lane owns the new job. Same body as 20261002150000 plus one row.
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
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its
-- unwrap can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'ghl history schedule: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='ghl-history-schedule') THEN
  PERFORM cron.schedule('ghl-history-schedule','7-59/15 * * * *',
   $cmd$SELECT public.trigger_ghl_history_schedule() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
END $cron$;

-- 8. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_ghl_history_schedule_policy(),public.context_ghl_history_day_limit(boolean),
 public.context_ghl_history_due_at(integer,jsonb),public.context_ghl_history_due(integer),public.reserve_ghl_history_run(integer,text),
 public.record_ghl_link_attempt(jsonb),public.context_ghl_history_link_due(integer),public.context_ghl_history_request_reads(boolean,integer),
 public.context_ghl_history_progress(),public.trigger_ghl_history_schedule() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ghl_history_schedule_policy(),public.context_ghl_history_day_limit(boolean),
 public.context_ghl_history_due_at(integer,jsonb),public.context_ghl_history_due(integer),public.reserve_ghl_history_run(integer,text),
 public.record_ghl_link_attempt(jsonb),public.context_ghl_history_link_due(integer),public.context_ghl_history_request_reads(boolean,integer),
 public.context_ghl_history_progress() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ghl_history_schedule() TO postgres;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
