-- History depth, PR B (7 Oct 2026): the deep email history load. Each selected
-- Outlook mailbox is read backwards, past the reader's own 60-day limit, to the
-- start of the oldest monitored live job and never further, and every
-- monitored live job's email history is measured: "loaded back to X; the job
-- started Y". Done-definition row 14. Built on W7 (20261006030000) and the
-- reader's deep mode (outlook-mail-capture/capture.ts, this PR).
--
-- Why: the 60-day limit is our own rule, not Microsoft's (design
-- ops/history-depth-design.md section 1.6). Of the live jobs, most began
-- before the 60-day floor (7 Aug 2026), so their earlier email was never read.
--
-- The owner's rulings this follows (7 Oct 2026): a live job (status not
-- cancelled, draft, archived, complete, completed or lost) is monitored unless
-- it is a lead with no progress whose newest quote send and the customer's
-- newest inbound message are both 28 days old or more; the old fact reader is
-- retired (this load lists nothing for it); nothing messages anyone.
--
-- What it adds (no existing table, row or flag is changed):
--  1. Flag email_reader_deep_v1, created OFF (a re-apply keeps the owner's
--     setting). The tick idles, and the reader refuses mode deep, while it is
--     off.
--  2. context_email_deep_policy(): every number of the load, changed only by
--     migration: the live rule, the lead rule's 28 days, the 30-day lead-in (a
--     job's email history starts 30 days before its first record, because the
--     enquiry comes before the job; the story's record layer reads legacy mail
--     the same way), the hard floor (1 Jan 2025 Perth), 31-day user slices,
--     2 calls a tick, 3 calls without progress then 6 hours' rest.
--  3. context_email_deep_scope_jobs(as_of): one row per live job: monitored,
--     the lead rule used, its first record (the earliest of its created time,
--     any row placed on it except a deep row, its first document and its
--     first invoice date), its lead-in, and its keys (job number, client email,
--     builder references). Monitored follows the lead-rule slice's own rule
--     once it is on the database (20261007010000, PR 985): read once as a set,
--     context_lead_monitored_jobs(NULL, as_of), else, with only its boolean
--     context_lead_monitored(job, as_of), job by job; lead_rule
--     context_lead_monitored. Until then the owner's rule as stated above
--     (lead_rule deep_fallback); if the slice's function is there but does not
--     answer in its shape, the owner's rule and lead_rule
--     deep_fallback_lead_rule_unreadable. A deep row never moves a start, so
--     the load cannot walk itself back.
--  4. Tables, written only by the tick, service role SELECT only:
--     context_email_deep_members (the monitored jobs and when each joined;
--     a job whose keys change, or whose start moves earlier, joins again),
--     context_email_deep_plan (one row per selected source), and
--     context_email_deep_reach (how far back one mailbox's mail is complete
--     for one job).
--  5. context_email_deep_scope(): what the reader keeps, for the monitored
--     jobs: each key with the earliest lead-in of the jobs carrying it.
--  6. trigger_context_email_deep_history(): the tick, every 5 minutes from
--     the new pg_cron job outlook-mail-deep-history, gated by the capture
--     lane. Idle unless email_reader_v1, email_reader_schedule_v1,
--     email_capture_v2 and email_reader_deep_v1 are on. It keeps the members,
--     fixes each source's live floor once (the reader's own first live window:
--     the earliest window_from of its poll and sweep runs), and walks each
--     mailbox from the highest gap down: the next slice ends at the latest
--     reach of the jobs still short of their start and begins 31 days earlier
--     or at the oldest start among the jobs it credits, whichever is later (a
--     user mailbox), or at the oldest such start (a group, walked in one
--     window), so it never reads below the oldest monitored job's start. Each
--     call names its slice (slice: the time the slice was first posted, ISO);
--     the reader keeps that id on the run's cursor (deep_slice) and resumes
--     only a run of the same slice, and the tick judges only a run of the same
--     slice that started after it was posted, so a run of another posting of
--     the same window (an earlier walk's, or a stray call's) never counts for
--     it. A slice's succeeded run moves the reach of every job that was a
--     member when the slice was first posted and whose reach the slice joins.
--     A job that joins later is caught up by the next walk, which starts at
--     most once a Perth day. The W7 rules hold: a run judged once, moved =
--     succeeded or counts.progressed > 0, 3 calls without a move = stalled
--     with a WARNING and tried again 6 hours later, a source waits while its
--     own run or the 60-day load of the same mailbox runs, up to 2 calls a
--     tick to different mailboxes, groups first. It never lists anything for
--     the old fact reader.
--  7. context_email_deep_status(): the load as one read for the desk.
--  8. The scorecard's read (scorecard v2 reads these; nothing here touches
--     context_scorecard or context_scorecard_jobs):
--     context_email_history_reach_jobs(job_ids, as_of): one row per live job,
--       its email history reach (the most-behind selected mailbox decides),
--       status reaches_start / loading / short / not_started / unknown_start /
--       not_monitored, the reason, and the per-mailbox reaches;
--     context_email_history_reach(as_of): each mailbox's reach and whether it
--       is finished, and the job counts by status (the row 14 lane).
--  9. automation_switch_cron_lanes(): the live list plus one row,
--     ('outlook-mail-deep-history','capture'), so the automation switch's wrap
--     and unwrap know the new job: B-5's body (20261005210000, production on
--     7 Oct 2026) or, when the history daily slice (20261007050000, PR 989)
--     merged first, that slice's body (B-5's plus xero-history-daily), each
--     with every row it has kept; a list that already names the job is left
--     alone. Either merge order ends with both rows.
--
-- Deep rows never go to AI placement: the reader marks every deep row
-- metadata.history_tier deep, and the attribution worker never asks about such
-- a row (secureworks-jarvis luna-context-worker, history depth P1). The
-- privacy rule of the owner mailboxes (jan, marnin) is the reader's own and
-- is unchanged.
--
-- Replaces one function: automation_switch_cron_lanes(), md5(prosrc)
-- 99e6d70e80a79e548f2478b65fc6cd78 (B-5, read live 7 Oct 2026),
-- 81cbebf914f537b0b85870196cbd0f75 (the history daily slice, PR 989 at
-- 446ab25e), or this migration's on either (a re-apply):
-- 250d7e9ec2ebecc7e83192a39b7da488 and 6498276b1eb16b527fb76dd2b0fa6d83; any
-- other list is accepted only when it already names outlook-mail-deep-history
-- on the capture lane, and is then left alone. Called, never replaced, so only
-- their presence is checked: context_email_reader_flags,
-- automation_lane_enabled, sw_service_key, and W7's plan table. Read when
-- present, never replaced: the lead-rule slice's context_lead_monitored_jobs
-- and context_lead_monitored. The guard refuses otherwise, and when a new
-- object exists that is not this migration's, or the flag already exists on
-- the first apply.
--
-- After deploy (each needs the owner's go, in order): the counts-only probe
-- (go point G6: scripts/context-email-deep-probe.sh, writes nothing), then
-- turning the flag on (G7). Read-only check: scripts/context-email-deep-check.sql.
-- Stop at once: update public.feature_flags set enabled=false where
-- flag_name='email_reader_deep_v1'; (or the capture lane).
--
-- No flag is turned on, no business_events row is written, no mail is read by
-- this migration, and no grant, policy or view is added for anon or
-- authenticated. Every new function: fixed search_path (except the per-row
-- helper context_email_deep_job_refs, which inlines into its callers),
-- EXECUTE revoked from PUBLIC, anon and authenticated.
--
-- Rollback: supabase/rollbacks/20261007080000_context_email_deep_history_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; first_apply boolean; sig text; note text;
BEGIN
 first_apply:=to_regclass('public.context_email_deep_plan') IS NULL;
 -- The lane list: B-5's body, the history daily slice's, this migration's on
 -- either, or any list that already names this migration's job on the capture
 -- lane (then left alone).
 live:=NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.automation_switch_cron_lanes()');
 IF live IS NULL THEN
  problems:=problems||'public.automation_switch_cron_lanes() md5 <missing>'::text;
 ELSIF NOT live=ANY(ARRAY['99e6d70e80a79e548f2478b65fc6cd78','81cbebf914f537b0b85870196cbd0f75',
   '250d7e9ec2ebecc7e83192a39b7da488','6498276b1eb16b527fb76dd2b0fa6d83'])
  AND NOT EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname='outlook-mail-deep-history' AND l.lane='capture') THEN
  problems:=problems||format('public.automation_switch_cron_lanes() md5 %s',live);
 END IF;
 FOREACH sig IN ARRAY ARRAY['public.context_email_reader_flags()','public.automation_lane_enabled(text)','public.sw_service_key()'] LOOP
  IF to_regprocedure(sig) IS NULL THEN problems:=problems||format('%s is missing',sig); END IF;
 END LOOP;
 IF to_regclass('public.context_email_history_plan') IS NULL
  OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid='public.context_email_history_plan'::regclass
   AND a.attname IN ('source_key','state') AND a.attnum>0 AND NOT a.attisdropped)<>2 THEN
  problems:=problems||'public.context_email_history_plan (source_key, state) is missing (apply 20261006030000 first)'::text;
 END IF;
 FOREACH sig IN ARRAY ARRAY['public.context_capture_runs','public.monitored_mailboxes','public.feature_flags','public.jobs',
  'public.business_events','public.job_documents','public.job_events','public.xero_invoices','public.job_assignments'] LOOP
  IF to_regclass(sig) IS NULL THEN problems:=problems||format('%s is missing',sig); END IF;
 END LOOP;
 -- New objects: absent, or this migration's own (its comment says so).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_email_deep_policy()'),('public.context_email_deep_enabled()'),('public.context_email_deep_job_refs(jsonb)'),
  ('public.context_email_deep_live_floor(text)'),('public.context_email_deep_scope_jobs(timestamp with time zone)'),
  ('public.context_email_deep_scope()'),('public.trigger_context_email_deep_history()'),('public.context_email_deep_status()'),
  ('public.context_email_history_reach_jobs(uuid[],timestamp with time zone)'),('public.context_email_history_reach(timestamp with time zone)')
 ) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NOT NULL THEN
   note:=coalesce(obj_description(to_regprocedure(x.sig),'pg_proc'),'');
   IF note NOT LIKE 'History depth (20261007080000)%' THEN problems:=problems||format('%s exists and is not this migration''s',x.sig); END IF;
  END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES ('public.context_email_deep_members'),('public.context_email_deep_plan'),('public.context_email_deep_reach')) AS t(rel) LOOP
  IF to_regclass(x.rel) IS NOT NULL THEN
   note:=coalesce(obj_description(to_regclass(x.rel),'pg_class'),'');
   IF note NOT LIKE 'History depth (20261007080000)%' THEN problems:=problems||format('%s exists and is not this migration''s',x.rel); END IF;
  END IF;
 END LOOP;
 IF to_regclass('public.feature_flags') IS NOT NULL AND first_apply
  AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_deep_v1') THEN
  problems:=problems||'feature flag email_reader_deep_v1 already exists; this migration creates it off'::text;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'email_deep_history_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The flag, off. A re-apply keeps the owner's setting.
INSERT INTO public.feature_flags(flag_name,enabled,description)
SELECT 'email_reader_deep_v1',false,'Deep email history (history depth, 20261007080000): the 5-minute tick outlook-mail-deep-history reads each selected Outlook mailbox backwards past the 60-day limit, to the start of the oldest monitored live job, keeping only mail touching a monitored live job. Also needs email_reader_v1, email_reader_schedule_v1 and email_capture_v2. Off switch: this flag or the capture lane.'
WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_deep_v1');

-- 2. Every number of the load, in one place.
CREATE OR REPLACE FUNCTION public.context_email_deep_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $fn$
 SELECT jsonb_build_object(
  'version','email-deep-v1',
  'live_excluded_statuses',jsonb_build_array('cancelled','draft','archived','complete','completed','lost'),
  'lead_quiet_days',28,
  'lead_not_progressed_statuses',jsonb_build_array('draft','quoted','lead','new','cancelled','lost','archived'),
  'lead_in_days',30,
  'hard_floor','2024-12-31T16:00:00.000Z',
  'user_slice_days',31,
  'user_window_max_days',32,
  'calls_per_tick',2,
  'stall_after_calls',3,
  'stall_rest_hours',6,
  'running_fresh_minutes',10,
  'walks_per_perth_day',1)
$fn$;
COMMENT ON FUNCTION public.context_email_deep_policy() IS
 'History depth (20261007080000): every number of the deep email history load, changed only by migration. live_excluded_statuses is the done definition''s live rule; lead_quiet_days and lead_not_progressed_statuses are the owner''s 7 Oct 2026 lead rule (the fallback while the lead-rule slice''s context_lead_monitored_jobs and context_lead_monitored are absent); lead_in_days: a job''s email history starts that many days before its first record; hard_floor (1 Jan 2025 Perth): no deep window starts before it; user_slice_days: one slice of a user mailbox; calls_per_tick, stall_after_calls, stall_rest_hours: the W7 rules; walks_per_perth_day: a source starts a new walk at most once a Perth day.';

-- 3. The reader's gate: the flag and the bounds it checks every deep window against.
CREATE OR REPLACE FUNCTION public.context_email_deep_enabled() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE d boolean; pol jsonb:=public.context_email_deep_policy();
BEGIN
 SELECT bool_or(ff.enabled) INTO d FROM public.feature_flags ff WHERE ff.flag_name='email_reader_deep_v1';
 RETURN jsonb_build_object('enabled',coalesce(d,false),'state',CASE WHEN d IS NULL THEN 'missing' ELSE 'present' END,
  'hard_floor',pol->>'hard_floor','user_window_max_days',(pol->>'user_window_max_days')::integer);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('enabled',false,'state','unreadable','hard_floor',pol->>'hard_floor',
  'user_window_max_days',(pol->>'user_window_max_days')::integer);
END $fn$;
COMMENT ON FUNCTION public.context_email_deep_enabled() IS
 'History depth (20261007080000): the email reader''s deep gate: enabled (flag email_reader_deep_v1; missing or unreadable reads off), the hard floor no deep window may start before, and the longest user-mailbox window. Service role.';

-- 4. A job's builder references, as stored (upper case, at least 5 characters,
-- distinct, byte order). Per-row helper: no SET, so it inlines.
CREATE OR REPLACE FUNCTION public.context_email_deep_job_refs(p_metadata jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $fn$
 SELECT coalesce(array_agg(DISTINCT r.v ORDER BY r.v),'{}'::text[])
 FROM (SELECT upper(btrim(p_metadata->>k.k)) COLLATE "C" AS v
       FROM unnest(ARRAY['builder_claim_ref','builder_po_number','builder_work_order_number','external_ref']) AS k(k)) r
 WHERE length(r.v)>=5
$fn$;
COMMENT ON FUNCTION public.context_email_deep_job_refs(jsonb) IS
 'History depth (20261007080000): a job''s builder references as stored in jobs.metadata (builder_claim_ref, builder_po_number, builder_work_order_number, external_ref), upper case, at least 5 characters, distinct, byte order. The reader turns each into canonical tokens with _shared/makesafe_refs.ts builderRefTokens, the same function it reads an email with.';

-- 5. A source's live floor: the start of the reader's own live reading, read
-- whole since: its first poll window (the poll walks on from its cursor), or
-- earlier where a succeeded nightly sweep (a whole 48 hours) that ran after
-- that poll window began reaches further back; raised to the next whole second
-- so it never claims a moment the reader did not read. A sweep that ended
-- before the poll began leaves a gap, so it never counts.
CREATE OR REPLACE FUNCTION public.context_email_deep_live_floor(p_source_key text) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $fn$
 WITH poll AS (
  SELECT min(c.window_from) AS f FROM public.context_capture_runs c
  WHERE c.source='outlook_'||p_source_key AND c.status IN ('succeeded','partial')
 ), sweep AS (
  SELECT min(c.window_from) AS f FROM public.context_capture_runs c, poll
  WHERE c.source='outlook_sweep_'||p_source_key AND c.status='succeeded' AND poll.f IS NOT NULL AND c.started_at>=poll.f
 )
 SELECT CASE WHEN x.t IS NULL THEN NULL WHEN x.t=date_trunc('second',x.t) THEN x.t ELSE date_trunc('second',x.t)+interval '1 second' END
 FROM (SELECT least(poll.f,sweep.f) AS t FROM poll, sweep) x
$fn$;
COMMENT ON FUNCTION public.context_email_deep_live_floor(text) IS
 'History depth (20261007080000): the start of one source''s live reading, read whole since: the earliest window_from of its outlook_<key> poll runs that succeeded or were cut, or of a succeeded outlook_sweep_<key> run that started after that (a sweep that ended before the poll began leaves a gap and never counts), rounded up to the whole second; null when the source was never polled. Everything after it is read live, whatever job it touches.';

-- 6. The live jobs, monitored or not, their first record and their keys.
CREATE OR REPLACE FUNCTION public.context_email_deep_scope_jobs(p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, job_number text, status text, job_type text, monitored boolean, lead_rule text,
 job_started timestamptz, lead_in_from timestamptz, job_number_key text, client_email_key text, builder_refs text[], keys_md5 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE pol jsonb:=public.context_email_deep_policy(); t timestamptz:=coalesce(p_as_of,now());
 excl text[]:=ARRAY(SELECT jsonb_array_elements_text(pol->'live_excluded_statuses'));
 pre text[]:=ARRAY(SELECT jsonb_array_elements_text(pol->'lead_not_progressed_statuses'));
 quiet interval:=make_interval(days=>(pol->>'lead_quiet_days')::integer);
 lead_in interval:=make_interval(days=>(pol->>'lead_in_days')::integer);
 v_rule text:='deep_fallback'; v_off uuid[]:='{}';
BEGIN
 -- The lead-rule slice (20261007010000) owns the rule once it is on this
 -- database: its set function context_lead_monitored_jobs(job ids, as_of)
 -- (one row per live job when the ids are null: job_id, monitored, ...), read
 -- once; else, with only its boolean context_lead_monitored(job, as_of), job
 -- by job. Should the one that is there not answer in that shape, the owner's
 -- rule below applies and lead_rule says so (deep_fallback_lead_rule_unreadable),
 -- so the load and the scorecard's reads keep answering and the mismatch is
 -- in plain sight.
 IF to_regprocedure('public.context_lead_monitored_jobs(uuid[],timestamp with time zone)') IS NOT NULL THEN
  BEGIN
   EXECUTE 'SELECT coalesce(array_agg(m.job_id),''{}''::uuid[])
     FROM public.context_lead_monitored_jobs(NULL::uuid[],$1) m WHERE m.monitored IS FALSE'
   INTO v_off USING t;
   v_rule:='context_lead_monitored';
  EXCEPTION WHEN OTHERS THEN
   v_rule:='deep_fallback_lead_rule_unreadable'; v_off:='{}';
  END;
 ELSIF to_regprocedure('public.context_lead_monitored(uuid,timestamp with time zone)') IS NOT NULL THEN
  BEGIN
   EXECUTE 'SELECT coalesce(array_agg(jb.id),''{}''::uuid[]) FROM public.jobs jb
     WHERE jb.status::text <> ALL ($2) AND public.context_lead_monitored(jb.id,$1) IS FALSE'
   INTO v_off USING t, excl;
   v_rule:='context_lead_monitored';
  EXCEPTION WHEN OTHERS THEN
   v_rule:='deep_fallback_lead_rule_unreadable'; v_off:='{}';
  END;
 END IF;
 RETURN QUERY
 WITH live AS (
  SELECT jb.id, jb.job_number AS jn_raw, jb.status::text AS st, jb.type::text AS ty, jb.created_at, jb.client_email, jb.metadata,
   jb.quoted_at, jb.accepted_at, jb.deposit_at, jb.approvals_at, jb.processing_at, jb.scheduled_at, jb.completed_at
  FROM public.jobs jb WHERE jb.status::text <> ALL (excl)
 ), lead AS (
  -- The owner's rule (7 Oct 2026), while the lead-rule slice is absent: a
  -- lead (nothing moved it past quoted by the instant) stops being monitored
  -- 28 days after the newer of its newest quote send and the customer's
  -- newest inbound message; a quote never sent starts no clock.
  SELECT l.id,
   greatest(CASE WHEN l.quoted_at<=t THEN l.quoted_at END,
    (SELECT max(d.sent_at) FROM public.job_documents d WHERE d.job_id=l.id AND d.type ILIKE '%quote%' AND d.sent_at<=t),
    (SELECT max(je.created_at) FROM public.job_events je WHERE je.job_id=l.id AND je.event_type='quote_sent' AND je.created_at<=t)) AS last_sent,
   (SELECT max(coalesce(e.event_at,e.occurred_at)) FROM public.business_events e
    WHERE e.job_id=l.id AND e.direction='inbound' AND coalesce(e.event_type,'') NOT LIKE 'supplier.%'
     AND coalesce(e.event_at,e.occurred_at)<=t) AS last_in,
   coalesce(least(l.accepted_at,l.deposit_at,l.approvals_at,l.processing_at,l.scheduled_at,l.completed_at,
     (SELECT min(d.accepted_at) FROM public.job_documents d WHERE d.job_id=l.id AND d.type ILIKE '%quote%'),
     (SELECT min(coalesce((xi.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'),xi.created_at)) FROM public.xero_invoices xi
      WHERE xi.job_id=l.id AND upper(coalesce(xi.invoice_type,'ACCREC'))='ACCREC' AND upper(coalesce(xi.status,'')) IN ('AUTHORISED','SUBMITTED','PAID')),
     (SELECT min(a.created_at) FROM public.job_assignments a WHERE a.job_id=l.id AND a.scheduled_date IS NOT NULL
      AND lower(coalesce(a.status,'')) NOT IN ('cancelled','deleted','draft','disputed','declined')
      AND NOT (coalesce(a.is_ghost,false) OR coalesce(a.role,'')='observer')),
     (SELECT min(je.created_at) FROM public.job_events je WHERE je.job_id=l.id AND je.event_type IN ('status_changed','status_change')
      AND coalesce(je.detail_json->>'new_status',je.detail_json->>'to',je.detail_json->>'status') <> ALL (pre))),
    CASE WHEN l.st <> ALL (pre) THEN '-infinity'::timestamptz END) AS progressed
  FROM live l WHERE v_rule<>'context_lead_monitored'
 ), x AS (
  SELECT l.id, l.jn_raw, l.st, l.ty,
   CASE WHEN v_rule='context_lead_monitored' THEN NOT (l.id=ANY(v_off))
    ELSE NOT (NOT coalesce(ld.progressed<=t,false) AND ld.last_sent IS NOT NULL AND t>=greatest(ld.last_sent,ld.last_in)+quiet) END AS mon,
   least(l.created_at,
    (SELECT min(coalesce(e.event_at,e.occurred_at)) FROM public.business_events e
     WHERE e.job_id=l.id AND coalesce(e.metadata->>'history_tier','')<>'deep'),
    (SELECT min(d.created_at) FROM public.job_documents d WHERE d.job_id=l.id),
    (SELECT min(xi.invoice_date::timestamp AT TIME ZONE 'Australia/Perth') FROM public.xero_invoices xi WHERE xi.job_id=l.id)) AS started,
   nullif(upper(btrim(l.jn_raw)),'') AS jn,
   CASE WHEN l.client_email LIKE '%@%' THEN lower(btrim(l.client_email)) END AS em,
   public.context_email_deep_job_refs(l.metadata) AS refs
  FROM live l LEFT JOIN lead ld ON ld.id=l.id
 )
 SELECT x.id, x.jn_raw, x.st, x.ty, x.mon, v_rule, x.started, x.started-lead_in, x.jn, x.em, x.refs,
  md5(coalesce(x.jn,'')||'|'||coalesce(x.em,'')||'|'||array_to_string(x.refs,','))
 FROM x;
END $fn$;
COMMENT ON FUNCTION public.context_email_deep_scope_jobs(timestamp with time zone) IS
 'History depth (20261007080000): one row per live job (status not in context_email_deep_policy().live_excluded_statuses): monitored, lead_rule (context_lead_monitored when the lead-rule slice, 20261007010000, is on the database and answers: its set function context_lead_monitored_jobs(NULL, as_of) read once, else its boolean context_lead_monitored(job, as_of) job by job; else deep_fallback, or deep_fallback_lead_rule_unreadable when one of them exists but does not answer in its shape: the owner''s 7 Oct 2026 rule, a lead with no progress stops being monitored 28 days after the newer of its newest quote send and the customer''s newest inbound message), job_started (the earliest of its created time, any business_events row placed on it except a deep row, its first document and its first invoice date), lead_in_from (30 days earlier), and its keys: job number (upper case), client email (lower case), builder references (context_email_deep_job_refs) and their md5. Service role only.';

-- 7. The load's own tables. Written only by the tick; service role reads.
CREATE TABLE IF NOT EXISTS public.context_email_deep_members (
 job_id uuid PRIMARY KEY,
 entered_at timestamptz NOT NULL,
 lead_in_from timestamptz NOT NULL,
 keys_md5 text NOT NULL,
 left_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.context_email_deep_members IS
 'History depth (20261007080000): the monitored live jobs the deep email load reads for: since when each is a member (entered_at; a job whose keys change or whose start moves earlier joins again), its lead-in and the md5 of its keys as the tick last read them, and when it left. A slice credits only jobs that were members when it was first posted. Written only by trigger_context_email_deep_history(). No anon or authenticated access.';

CREATE TABLE IF NOT EXISTS public.context_email_deep_plan (
 source_key text PRIMARY KEY CHECK (source_key ~ '^[a-z][a-z0-9_]{1,40}$'),
 kind text NOT NULL CHECK (kind IN ('user','group')),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('waiting_live','waiting_near','pending','loading','stalled','succeeded','gave_up')),
 live_floor timestamptz,
 covered_from timestamptz,
 target_floor timestamptz,
 slice_from timestamptz,
 slice_to timestamptz,
 slice_kind text CHECK (slice_kind IN ('deep','catchup')),
 slice_posted_at timestamptz,
 posts integer NOT NULL DEFAULT 0 CHECK (posts>=0),
 posts_since_progress integer NOT NULL DEFAULT 0 CHECK (posts_since_progress>=0),
 slices_done integer NOT NULL DEFAULT 0 CHECK (slices_done>=0),
 needing_jobs integer NOT NULL DEFAULT 0 CHECK (needing_jobs>=0),
 last_posted_at timestamptz,
 last_run_id uuid,
 last_run_status text,
 last_progress_at timestamptz,
 stalled_at timestamptz,
 stall_reason text,
 stalls integer NOT NULL DEFAULT 0 CHECK (stalls>=0),
 walk_day date,
 succeeded_at timestamptz,
 gave_up_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_email_deep_plan_slice CHECK ((slice_from IS NULL)=(slice_to IS NULL) AND (slice_from IS NULL OR slice_from<slice_to)),
 CONSTRAINT context_email_deep_plan_stalled CHECK (state<>'stalled' OR stalled_at IS NOT NULL),
 CONSTRAINT context_email_deep_plan_open CHECK (state NOT IN ('loading','stalled') OR slice_from IS NOT NULL)
);
COMMENT ON TABLE public.context_email_deep_plan IS
 'History depth (20261007080000): the deep email load, one row per selected source: its live floor (the reader''s own first live window, fixed once), how far back its walk has reached (covered_from), the target (the start of the oldest monitored live job), the open slice, the W7 progress counters, and waiting_live / waiting_near / pending / loading / stalled / succeeded / gave_up. Written only by trigger_context_email_deep_history(). No anon or authenticated access.';

CREATE TABLE IF NOT EXISTS public.context_email_deep_reach (
 source_key text NOT NULL REFERENCES public.context_email_deep_plan(source_key) ON DELETE CASCADE,
 job_id uuid NOT NULL,
 reaches timestamptz NOT NULL,
 run_id uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (source_key, job_id)
);
CREATE INDEX IF NOT EXISTS context_email_deep_reach_job ON public.context_email_deep_reach(job_id);
COMMENT ON TABLE public.context_email_deep_reach IS
 'History depth (20261007080000): how far back one mailbox''s mail is complete for one job (reaches: every email of that mailbox received at or after it that touches the job''s keys has been read), and the run that moved it. A job with no row reaches the mailbox''s live floor. Written only by trigger_context_email_deep_history(). No anon or authenticated access.';

ALTER TABLE public.context_email_deep_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_email_deep_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_email_deep_reach ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_email_deep_members,public.context_email_deep_plan,public.context_email_deep_reach FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.context_email_deep_members,public.context_email_deep_plan,public.context_email_deep_reach FROM service_role;
GRANT SELECT ON TABLE public.context_email_deep_members,public.context_email_deep_plan,public.context_email_deep_reach TO service_role;
DROP POLICY IF EXISTS service_role_read ON public.context_email_deep_members;
CREATE POLICY service_role_read ON public.context_email_deep_members FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS service_role_read ON public.context_email_deep_plan;
CREATE POLICY service_role_read ON public.context_email_deep_plan FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS service_role_read ON public.context_email_deep_reach;
CREATE POLICY service_role_read ON public.context_email_deep_reach FOR SELECT TO service_role USING (true);

-- 8. What the reader keeps: the members' keys, each with the earliest lead-in
-- of the members carrying it (ISO, milliseconds, UTC).
CREATE OR REPLACE FUNCTION public.context_email_deep_scope() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH m AS (
  SELECT mm.job_id, mm.lead_in_from, nullif(upper(btrim(j.job_number)),'') AS jn,
   CASE WHEN j.client_email LIKE '%@%' THEN lower(btrim(j.client_email)) END AS em,
   public.context_email_deep_job_refs(j.metadata) AS refs
  FROM public.context_email_deep_members mm JOIN public.jobs j ON j.id=mm.job_id
  WHERE mm.left_at IS NULL
 ), k AS (
  SELECT 'job_numbers' AS kind, m.jn AS key, m.lead_in_from FROM m WHERE m.jn IS NOT NULL
  UNION ALL SELECT 'client_emails', m.em, m.lead_in_from FROM m WHERE m.em IS NOT NULL
  UNION ALL SELECT 'builder_refs', r.ref, m.lead_in_from FROM m CROSS JOIN unnest(m.refs) AS r(ref)
 ), g AS (
  SELECT k.kind, k.key, to_char(min(k.lead_in_from) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS f
  FROM k GROUP BY k.kind, k.key
 )
 SELECT jsonb_build_object('version',public.context_email_deep_policy()->>'version',
  'as_of',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'jobs',(SELECT count(*) FROM m),
  'job_numbers',coalesce((SELECT jsonb_object_agg(g.key,g.f) FROM g WHERE g.kind='job_numbers'),'{}'::jsonb),
  'client_emails',coalesce((SELECT jsonb_object_agg(g.key,g.f) FROM g WHERE g.kind='client_emails'),'{}'::jsonb),
  'builder_refs',coalesce((SELECT jsonb_object_agg(g.key,g.f) FROM g WHERE g.kind='builder_refs'),'{}'::jsonb))
$fn$;
COMMENT ON FUNCTION public.context_email_deep_scope() IS
 'History depth (20261007080000): what the email reader''s deep mode keeps: for the current members of context_email_deep_members, each job number (upper case), client email (lower case) and stored builder reference (upper case), with the earliest lead_in_from of the members carrying it. Mail touching a key but received before its time is skipped (skipped_before_job). Service role.';

-- 9. One tick of the deep load.
CREATE OR REPLACE FUNCTION public.trigger_context_email_deep_history() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 pol jsonb:=public.context_email_deep_policy(); f jsonb:=public.context_email_reader_flags();
 v_now timestamptz:=now(); v_today date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 v_hard timestamptz:=(pol->>'hard_floor')::timestamptz;
 v_slice interval:=make_interval(days=>(pol->>'user_slice_days')::integer);
 v_calls integer:=(pol->>'calls_per_tick')::integer;
 v_stall_after integer:=(pol->>'stall_after_calls')::integer;
 v_rest interval:=make_interval(hours=>(pol->>'stall_rest_hours')::integer);
 v_fresh interval:=make_interval(mins=>(pol->>'running_fresh_minutes')::integer);
 v_deep boolean; v_rule text; v_ids uuid[]; v_leads timestamptz[]; v_md5s text[]; v_members integer; v_target timestamptz;
 p record; q record; r record; nd record; v_got boolean; v_moved boolean; n integer;
 v_from timestamptz; v_to timestamptz; v_floor timestamptz; v_posted integer:=0; v_calls_out jsonb:='[]'::jsonb;
BEGIN
 IF NOT (coalesce((f->>'reader')::boolean,false) AND coalesce((f->>'schedule')::boolean,false) AND coalesce((f->>'program')::boolean,false)) THEN
  RETURN jsonb_build_object('outcome','idle','reason','reader_flags_off');
 END IF;
 SELECT coalesce(bool_or(ff.enabled),false) INTO v_deep FROM public.feature_flags ff WHERE ff.flag_name='email_reader_deep_v1';
 IF NOT v_deep THEN RETURN jsonb_build_object('outcome','idle','reason','email_reader_deep_v1_off'); END IF;
 IF NOT public.automation_lane_enabled('capture') THEN RETURN jsonb_build_object('outcome','idle','reason','capture_lane_off'); END IF;
 IF NOT pg_try_advisory_xact_lock(20261005,16) THEN RETURN jsonb_build_object('outcome','busy'); END IF;

 -- 1. The members: the monitored live jobs as they stand now.
 SELECT coalesce(array_agg(s.job_id ORDER BY s.job_id),'{}'), coalesce(array_agg(s.lead_in_from ORDER BY s.job_id),'{}'),
  coalesce(array_agg(s.keys_md5 ORDER BY s.job_id),'{}'), max(s.lead_rule)
 INTO v_ids, v_leads, v_md5s, v_rule
 FROM public.context_email_deep_scope_jobs(v_now) s WHERE s.monitored AND s.lead_in_from IS NOT NULL;
 -- A job whose keys changed: what was read for it was read for other keys.
 DELETE FROM public.context_email_deep_reach x USING public.context_email_deep_members m, unnest(v_ids,v_md5s) AS s(job_id,keys_md5)
 WHERE x.job_id=m.job_id AND m.job_id=s.job_id AND m.keys_md5<>s.keys_md5;
 -- A job whose start moved earlier: nothing older than its old start was kept for it.
 UPDATE public.context_email_deep_reach x SET reaches=m.lead_in_from, updated_at=v_now
 FROM public.context_email_deep_members m, unnest(v_ids,v_leads,v_md5s) AS s(job_id,lead_in_from,keys_md5)
 WHERE x.job_id=m.job_id AND m.job_id=s.job_id AND m.keys_md5=s.keys_md5 AND s.lead_in_from<m.lead_in_from AND x.reaches<m.lead_in_from;
 UPDATE public.context_email_deep_members m SET left_at=v_now, updated_at=v_now WHERE m.left_at IS NULL AND m.job_id <> ALL (v_ids);
 INSERT INTO public.context_email_deep_members AS m (job_id,entered_at,lead_in_from,keys_md5,left_at,updated_at)
 SELECT s.job_id, v_now, s.lead_in_from, s.keys_md5, NULL, v_now FROM unnest(v_ids,v_leads,v_md5s) AS s(job_id,lead_in_from,keys_md5)
 ON CONFLICT (job_id) DO UPDATE SET
  entered_at=CASE WHEN m.left_at IS NOT NULL OR m.keys_md5<>excluded.keys_md5 OR excluded.lead_in_from<m.lead_in_from THEN v_now ELSE m.entered_at END,
  lead_in_from=excluded.lead_in_from, keys_md5=excluded.keys_md5, left_at=NULL, updated_at=v_now
 WHERE m.left_at IS NOT NULL OR m.keys_md5<>excluded.keys_md5 OR m.lead_in_from<>excluded.lead_in_from;
 SELECT count(*), greatest(v_hard,date_trunc('second',min(m.lead_in_from)))
 INTO v_members, v_target FROM public.context_email_deep_members m WHERE m.left_at IS NULL;

 -- 2. Every selected source has a plan row; its live floor is fixed once.
 INSERT INTO public.context_email_deep_plan(source_key,kind,state)
 SELECT mb.source_key, mb.kind, 'pending' FROM public.monitored_mailboxes mb
 WHERE mb.enabled AND mb.status='active' AND mb.kind IN ('user','group') AND mb.source_key ~ '^[a-z][a-z0-9_]{1,40}$'
 ON CONFLICT (source_key) DO NOTHING;
 UPDATE public.context_email_deep_plan pl SET live_floor=lf.t, covered_from=coalesce(pl.covered_from,lf.t), updated_at=v_now
 FROM (SELECT x.source_key, public.context_email_deep_live_floor(x.source_key) AS t FROM public.context_email_deep_plan x WHERE x.live_floor IS NULL) lf
 WHERE pl.source_key=lf.source_key AND lf.t IS NOT NULL;
 UPDATE public.context_email_deep_plan pl SET target_floor=v_target, updated_at=v_now WHERE pl.target_floor IS DISTINCT FROM v_target;

 -- 3. Each source: judge its open slice's newest finished run once, then plan.
 FOR q IN SELECT x.source_key FROM public.context_email_deep_plan x ORDER BY (x.kind<>'group'), x.source_key COLLATE "C" LOOP
  SELECT * INTO p FROM public.context_email_deep_plan x WHERE x.source_key=q.source_key;
  IF NOT EXISTS(SELECT 1 FROM public.monitored_mailboxes mb WHERE mb.source_key=p.source_key
    AND mb.enabled AND mb.status='active' AND mb.kind IN ('user','group')) THEN
   IF p.state<>'gave_up' THEN
    UPDATE public.context_email_deep_plan SET state='gave_up', gave_up_reason='source_not_selected', slice_from=NULL, slice_to=NULL,
     slice_kind=NULL, slice_posted_at=NULL, updated_at=v_now WHERE source_key=p.source_key;
   END IF;
   CONTINUE;
  END IF;
  IF p.state='gave_up' THEN
   UPDATE public.context_email_deep_plan SET state='pending', gave_up_reason=NULL, updated_at=v_now WHERE source_key=p.source_key;
  END IF;
  IF p.live_floor IS NULL THEN
   UPDATE public.context_email_deep_plan SET state='waiting_live', updated_at=v_now WHERE source_key=p.source_key AND state<>'waiting_live';
   CONTINUE;
  END IF;

  IF p.state IN ('loading','stalled') THEN
   -- Only a run of this posting of the slice: it carries the slice's id (the
   -- time the slice was first posted) and started after that. A run of the
   -- same window from an earlier walk, or from a call nobody planned, never
   -- counts for it.
   SELECT c.id, c.status, c.counts, c.error_code INTO r FROM public.context_capture_runs c
   WHERE c.source='outlook_deep_history_'||p.source_key AND c.status<>'running'
    AND c.started_at>=p.slice_posted_at
    AND c.cursor->>'deep_slice'=to_char(p.slice_posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND c.cursor->>'history_from'=to_char(p.slice_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND c.cursor->>'history_to'=to_char(p.slice_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   ORDER BY c.started_at DESC LIMIT 1;
   v_got:=FOUND;
   IF v_got AND r.id IS DISTINCT FROM p.last_run_id THEN
    v_moved:=r.status='succeeded' OR coalesce(CASE WHEN jsonb_typeof(r.counts->'progressed')='number' THEN (r.counts->>'progressed')::numeric END,0)>0;
    UPDATE public.context_email_deep_plan SET last_run_id=r.id, last_run_status=r.status, updated_at=v_now,
     posts_since_progress=CASE WHEN v_moved THEN 0 ELSE posts_since_progress END,
     last_progress_at=CASE WHEN v_moved THEN v_now ELSE last_progress_at END
    WHERE source_key=p.source_key;
    IF r.status='succeeded' THEN
     -- The slice is read: every job that was a member when it was first posted
     -- and whose reach the slice joins now reaches the slice's start.
     INSERT INTO public.context_email_deep_reach AS x (source_key,job_id,reaches,run_id,updated_at)
     SELECT p.source_key, m.job_id, p.slice_from, r.id, v_now
     FROM public.context_email_deep_members m
     LEFT JOIN public.context_email_deep_reach cur ON cur.source_key=p.source_key AND cur.job_id=m.job_id
     WHERE m.left_at IS NULL AND m.entered_at<=p.slice_posted_at
      AND coalesce(cur.reaches,p.live_floor)<=p.slice_to AND coalesce(cur.reaches,p.live_floor)>p.slice_from
     ON CONFLICT (source_key,job_id) DO UPDATE SET reaches=excluded.reaches, run_id=excluded.run_id, updated_at=excluded.updated_at
     WHERE x.reaches>excluded.reaches;
     UPDATE public.context_email_deep_plan SET slices_done=slices_done+1,
      covered_from=CASE WHEN p.slice_to>=coalesce(p.covered_from,p.live_floor) THEN least(coalesce(p.covered_from,p.live_floor),p.slice_from)
       ELSE coalesce(p.covered_from,p.live_floor) END,
      slice_from=NULL, slice_to=NULL, slice_kind=NULL, slice_posted_at=NULL, state='pending',
      posts_since_progress=0, stalled_at=NULL, stall_reason=NULL, updated_at=v_now
     WHERE source_key=p.source_key;
    END IF;
   END IF;
   -- Three calls and the reader never moved: set aside, loudly.
   UPDATE public.context_email_deep_plan SET state='stalled', stalled_at=v_now, stalls=stalls+1, updated_at=v_now,
    stall_reason=CASE WHEN NOT v_got THEN 'no_run' ELSE coalesce(r.error_code,'no_progress') END
   WHERE source_key=p.source_key AND state='loading' AND posts_since_progress>=v_stall_after;
   GET DIAGNOSTICS n = ROW_COUNT;
   IF n>0 THEN RAISE WARNING 'email_deep_stalled: source % made no progress in % calls',p.source_key,v_stall_after; END IF;
  END IF;

  SELECT * INTO p FROM public.context_email_deep_plan x WHERE x.source_key=q.source_key;
  -- The 60-day load of the same mailbox is unfinished or running: wait, so the
  -- two loads never read one mailbox at once.
  IF EXISTS(SELECT 1 FROM public.context_email_history_plan h WHERE h.source_key=p.source_key AND h.state IN ('pending','loading','stalled'))
   OR EXISTS(SELECT 1 FROM public.context_capture_runs c WHERE c.source='outlook_history_'||p.source_key AND c.status='running'
    AND c.updated_at>v_now-v_fresh) THEN
   -- A call already made keeps its state (its run is judged next time); only
   -- work not yet called waits.
   IF p.state IN ('pending','waiting_live') THEN
    UPDATE public.context_email_deep_plan SET state='waiting_near', updated_at=v_now WHERE source_key=p.source_key;
   END IF;
   CONTINUE;
  END IF;
  IF p.state IN ('waiting_near','waiting_live') THEN
   UPDATE public.context_email_deep_plan SET state=CASE WHEN slice_posted_at IS NULL THEN 'pending' ELSE 'loading' END, updated_at=v_now
   WHERE source_key=p.source_key;
   SELECT * INTO p FROM public.context_email_deep_plan x WHERE x.source_key=q.source_key;
  END IF;

  -- No slice open: plan the next one from the highest gap.
  IF p.slice_from IS NULL THEN
   SELECT count(*) AS n, max(coalesce(x.reaches,p.live_floor)) AS s_to, min(greatest(m.lead_in_from,v_hard)) AS need
   INTO nd FROM public.context_email_deep_members m
   LEFT JOIN public.context_email_deep_reach x ON x.source_key=p.source_key AND x.job_id=m.job_id
   WHERE m.left_at IS NULL AND coalesce(x.reaches,p.live_floor)>greatest(m.lead_in_from,v_hard);
   IF nd.n=0 THEN
    UPDATE public.context_email_deep_plan SET needing_jobs=0, updated_at=v_now,
     succeeded_at=CASE WHEN state<>'succeeded' THEN v_now ELSE succeeded_at END, state='succeeded'
    WHERE source_key=p.source_key AND (state<>'succeeded' OR needing_jobs<>0);
    CONTINUE;
   END IF;
   -- A finished source starts a new walk at most once a Perth day: the jobs
   -- that joined since are caught up together.
   IF p.state='succeeded' AND p.walk_day IS NOT NULL AND p.walk_day>=v_today THEN
    UPDATE public.context_email_deep_plan SET needing_jobs=nd.n, updated_at=v_now WHERE source_key=p.source_key AND needing_jobs<>nd.n;
    CONTINUE;
   END IF;
   v_to:=nd.s_to;
   IF p.kind='group' THEN
    -- A group is walked in one window, down to the oldest start still short.
    v_from:=date_trunc('second',nd.need);
   ELSE
    -- A user slice is at most 31 days, and reaches only as low as the jobs it
    -- credits (those whose reach it joins) need.
    SELECT min(greatest(m.lead_in_from,v_hard)) INTO v_floor FROM public.context_email_deep_members m
    LEFT JOIN public.context_email_deep_reach x ON x.source_key=p.source_key AND x.job_id=m.job_id
    WHERE m.left_at IS NULL AND coalesce(x.reaches,p.live_floor)>greatest(m.lead_in_from,v_hard)
     AND coalesce(x.reaches,p.live_floor)>v_to-v_slice;
    v_from:=greatest(date_trunc('second',v_floor),v_to-v_slice);
   END IF;
   UPDATE public.context_email_deep_plan SET slice_from=v_from, slice_to=v_to,
    slice_kind=CASE WHEN v_to<=coalesce(p.covered_from,p.live_floor) THEN 'deep' ELSE 'catchup' END,
    slice_posted_at=NULL, posts_since_progress=0, state='pending', needing_jobs=nd.n,
    walk_day=CASE WHEN p.state='succeeded' OR p.walk_day IS NULL THEN v_today ELSE p.walk_day END,
    updated_at=v_now
   WHERE source_key=p.source_key;
  END IF;
 END LOOP;

 -- 4. Post up to calls_per_tick calls to different sources: groups first (a
 -- group's floor moves only when its whole walk ends), then user mailboxes; a
 -- stalled source after its rest, behind every other.
 FOR p IN SELECT * FROM public.context_email_deep_plan x
  WHERE x.slice_from IS NOT NULL AND (x.state IN ('pending','loading') OR (x.state='stalled' AND x.stalled_at<=v_now-v_rest))
  ORDER BY (x.state='stalled'), (x.kind<>'group'), x.source_key COLLATE "C" LOOP
  EXIT WHEN v_posted>=v_calls;
  IF EXISTS(SELECT 1 FROM public.context_capture_runs c WHERE c.source='outlook_deep_history_'||p.source_key AND c.status='running'
    AND c.updated_at>v_now-v_fresh) THEN
   v_calls_out:=v_calls_out||jsonb_build_array(jsonb_build_object('source',p.source_key,'outcome','waiting'));
   CONTINUE;
  END IF;
  IF EXISTS(SELECT 1 FROM public.context_email_history_plan h WHERE h.source_key=p.source_key AND h.state IN ('pending','loading','stalled'))
   OR EXISTS(SELECT 1 FROM public.context_capture_runs c WHERE c.source='outlook_history_'||p.source_key AND c.status='running'
    AND c.updated_at>v_now-v_fresh) THEN
   v_calls_out:=v_calls_out||jsonb_build_array(jsonb_build_object('source',p.source_key,'outcome','waiting_near'));
   CONTINUE;
  END IF;
  -- The call names its slice: the time it was first posted (this tick's, on
  -- its first call), which the reader keeps on the run's cursor.
  PERFORM net.http_post(
   url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
   body := jsonb_build_object('mode','deep','source',p.source_key,
    'from',to_char(p.slice_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'to',to_char(p.slice_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'slice',to_char(coalesce(p.slice_posted_at,v_now) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actor','cron:outlook-mail-deep-history'),
   headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
   timeout_milliseconds := 5000
  );
  UPDATE public.context_email_deep_plan SET state='loading', posts=posts+1, last_posted_at=v_now,
   slice_posted_at=coalesce(slice_posted_at,v_now),
   posts_since_progress=CASE WHEN p.state='stalled' THEN 1 ELSE posts_since_progress+1 END, updated_at=v_now
  WHERE source_key=p.source_key;
  v_posted:=v_posted+1;
  v_calls_out:=v_calls_out||jsonb_build_array(jsonb_build_object('source',p.source_key,'outcome','posted',
   'from',p.slice_from,'to',p.slice_to,'kind',p.slice_kind,'retry',p.state='stalled'));
 END LOOP;

 RETURN jsonb_build_object(
  'outcome',CASE WHEN v_posted>0 THEN 'posted'
   WHEN EXISTS(SELECT 1 FROM public.context_email_deep_plan x WHERE x.state NOT IN ('succeeded','gave_up')) THEN 'waiting'
   ELSE 'finished' END,
  'posted',v_posted,'calls',v_calls_out,'members',v_members,'lead_rule',coalesce(v_rule,'deep_fallback'),'target_floor',v_target,
  'stalled',(SELECT count(*) FROM public.context_email_deep_plan x WHERE x.state='stalled'));
END $fn$;
COMMENT ON FUNCTION public.trigger_context_email_deep_history() IS
 'History depth (20261007080000): one tick of the deep email load, run by pg_cron outlook-mail-deep-history every 5 minutes behind the capture lane while email_reader_v1, email_reader_schedule_v1, email_capture_v2 and email_reader_deep_v1 are on. Keeps context_email_deep_members (the monitored live jobs); gives each selected source a plan row with its live floor; judges each open slice''s newest finished outlook_deep_history_<key> run of that posting once (its cursor carries the slice''s id, the time the slice was first posted, which each call sends as slice, and it started after that; a run of the same window from another posting never counts) (moved: succeeded or counts.progressed > 0); on a succeeded run moves the reach of every job that was a member when the slice was first posted and whose reach the slice joins; plans the next slice from the highest gap (user mailbox 31 days, group one window, never below the oldest monitored job''s start); a finished source starts a new walk at most once a Perth day; 3 calls without a move stall a source (WARNING email_deep_stalled), tried again 6 hours later; waits while the source''s own run or its 60-day load runs; posts at most 2 {mode: deep} calls a tick, groups first. Lists nothing for the old fact reader.';

-- 10. The load as one read for the desk.
CREATE OR REPLACE FUNCTION public.context_email_deep_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT jsonb_build_object(
  'flag',coalesce((SELECT bool_or(ff.enabled) FROM public.feature_flags ff WHERE ff.flag_name='email_reader_deep_v1'),false),
  'lead_rule',(SELECT max(sj.lead_rule) FROM public.context_email_deep_scope_jobs(now()) sj),
  'policy',public.context_email_deep_policy(),
  'members',(SELECT count(*) FROM public.context_email_deep_members m WHERE m.left_at IS NULL),
  'target_floor',(SELECT max(x.target_floor) FROM public.context_email_deep_plan x),
  'sources',(SELECT count(*) FROM public.context_email_deep_plan),
  'by_state',coalesce((SELECT jsonb_object_agg(s.state,s.n) FROM (SELECT x.state, count(*) AS n FROM public.context_email_deep_plan x GROUP BY x.state) s),'{}'::jsonb),
  'finished',EXISTS(SELECT 1 FROM public.context_email_deep_plan)
   AND NOT EXISTS(SELECT 1 FROM public.context_email_deep_plan x WHERE x.state NOT IN ('succeeded','gave_up') OR x.needing_jobs>0),
  'attention',coalesce((SELECT jsonb_agg(jsonb_build_object('source_key',x.source_key,'state',x.state,
    'reason',CASE WHEN x.state='stalled' THEN x.stall_reason ELSE x.gave_up_reason END,
    'since',CASE WHEN x.state='stalled' THEN x.stalled_at ELSE x.updated_at END,'last_progress_at',x.last_progress_at,
    'posts',x.posts,'stalls',x.stalls) ORDER BY x.source_key COLLATE "C")
   FROM public.context_email_deep_plan x WHERE x.state IN ('stalled','gave_up')),'[]'::jsonb),
  'plan',coalesce((SELECT jsonb_agg(jsonb_build_object('source_key',x.source_key,'kind',x.kind,'state',x.state,
    'live_floor',x.live_floor,'covered_from',x.covered_from,'target_floor',x.target_floor,
    'slice_from',x.slice_from,'slice_to',x.slice_to,'slice_kind',x.slice_kind,'slices_done',x.slices_done,'needing_jobs',x.needing_jobs,
    'posts',x.posts,'posts_since_progress',x.posts_since_progress,'last_run_status',x.last_run_status,'last_posted_at',x.last_posted_at,
    'last_progress_at',x.last_progress_at,'stalled_at',x.stalled_at,'stall_reason',x.stall_reason,'stalls',x.stalls,
    'walk_day',x.walk_day,'succeeded_at',x.succeeded_at,'gave_up_reason',x.gave_up_reason) ORDER BY x.source_key COLLATE "C")
   FROM public.context_email_deep_plan x),'[]'::jsonb))
$fn$;
COMMENT ON FUNCTION public.context_email_deep_status() IS
 'History depth (20261007080000): the deep email load as one read: flag, lead rule in use, policy, members, target floor, count by state, finished (every source succeeded or given up and no job short in any), attention (every stalled or gave_up source with its reason and since when) and the plan rows (codes, times and counts only). Service role.';

-- 11. The scorecard's read: each live job's email history reach.
CREATE OR REPLACE FUNCTION public.context_email_history_reach_jobs(p_job_ids uuid[] DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, job_number text, monitored boolean, lead_rule text, job_started timestamptz, lead_in_from timestamptz,
 reaches timestamptz, status text, reason text, sources jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH pol AS (SELECT (public.context_email_deep_policy()->>'hard_floor')::timestamptz AS hard),
 flag AS (SELECT coalesce(bool_or(ff.enabled),false) AS on_ FROM public.feature_flags ff WHERE ff.flag_name='email_reader_deep_v1'),
 src AS (
  SELECT mb.source_key, pl.state, coalesce(pl.live_floor,public.context_email_deep_live_floor(mb.source_key)) AS live_floor
  FROM public.monitored_mailboxes mb LEFT JOIN public.context_email_deep_plan pl ON pl.source_key=mb.source_key
  WHERE mb.enabled AND mb.status='active' AND mb.kind IN ('user','group')
 ),
 s AS (SELECT * FROM public.context_email_deep_scope_jobs(p_as_of) sj WHERE p_job_ids IS NULL OR sj.job_id=ANY(p_job_ids)),
 per AS (
  SELECT s.job_id, src.source_key, coalesce(src.state,'not_planned') AS state,
   CASE WHEN src.live_floor IS NULL THEN NULL ELSE coalesce(x.reaches,src.live_floor) END AS reach
  FROM s CROSS JOIN src
  LEFT JOIN public.context_email_deep_reach x ON x.source_key=src.source_key AND x.job_id=s.job_id
  WHERE s.monitored
 ),
 agg AS (
  SELECT per.job_id,
   CASE WHEN bool_or(per.reach IS NULL) THEN NULL ELSE max(per.reach) END AS reaches,
   jsonb_agg(jsonb_build_object('source_key',per.source_key,'reaches',per.reach,'state',per.state) ORDER BY per.source_key COLLATE "C") AS sources,
   -- Among the most-behind mailboxes, the one whose state explains the most.
   (array_agg(per.state ORDER BY per.reach DESC NULLS FIRST,
    array_position(ARRAY['stalled','waiting_live','waiting_near','not_planned','gave_up','succeeded','pending','loading'],per.state),
    per.source_key COLLATE "C"))[1] AS behind_state
  FROM per GROUP BY per.job_id
 )
 SELECT s.job_id, s.job_number, s.monitored, s.lead_rule, s.job_started, s.lead_in_from, a.reaches,
  CASE WHEN NOT s.monitored THEN 'not_monitored'
   WHEN s.lead_in_from IS NULL THEN 'unknown_start'
   WHEN a.reaches IS NULL THEN 'not_started'
   WHEN a.reaches<=s.lead_in_from THEN 'reaches_start'
   WHEN a.reaches<=pol.hard THEN 'short'
   ELSE 'loading' END,
  CASE WHEN NOT s.monitored THEN 'lead_not_monitored'
   WHEN s.lead_in_from IS NULL THEN 'no_first_record'
   WHEN a.reaches IS NULL THEN 'mailbox_never_read'
   WHEN a.reaches<=s.lead_in_from THEN NULL
   WHEN a.reaches<=pol.hard THEN 'hard_floor'
   WHEN NOT flag.on_ THEN 'deep_load_off'
   WHEN a.behind_state='stalled' THEN 'mailbox_stalled'
   WHEN a.behind_state='waiting_near' THEN 'waiting_near_load'
   WHEN a.behind_state='waiting_live' THEN 'mailbox_never_polled'
   WHEN a.behind_state='succeeded' THEN 'next_daily_walk'
   WHEN a.behind_state='not_planned' THEN 'deep_load_not_started'
   WHEN a.behind_state='gave_up' THEN 'source_not_selected'
   ELSE 'loading' END,
  coalesce(a.sources,'[]'::jsonb)
 FROM s CROSS JOIN pol CROSS JOIN flag LEFT JOIN agg a ON a.job_id=s.job_id
$fn$;
COMMENT ON FUNCTION public.context_email_history_reach_jobs(uuid[],timestamp with time zone) IS
 'History depth (20261007080000): for scorecard v2, row 14 per job. One row per live job (or the given ids): monitored and the lead rule (context_email_deep_scope_jobs), job_started (first record), lead_in_from (30 days earlier: where its email history starts), reaches (how far back its email is complete: the latest of its per-mailbox reaches over the selected mailboxes, each the deep load''s reach row or else that mailbox''s live floor; null when a selected mailbox was never read), status (reaches_start when reaches <= lead_in_from; loading; short when the hard floor stops it; not_started; unknown_start; not_monitored), reason (null when it reaches its start; else lead_not_monitored, no_first_record, mailbox_never_read, hard_floor, deep_load_off, mailbox_stalled, waiting_near_load, mailbox_never_polled, next_daily_walk, deep_load_not_started, source_not_selected or loading, from the most-behind mailbox, the worst state first), and sources (one {source_key, reaches, state} each, byte order). Monitored is judged at p_as_of; reaches are as stored now. Service role only.';

-- 12. The scorecard's read: each mailbox's reach and the job counts (row 14).
CREATE OR REPLACE FUNCTION public.context_email_history_reach(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH pol AS (SELECT public.context_email_deep_policy() AS p),
 j AS (SELECT * FROM public.context_email_history_reach_jobs(NULL,p_as_of)),
 per AS (
  SELECT j.job_id, j.lead_in_from, e->>'source_key' AS source_key, (e->>'reaches')::timestamptz AS reach
  FROM j CROSS JOIN jsonb_array_elements(j.sources) e WHERE j.monitored AND j.lead_in_from IS NOT NULL
 ),
 mb AS (
  SELECT m.source_key, m.kind, pl.state, coalesce(pl.live_floor,public.context_email_deep_live_floor(m.source_key)) AS live_floor,
   pl.covered_from, pl.slices_done, pl.posts, pl.stall_reason, pl.last_progress_at
  FROM public.monitored_mailboxes m LEFT JOIN public.context_email_deep_plan pl ON pl.source_key=m.source_key
  WHERE m.enabled AND m.status='active' AND m.kind IN ('user','group')
 ),
 tgt AS (
  SELECT greatest((pol.p->>'hard_floor')::timestamptz,date_trunc('second',min(j.lead_in_from))) AS t
  FROM j CROSS JOIN pol WHERE j.monitored GROUP BY pol.p
 ),
 boxes AS (
  SELECT mb.*, coalesce(mb.covered_from,mb.live_floor) AS reaches,
   (SELECT count(*) FROM per WHERE per.source_key=mb.source_key
     AND (per.reach IS NULL OR per.reach>greatest(per.lead_in_from,(SELECT (p->>'hard_floor')::timestamptz FROM pol)))) AS needing
  FROM mb
 )
 SELECT jsonb_build_object(
  'version',(SELECT p->>'version' FROM pol),
  'as_of',p_as_of,
  'flag',coalesce((SELECT bool_or(ff.enabled) FROM public.feature_flags ff WHERE ff.flag_name='email_reader_deep_v1'),false),
  'lead_rule',(SELECT max(j.lead_rule) FROM j),
  'hard_floor',(SELECT p->>'hard_floor' FROM pol),
  'target_floor',(SELECT t FROM tgt),
  'jobs',jsonb_build_object('live',(SELECT count(*) FROM j),'monitored',(SELECT count(*) FROM j WHERE j.monitored),
   'reaches_start',(SELECT count(*) FROM j WHERE j.status='reaches_start'),'loading',(SELECT count(*) FROM j WHERE j.status='loading'),
   'short',(SELECT count(*) FROM j WHERE j.status='short'),'not_started',(SELECT count(*) FROM j WHERE j.status='not_started'),
   'unknown_start',(SELECT count(*) FROM j WHERE j.status='unknown_start'),'not_monitored',(SELECT count(*) FROM j WHERE j.status='not_monitored')),
  'email_depth_pct',(SELECT CASE WHEN count(*) FILTER (WHERE j.monitored)=0 THEN NULL
   ELSE round(100.0*count(*) FILTER (WHERE j.status='reaches_start')/count(*) FILTER (WHERE j.monitored),1) END FROM j),
  'mailboxes_selected',(SELECT count(*) FROM boxes),
  'mailboxes_finished',(SELECT count(*) FROM boxes b WHERE b.live_floor IS NOT NULL AND b.needing=0),
  'mailboxes',coalesce((SELECT jsonb_agg(jsonb_build_object('source_key',b.source_key,'kind',b.kind,'state',coalesce(b.state,'not_planned'),
    'live_floor',b.live_floor,'covered_from',b.covered_from,'reaches',b.reaches,'target_floor',(SELECT t FROM tgt),
    'reaches_target',b.reaches IS NOT NULL AND b.reaches<=(SELECT t FROM tgt),'needing_jobs',b.needing,
    'finished',b.live_floor IS NOT NULL AND b.needing=0,'slices_done',coalesce(b.slices_done,0),'posts',coalesce(b.posts,0),
    'stall_reason',b.stall_reason,'last_progress_at',b.last_progress_at) ORDER BY b.source_key COLLATE "C") FROM boxes b),'[]'::jsonb))
$fn$;
COMMENT ON FUNCTION public.context_email_history_reach(timestamp with time zone) IS
 'History depth (20261007080000): for scorecard v2, row 14. jobs: live, monitored and the monitored jobs by status of context_email_history_reach_jobs (reaches_start, loading, short, not_started, unknown_start); email_depth_pct (reaches_start of monitored); target_floor (the start of the oldest monitored job''s email history, to the second, not before the hard floor); mailboxes_selected and mailboxes_finished; mailboxes: one per selected mailbox: state, live_floor, covered_from, reaches (how far back its walk has read: covered_from, else the live floor), reaches_target, needing_jobs (monitored jobs it is still short for), finished (none), slices_done, posts, stall_reason, last_progress_at. Service role only.';

-- 13. The capture lane owns the new job: the live list plus one row, every row
-- it has kept. On B-5's body (20261005210000, production on 7 Oct 2026) the
-- result is md5 250d7e9ec2ebecc7e83192a39b7da488; on the history daily slice's
-- (20261007050000, PR 989: B-5's plus xero-history-daily), when that slice
-- merged first, 6498276b1eb16b527fb76dd2b0fa6d83. A list that already names
-- outlook-mail-deep-history (a re-apply) is left alone.
DO $lanes$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid='public.automation_switch_cron_lanes()'::regprocedure;
 IF live='99e6d70e80a79e548f2478b65fc6cd78' THEN
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
 ELSIF live='81cbebf914f537b0b85870196cbd0f75' THEN
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
    ('xero-history-daily', 'capture'),
    ('outlook-mail-deep-history', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$
$def$;
 ELSE
  RAISE NOTICE 'email deep history: automation_switch_cron_lanes() already names outlook-mail-deep-history; left alone';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname='outlook-mail-deep-history' AND l.lane='capture') THEN
  RAISE EXCEPTION 'email_deep_history_lanes_failed: automation_switch_cron_lanes() does not name outlook-mail-deep-history on the capture lane';
 END IF;
END $lanes$;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its
-- unwrap can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'email deep history: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='outlook-mail-deep-history') THEN
  PERFORM cron.schedule('outlook-mail-deep-history','4-59/5 * * * *',
   $cmd$SELECT public.trigger_context_email_deep_history() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
END $cron$;

-- 14. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_email_deep_policy(),public.context_email_deep_enabled(),public.context_email_deep_job_refs(jsonb),
 public.context_email_deep_live_floor(text),public.context_email_deep_scope_jobs(timestamp with time zone),public.context_email_deep_scope(),
 public.trigger_context_email_deep_history(),public.context_email_deep_status(),
 public.context_email_history_reach_jobs(uuid[],timestamp with time zone),public.context_email_history_reach(timestamp with time zone)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.trigger_context_email_deep_history() FROM service_role;
GRANT EXECUTE ON FUNCTION public.context_email_deep_policy(),public.context_email_deep_enabled(),public.context_email_deep_job_refs(jsonb),
 public.context_email_deep_live_floor(text),public.context_email_deep_scope_jobs(timestamp with time zone),public.context_email_deep_scope(),
 public.context_email_deep_status(),public.context_email_history_reach_jobs(uuid[],timestamp with time zone),
 public.context_email_history_reach(timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_context_email_deep_history() TO postgres;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
