-- K1: extraction triggered by evidence (INTEGRATION.md Wave 2, slice K1;
-- design cadence.md section 9.A).
--
-- Today a job is read once per Perth day from 06:00, our own messages never
-- start a read, and a job read once is not looked at again until the customer
-- writes. After this migration the database decides when a job is due from
-- the evidence itself:
--   quiet    the newest waking row landed at least 15 min ago, or
--   ceiling  the oldest waking row landed at least 60 min ago;
--   and no run started in the last 30 min, fewer than 6 runs this Perth date
--   (10 when the newest waking row is the customer's own words in business
--   hours), no run live or waiting on its retry, and before 12:00 Perth at
--   most 300 of the 400 model calls spent.
-- Status-only rows (trade.*, booking.*, ghl.task_*, ghl.appointment_*,
-- invoice paid/authorised/emailed, po.created, workflow texts) never wake a
-- job; they ride along, or get one read of their own after 18:00 Perth.
-- Rows written with a key other than service_role are kept but never wake a
-- job and never enter a batch. History loads (capture_mode backfill), re-links
-- (capture_mode relink) and everything captured before this migration never
-- wake a job on their own.
--
-- What this migration builds (cadence.md 9.A items 1 to 10, 12, 13):
--   1. context_cadence_policy(): every number, in one place, plus live_since
--      (the moment this migration was first applied).
--   2. context_extraction_runs.run_seq: a job may be read several times a day.
--   3. claim_context_extraction_run: outcomes claimed, busy, paused, done,
--      ceiling, pacing; renew_context_extraction_run.
--   4. context_unread_events(job) (the one unread definition,
--      context_unread_rows) and context_extraction_events: newest
--      landed first, the newest customer row always included, output in time
--      order. The per-row flags (ours, older_context) come from
--      context_extraction_event_flags, see note (a).
--   5. context_extraction_candidates: the due rule, same signature.
--   6. business_events indexes for the cadence reads.
--   7. claim_context_pass / renew_context_pass / finish_context_pass: 5-minute
--      lease, no 06:00 gate, done is not terminal, lease takeovers counted.
--   8. context_job_freshness(job): the freshness section the dossier (K4)
--      shows, with a rendered line.
--   9. context_cadence_status(): replaces the F1 stub; the composer is not
--      touched.
--  10. Rollback: supabase/rollbacks/20260924030000_context_evidence_cadence_down.sql.
--  12. context_event_is_ours(row) and the staff_ghl_users lookup table.
--  13. Grants; the BEFORE INSERT trigger records metadata.written_as.
-- Item 11 (attribution attempts and the attribution sub-budget) is slice A1
-- and is not built here; nothing below reads an A1 object. The policy carries
-- attribution_calls_day for A1 to read.
--
-- Notes on deliberate choices:
--  (a) context_extraction_events keeps returning exact business_events rows.
--      persist_luna_context_revision compares every source row byte for byte
--      with the table (luna_source_revision_stale), so flags inside the row
--      would make every revision stale. The worker reads the flags for the
--      same ids from context_extraction_event_flags(job, ids).
--  (b) "Landed" is greatest(context_captured_at, attributed_at). A row wakes
--      only when it was also CAPTURED at or after live_since: a pre-go-live
--      row re-linked later by the ladder re-run is history, not new evidence,
--      and the re-run does not stamp capture_mode (that function belongs to
--      the placement track).
--  (c) Evidence captured more than age_window_days (14) ago no longer wakes a
--      read on its own; it still rides along as older context. This bounds
--      every cadence read to two weeks of rows, so the per-minute tick and the
--      heartbeat stay cheap as the table grows.
--  (d) The pass and pass-renew checks are token-based: a holder whose lease
--      ran out may still renew or finish until another process takes the
--      pass over (which rotates the token). A slow job no longer fails the
--      whole tick; a dead worker is still replaced within 5 minutes.
--  (e) claim_context_extraction_run enforces the hard limits (busy, retry,
--      cooldown, daily ceiling, morning reserve) itself, so no worker can
--      overspend; the quiet-period rule stays in the candidates read.
--  (f) Pacing is enforced at claim and in the candidates read. The reservation
--      function belongs to A1 and is not changed, so a run already under way
--      may take the morning total a few calls past 300.
--
-- No flag or switch changes. No existing row is written or rewritten.
-- Rollout (cadence.md section 12, firstmate instruction 23 Sep): K1 and the
-- worker slice K2 merge back to back outside 05:30 to 07:00 Perth; the
-- extraction lane is switched off just before K1 merges and back on only
-- after K2's first tick is verified.
-- Built on the LIVE production definitions, read from production on 23 Sep
-- 2026 (read-only). Every replaced function's md5(prosrc) equals its
-- repository body except attribute_business_event(), whose live body is the
-- 20260914110000 body without its two comment lines (same statements); K1
-- rebuilds on the live text. The ledger held nothing at or after
-- 20260924020000 other than that migration. The extraction lane was on.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once. Each replaced function
-- must be its live production body (or this migration's, for a re-apply); each
-- new name must be absent or already this migration's.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.attribute_business_event()',ARRAY['c399dfbebcd120a4b0741a9130a973bf','7c1b8ffeeed8829288ee42c30e4314e5'],false),
  ('public.claim_context_extraction_run(uuid,date,text)',ARRAY['220a8998c8c7d2803be2c9e9f0087cee','ac6f021c77dbf0e44a949ea94d24f666'],false),
  ('public.claim_context_pass(date)',ARRAY['5085741c2f41def9244717b16f15ffb2','6ef1e37bb1f41092f6f5f5228f820d46'],false),
  ('public.renew_context_pass(date,uuid)',ARRAY['a45e3fd2e2d7ef34ea323deddfb9abe6','b06ad7baf3a44b69286f9145e23d7884'],false),
  ('public.finish_context_pass(date,uuid,text,timestamptz,text)',ARRAY['d41992ac30bea7c884a5856395c233cd','c1b28ccd6361ed9b74ccd231372e8518'],false),
  ('public.context_extraction_events(uuid,integer)',ARRAY['b20069eae64c43cf4d9315f6ffc8e2b7','89be3c172be015ad6be3a875ea73a40f'],false),
  ('public.context_extraction_candidates(integer)',ARRAY['6428bee63b2db436dbe1c6dcaeafd69e','0257dc0ea9c35a249b3b8adcb99a18d4'],false),
  ('public.context_cadence_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','04a99b46fbdf6b6ac830602da6a92c3d'],false),
  ('public.context_ready_jobs_count(integer)',ARRAY['67e55f87c9e53c4f6640a0936d8d279b','7dee92c8660ecf3a113b109f0e3128bd'],false),
  ('public.context_request_role()',ARRAY['94c307050a74b605c8a15ff8d0d50264'],true),
  ('public.context_event_status_only(public.business_events)',ARRAY['50c3b2e467a6e8a3c598fa4116c27553'],true),
  ('public.context_unread_rows(uuid[])',ARRAY['d426adcccab139a188ee158e14ca4fb1'],true),
  ('public.context_event_is_ours(public.business_events)',ARRAY['b34febf8d9ea77ef1a31b088e02b0901'],true),
  ('public.context_unread_events(uuid)',ARRAY['3897a4a1954c9bb6cf35419e9d04d285'],true),
  ('public.context_jobs_cadence(uuid[])',ARRAY['8ed68b962afc065d5edff7f52714ba96'],true),
  ('public.context_job_cadence(uuid)',ARRAY['7110b88f2557febce945e9aed2e6441d'],true),
  ('public.context_cadence_pool()',ARRAY['3d2c590449ce2738d952be765f26d357'],true),
  ('public.context_job_freshness(uuid)',ARRAY['a901eef0f9135bf04676d81742b85595'],true),
  ('public.context_extraction_event_flags(uuid,uuid[])',ARRAY['c384d748eca9b3b94ba6e54b26b781e5'],true),
  ('public.renew_context_extraction_run(uuid,uuid)',ARRAY['4a67eafbe87cd378282db0e021e0305c'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- The policy carries its apply time, so its body is recognised by marker.
 SELECT p.prosrc INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_cadence_policy()');
 IF live IS NOT NULL AND position('k1-cadence-policy-v1' in live)=0 THEN problems:=problems||'public.context_cadence_policy() is not this migration''s'::text; END IF;
 -- The trigger must still route every insert through attribute_business_event.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass AND t.tgname='context_attribute_business_event'
   AND NOT t.tgisinternal AND t.tgfoid='public.attribute_business_event()'::regprocedure)
 THEN problems:=problems||'trigger context_attribute_business_event is missing or calls another function'::text; END IF;
 -- The run ledger: the one-run-a-day index, or (re-apply) the run_seq index.
 live:=NULL;
 SELECT indexdef INTO live FROM pg_indexes WHERE schemaname='public' AND indexname='context_extraction_runs_job_day_phase';
 IF live IS NOT NULL AND live<>'CREATE UNIQUE INDEX context_extraction_runs_job_day_phase ON public.context_extraction_runs USING btree (job_id, run_date, phase) WHERE (job_id IS NOT NULL)'
 THEN problems:=problems||format('context_extraction_runs_job_day_phase is %s',live); END IF;
 IF live IS NULL AND to_regclass('public.context_extraction_runs_job_day_phase_seq') IS NULL
 THEN problems:=problems||'context_extraction_runs has neither the daily index nor the run_seq index'::text; END IF;
 IF to_regclass('public.staff_ghl_users') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_description d
   WHERE d.objoid=to_regclass('public.staff_ghl_users') AND d.classoid='pg_class'::regclass AND d.description LIKE 'K1:%')
 THEN problems:=problems||'public.staff_ghl_users already exists and is not this migration''s'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_cadence_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Policy. Immutable; changed only by migration. live_since is written once,
-- when this migration is first applied, and a re-apply keeps it.
DO $policy$
BEGIN
 IF to_regprocedure('public.context_cadence_policy()') IS NULL THEN
  EXECUTE format($f$
CREATE FUNCTION public.context_cadence_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $body$
 -- k1-cadence-policy-v1
 SELECT jsonb_build_object(
  'version','k1-cadence-policy-v1','timezone','Australia/Perth',
  'quiet_min',15,'ceiling_min',60,'cooldown_min',30,
  'runs_per_job_day',6,'inbound_extra_runs',4,
  'retry_min',jsonb_build_array(30,120),
  'attribution_calls_day',60,'model_call_cap',400,'morning_cap',300,'morning_until','12:00',
  'status_only_after','18:00',
  'tick_max_seconds',300,'tick_max_jobs',10,'pass_lease_min',5,'run_lease_min',30,'busy_not_ready_min',10,
  'breach_wait_min',90,'age_window_days',14,
  'live_since',%L::timestamptz)
$body$$f$, now());
 END IF;
END $policy$;
COMMENT ON FUNCTION public.context_cadence_policy() IS
 'K1 cadence numbers (cadence.md 5.1) and live_since, the first apply time of 20260924030000. Rows captured before live_since never wake a read. Changed only by migration.';

-- 2. Run ledger: several runs a day per job. Existing rows are run_seq 1.
ALTER TABLE public.context_extraction_runs ADD COLUMN IF NOT EXISTS run_seq integer NOT NULL DEFAULT 1;
DO $c$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_extraction_runs'::regclass AND conname='context_extraction_runs_run_seq_positive')
 THEN ALTER TABLE public.context_extraction_runs ADD CONSTRAINT context_extraction_runs_run_seq_positive CHECK (run_seq>0); END IF;
END $c$;
CREATE UNIQUE INDEX IF NOT EXISTS context_extraction_runs_job_day_phase_seq
 ON public.context_extraction_runs(job_id,run_date,phase,run_seq) WHERE job_id IS NOT NULL;
DROP INDEX IF EXISTS public.context_extraction_runs_job_day_phase;
ALTER TABLE public.context_pass_days ADD COLUMN IF NOT EXISTS lease_takeovers integer NOT NULL DEFAULT 0;

-- 6. Indexes. Every cadence read starts from rows captured in the last two
-- weeks (note c); the status counts unplaced rows without a table scan.
CREATE INDEX IF NOT EXISTS business_events_context_captured_at
 ON public.business_events(context_captured_at) WHERE context_captured_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_events_unplaced_at
 ON public.business_events(event_at,occurred_at) WHERE attribution_status='unplaced';

-- 12. Staff GHL user ids. Read by context_event_is_ours; filled by the GHL
-- user map follow-up. Until then the other "ours" signals apply.
CREATE TABLE IF NOT EXISTS public.staff_ghl_users (
 ghl_user_id text PRIMARY KEY CHECK (btrim(ghl_user_id)<>''),
 label text,
 added_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.staff_ghl_users IS
 'K1: GHL user ids of our staff. A business_events row whose payload.sent_by_user is listed here is ours (context_event_is_ours). Service role only.';
ALTER TABLE public.staff_ghl_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_ghl_users FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.staff_ghl_users TO service_role;

-- 13. Who wrote the row. The request role PostgREST sets for the call; no
-- request (cron, a database function called from inside the database, a
-- migration) is service_role. An unreadable claim is 'unknown', which never
-- wakes a read.
CREATE OR REPLACE FUNCTION public.context_request_role() RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE claims text; role text;
BEGIN
 claims:=nullif(btrim(current_setting('request.jwt.claims',true)),'');
 IF claims IS NOT NULL THEN
  BEGIN
   role:=nullif(btrim(claims::jsonb->>'role'),'');
  EXCEPTION WHEN OTHERS THEN RETURN 'unknown';
  END;
 END IF;
 IF role IS NULL THEN role:=nullif(btrim(current_setting('request.jwt.claim.role',true)),''); END IF;
 RETURN coalesce(role,'service_role');
END $$;
COMMENT ON FUNCTION public.context_request_role() IS
 'K1: the request role of the current call (request.jwt.claims role), service_role when no request is present, unknown when the claim cannot be read.';

-- The trigger body is the live production body (read 23 Sep 2026, md5
-- c399dfbe..., the 20260914110000 body without its two comment lines) plus one
-- statement: written_as is set after the ladder and overwrites anything the
-- writer sent, so a caller can never claim to be service_role.
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('written_as', public.context_request_role());
  RETURN NEW;
END $$;

-- Status-only rows (cadence.md 5.1, review S2): read when something else wakes
-- the job, never a reason to read on their own before 18:00 Perth.
CREATE OR REPLACE FUNCTION public.context_event_status_only(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(
  e.event_type LIKE 'trade.%' OR e.event_type LIKE 'booking.%'
  OR e.event_type LIKE 'ghl.task\_%' OR e.event_type LIKE 'ghl.appointment\_%'
  OR e.event_type IN ('invoice.payment_received','invoice.authorised','invoice.emailed','po.created')
  OR (e.event_type='client.sms_out' AND e.payload->>'sent_by_kind'='workflow'),false)
$$;

-- 4. The one unread definition: rows on a job, linked, stamped, worded,
-- written by service_role (or before K1, when no writer was recorded), and not
-- yet read by luna_v2 for that job. Any direction. p_job_ids NULL means every
-- job. Inlinable (SQL, invoker, no SET clause, every operator schema-
-- qualified) so the caller's filters, such as the two-week capture window,
-- reach the business_events indexes.
CREATE OR REPLACE FUNCTION public.context_unread_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE AS $$
 SELECT e.* FROM public.business_events e
 WHERE e.job_id IS NOT NULL AND (p_job_ids IS NULL OR e.job_id OPERATOR(pg_catalog.=) ANY(p_job_ids))
  AND public.context_linked_status(e.attribution_status)
  AND e.context_captured_at IS NOT NULL
  AND coalesce(e.metadata OPERATOR(pg_catalog.->>) 'written_as','service_role') OPERATOR(pg_catalog.=) 'service_role'
  AND pg_catalog.btrim(public.context_event_text(e)) OPERATOR(pg_catalog.<>) ''
  AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r
   WHERE r.event_id OPERATOR(pg_catalog.=) e.id AND r.job_id OPERATOR(pg_catalog.=) e.job_id
    AND r.extractor_version OPERATOR(pg_catalog.=) 'luna_v2')
$$;

CREATE OR REPLACE FUNCTION public.context_unread_events(p_job_id uuid) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT u.* FROM public.context_unread_rows(ARRAY[p_job_id]) u
 WHERE p_job_id IS NOT NULL
 ORDER BY greatest(u.context_captured_at,u.attributed_at) DESC NULLS LAST, u.id DESC
$$;

-- 12. "Ours": our words, not the customer's. Direction alone is not trusted
-- (our own mail has been stored as inbound client email). Any one signal is
-- enough.
CREATE OR REPLACE FUNCTION public.context_event_is_ours(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(
  e.direction='outbound'
  -- sender address in one of our domains (subdomains included)
  OR lower(coalesce(substring(coalesce(e.payload->>'from',e.payload->>'from_email',e.payload->>'sender','') from '@([A-Za-z0-9.-]+)'),''))
     ~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
  -- sent from one of our five SMS lines (_shared/sms_from_number.ts)
  OR right(regexp_replace(coalesce(e.payload->>'from_line',e.payload->>'from_number',e.payload->>'fromNumber',e.payload->>'from',''),'[^0-9]','','g'),9)
     IN ('489267771','489267772','489267774','489267776','489267778')
  OR EXISTS(SELECT 1 FROM public.staff_ghl_users s WHERE s.ghl_user_id=e.payload->>'sent_by_user')
  OR e.payload->>'sent_by_kind' IN ('staff_app','workflow','our_tool')
  OR e.event_type='ghl.internal_comment' OR e.event_type LIKE 'ghl.note\_%'
  OR e.source IN ('ghl-proxy','send-quote','mcp_agent'),false)
$$;

-- The cadence judgement (cadence.md 5.1), set-based so the tick and the
-- heartbeat judge every job in one query. The one definition: the claim,
-- candidates, freshness and status all take their answer from here.
CREATE OR REPLACE FUNCTION public.context_jobs_cadence(p_job_ids uuid[]) RETURNS TABLE(job_id uuid, cadence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH k AS (
  SELECT pol.p, now() AS now_t, (now() AT TIME ZONE 'Australia/Perth') AS local_now, (now() AT TIME ZONE 'Australia/Perth')::date AS today,
   greatest((pol.p->>'live_since')::timestamptz, now()-make_interval(days=>(pol.p->>'age_window_days')::integer)) AS live_from,
   (((now() AT TIME ZONE 'Australia/Perth')::date)::timestamp+(pol.p->>'status_only_after')::time) AT TIME ZONE 'Australia/Perth' AS evening,
   public.automation_lane_enabled('extraction') AS lane, public.context_in_business_hours(now()) AS business_hours,
   (SELECT count(*) FROM public.context_model_call_reservations r WHERE r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date)::integer AS calls
  FROM (SELECT public.context_cadence_policy() AS p) pol
 ), j AS (
  SELECT jb.id, jb.created_at, coalesce(jb.metadata->>'do_not_schedule','') NOT IN ('true','1') AS extractable
  FROM public.jobs jb WHERE jb.id=ANY(p_job_ids)
 ), u AS MATERIALIZED (
  -- Live evidence: captured since live_from, capture_mode live, written as
  -- service_role, and not the early relink case (a contact-rule placement,
  -- ladder step 3 or 4, of a row older than the job).
  SELECT x.job_id, x.id, greatest(x.context_captured_at,x.attributed_at) AS landed, public.context_event_status_only(x) AS so,
   (x.context_captured_at>=k.live_from AND coalesce(x.metadata->>'capture_mode','live')='live' AND x.metadata->>'written_as'='service_role'
    AND NOT (coalesce(x.attribution_step,0) IN (3,4) AND coalesce(x.event_at,x.occurred_at)<j.created_at)) AS live
  FROM public.context_unread_rows(p_job_ids) x JOIN j ON j.id=x.job_id CROSS JOIN k
 ), ev AS (
  SELECT u.job_id, count(*) AS unread_n, min(u.landed) AS oldest_unread,
   count(*) FILTER (WHERE u.live AND NOT u.so) AS wake_n,
   max(u.landed) FILTER (WHERE u.live AND NOT u.so) AS newest_wake, min(u.landed) FILTER (WHERE u.live AND NOT u.so) AS oldest_wake,
   (array_agg(u.id ORDER BY u.landed DESC NULLS LAST, u.id DESC) FILTER (WHERE u.live AND NOT u.so))[1] AS newest_wake_id,
   count(*) FILTER (WHERE u.live AND u.so) AS so_n, min(u.landed) FILTER (WHERE u.live AND u.so) AS oldest_so
  FROM u GROUP BY u.job_id
 ), runs AS (
  SELECT r.job_id, count(*) FILTER (WHERE r.run_date=k.today) AS runs_today, max(r.started_at) AS last_started,
   max(r.finished_at) FILTER (WHERE r.status='done') AS last_finished,
   bool_or(r.status='running' AND r.lease_expires_at>k.now_t) AS run_live,
   max(r.retry_at) FILTER (WHERE r.status='failed' AND r.retry_at>k.now_t) AS retry_until,
   bool_or(r.run_date=k.today AND r.started_at>=k.evening) AS ran_evening
  FROM public.context_extraction_runs r CROSS JOIN k WHERE r.job_id=ANY(p_job_ids) AND r.phase='extraction' GROUP BY r.job_id
 ), base AS (
  SELECT j.id AS job_id, j.extractable, k.*,
   coalesce(ev.unread_n,0)::integer AS unread_n, ev.oldest_unread, coalesce(ev.wake_n,0)::integer AS wake_n, ev.newest_wake, ev.oldest_wake,
   coalesce(ev.so_n,0)::integer AS so_n, ev.oldest_so,
   coalesce((SELECT b.direction='inbound' AND NOT public.context_event_is_ours(b) FROM public.business_events b WHERE b.id=ev.newest_wake_id),false) AS customer,
   coalesce(runs.runs_today,0)::integer AS runs_today, runs.last_started, runs.last_finished, coalesce(runs.run_live,false) AS run_live,
   runs.retry_until, coalesce(runs.ran_evening,false) AS ran_evening
  FROM j CROSS JOIN k LEFT JOIN ev ON ev.job_id=j.id LEFT JOIN runs ON runs.job_id=j.id
 ), limits AS (
  SELECT b.*,
   b.local_now::time<(b.p->>'morning_until')::time AND b.calls>=(b.p->>'morning_cap')::integer AS pacing,
   b.calls>=(b.p->>'model_call_cap')::integer AS capped,
   (b.p->>'runs_per_job_day')::integer+CASE WHEN b.customer AND b.business_hours THEN (b.p->>'inbound_extra_runs')::integer ELSE 0 END AS run_limit,
   CASE WHEN b.wake_n>0 THEN least(b.newest_wake+make_interval(mins=>(b.p->>'quiet_min')::integer),b.oldest_wake+make_interval(mins=>(b.p->>'ceiling_min')::integer))
        WHEN b.so_n>0 THEN CASE WHEN b.ran_evening THEN b.evening+interval '1 day' ELSE b.evening END END AS evidence_due,
   b.last_started+make_interval(mins=>(b.p->>'cooldown_min')::integer) AS cooldown_until
  FROM base b
 ), timed AS (
  SELECT l.*, greatest(l.evidence_due,l.cooldown_until,l.retry_until) AS due_at FROM limits l
 ), judged AS (
  SELECT t.*,
   (t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live AND t.runs_today<t.run_limit AND NOT t.pacing AND t.due_at<=t.now_t) AS due,
   CASE WHEN NOT t.lane THEN 'lane_off' WHEN NOT t.extractable THEN 'holding_job' WHEN t.evidence_due IS NULL OR t.run_live THEN NULL
    WHEN t.runs_today>=t.run_limit THEN 'daily_ceiling' WHEN t.retry_until IS NOT NULL THEN 'retry_wait'
    WHEN t.capped THEN 'model_cap' WHEN t.pacing THEN 'pacing_reserve' END AS reason,
   CASE WHEN t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live THEN
    greatest(t.due_at,t.now_t,
     CASE WHEN t.runs_today>=t.run_limit OR t.capped THEN (t.today+1)::timestamp AT TIME ZONE 'Australia/Perth' END,
     CASE WHEN t.pacing THEN (t.today::timestamp+(t.p->>'morning_until')::time) AT TIME ZONE 'Australia/Perth' END) END AS next_due
  FROM timed t
 )
 SELECT g.job_id, jsonb_build_object('job_id',g.job_id,'due',g.due,'due_since',CASE WHEN g.due THEN g.due_at END,'blocked_reason',g.reason,'next_due_at',g.next_due,
  'lane_on',g.lane,'extractable',g.extractable,'unread_count',g.unread_n,'oldest_unread_landed_at',g.oldest_unread,
  'waking_count',g.wake_n,'newest_waking_landed_at',g.newest_wake,'oldest_waking_landed_at',g.oldest_wake,'newest_waking_is_customer',g.customer,
  'status_only_count',g.so_n,'order_at',coalesce(g.oldest_wake,g.oldest_so),
  'runs_today',g.runs_today,'run_limit',g.run_limit,'run_live',g.run_live,'retry_at',g.retry_until,'cooldown_until',g.cooldown_until,
  'last_run_started_at',g.last_started,'last_run_finished_at',g.last_finished,
  'model_calls_today',g.calls,'pacing_held',g.pacing,'model_cap_reached',g.capped)
 FROM judged g
$$;
COMMENT ON FUNCTION public.context_jobs_cadence(uuid[]) IS
 'K1: the one cadence judgement (cadence.md 5.1) for a set of jobs: due, blocked_reason, next_due_at and the facts behind them. Read by the claim, candidates, freshness and status.';

CREATE OR REPLACE FUNCTION public.context_job_cadence(p_job_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.cadence FROM public.context_jobs_cadence(ARRAY[p_job_id]) c
$$;

-- Jobs that can be due at all: some unread live row captured in the window.
CREATE OR REPLACE FUNCTION public.context_cadence_pool() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p)
 SELECT DISTINCT u.job_id FROM public.context_unread_rows(NULL) u, pol
 WHERE u.context_captured_at>=greatest((pol.p->>'live_since')::timestamptz, now()-make_interval(days=>(pol.p->>'age_window_days')::integer))
  AND coalesce(u.metadata->>'capture_mode','live')='live' AND u.metadata->>'written_as'='service_role'
$$;

-- 5. Due jobs, same signature: fewest runs today first, then oldest waking
-- evidence first.
CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH lane AS (SELECT public.automation_lane_enabled('extraction') AS enabled),
 judged AS (SELECT x.job_id, x.cadence AS c
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id) WHERE (SELECT enabled FROM lane))) x)
 SELECT j.job_id FROM judged j WHERE (j.c->>'due')::boolean
 ORDER BY (j.c->>'runs_today')::integer, (j.c->>'order_at')::timestamptz NULLS LAST, j.job_id
 LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;

-- F1 pinned the heartbeat's ready_jobs equal to this read; the candidates read
-- is now bounded to two weeks of rows, so the count is the read itself.
CREATE OR REPLACE FUNCTION public.context_ready_jobs_count(p_cap integer DEFAULT 400) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT count(*)::integer FROM public.context_extraction_candidates(p_cap)
$$;
COMMENT ON FUNCTION public.context_ready_jobs_count(integer) IS
 'Heartbeat ready_jobs: count of context_extraction_candidates(p_cap), capped at 400. K1 made the candidates read cheap (two-week window), so this is the read itself.';

-- 4. The batch: newest landed first so the rows that woke the job are always
-- read, the newest customer (not ours) row always included, older rows while
-- space remains; returned in time order. Exact rows (note a).
CREATE OR REPLACE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH admitted AS (
  SELECT public.automation_lane_enabled('extraction')
   AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND public.context_job_extractable(j)) AS ok
 ), unread AS MATERIALIZED (
  SELECT u.* FROM public.context_unread_rows(ARRAY[p_job_id]) u WHERE (SELECT ok FROM admitted)
 ), anchor AS (
  SELECT e.id FROM unread u JOIN public.business_events e ON e.id=u.id
  WHERE NOT public.context_event_is_ours(e)
  ORDER BY greatest(e.context_captured_at,e.attributed_at) DESC NULLS LAST, e.id DESC LIMIT 1
 ), picked AS (
  SELECT u.* FROM unread u
  ORDER BY (u.id IN (SELECT id FROM anchor)) DESC, greatest(u.context_captured_at,u.attributed_at) DESC NULLS LAST, u.id DESC
  LIMIT greatest(0,least(coalesce(p_limit,25),25))
 ) SELECT * FROM picked ORDER BY coalesce(event_at,occurred_at), id
$$;

-- The flags the worker passes to the model and the validator for a batch:
-- ours (context_event_is_ours) and older_context (older than the age window,
-- or older than the job's last completed read). Ids not on the job are ignored.
CREATE OR REPLACE FUNCTION public.context_extraction_event_flags(p_job_id uuid,p_event_ids uuid[])
RETURNS TABLE(event_id uuid, ours boolean, older_context boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p),
 last_read AS (SELECT max(r.started_at) AS at FROM public.context_extraction_runs r
  WHERE r.job_id=p_job_id AND r.phase='extraction' AND r.status='done')
 SELECT e.id, public.context_event_is_ours(e),
  coalesce(coalesce(e.event_at,e.occurred_at)<now()-make_interval(days=>(pol.p->>'age_window_days')::integer)
   OR coalesce(e.event_at,e.occurred_at)<(SELECT at FROM last_read),false)
 FROM public.business_events e, pol
 WHERE p_job_id IS NOT NULL AND e.job_id=p_job_id AND e.id=ANY(coalesce(p_event_ids,'{}'::uuid[]))
 ORDER BY coalesce(e.event_at,e.occurred_at), e.id
$$;

-- 3. The job claim. Attribution and bucket keep one run a day. Extraction:
-- busy while a run is live, paused while a failed run waits on its retry or
-- the job is inside its cooldown, ceiling at the daily run limit, pacing in
-- the morning reserve; a failed or expired run is re-claimed in place; a new
-- run takes the next run_seq.
CREATE OR REPLACE FUNCTION public.claim_context_extraction_run(p_job_id uuid,p_run_date date,p_phase text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_extraction_runs; had_run boolean; v_lane text; c jsonb; lease interval;
BEGIN
 IF p_job_id IS NULL OR p_run_date IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date
 OR p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket') THEN
  RAISE EXCEPTION 'Invalid context run identity';
 END IF;
 v_lane := CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END;
 IF NOT public.automation_lane_enabled(v_lane) THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 lease:=make_interval(mins=>(public.context_cadence_policy()->>'run_lease_min')::integer);
 SELECT * INTO r FROM public.context_extraction_runs WHERE job_id=p_job_id AND run_date=p_run_date AND phase=p_phase
  ORDER BY run_seq DESC LIMIT 1 FOR UPDATE;
 had_run:=FOUND;
 IF p_phase<>'extraction' THEN
  IF had_run THEN
   IF r.status IN ('done','skipped') THEN RETURN jsonb_build_object('outcome','done','run',to_jsonb(r)); END IF;
   IF r.retry_at > now() THEN RETURN jsonb_build_object('outcome','paused','retry_at',r.retry_at,'run',to_jsonb(r)); END IF;
   IF r.status='running' AND r.lease_expires_at > now() THEN RETURN jsonb_build_object('outcome','busy','run',to_jsonb(r)); END IF;
   UPDATE public.context_extraction_runs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+lease,
     retry_at=NULL,finished_at=NULL,attempts=attempts+1 WHERE id=r.id RETURNING * INTO r;
  ELSE
   INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at)
    VALUES(p_job_id,p_run_date,p_phase,'running',gen_random_uuid(),now()+lease) RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('outcome','claimed','run',to_jsonb(r));
 END IF;
 c:=public.context_job_cadence(p_job_id);
 IF c IS NULL THEN RAISE EXCEPTION 'Invalid context run identity'; END IF;
 IF (c->>'run_live')::boolean THEN RETURN jsonb_build_object('outcome','busy','run',to_jsonb(r)); END IF;
 IF c->>'retry_at' IS NOT NULL THEN RETURN jsonb_build_object('outcome','paused','retry_at',(c->>'retry_at')::timestamptz,'reason','retry_wait'); END IF;
 IF (c->>'pacing_held')::boolean THEN RETURN jsonb_build_object('outcome','pacing','reason','pacing_reserve'); END IF;
 IF had_run AND r.status IN ('running','failed') THEN
  -- The same run again: its lease ran out, or its retry time has passed.
  UPDATE public.context_extraction_runs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+lease,
    retry_at=NULL,finished_at=NULL,attempts=attempts+1 WHERE id=r.id RETURNING * INTO r;
  RETURN jsonb_build_object('outcome','claimed','run',to_jsonb(r));
 END IF;
 IF (c->>'runs_today')::integer>=(c->>'run_limit')::integer THEN
  RETURN jsonb_build_object('outcome','ceiling','reason','daily_ceiling','runs_today',(c->>'runs_today')::integer,'run_limit',(c->>'run_limit')::integer);
 END IF;
 IF (c->>'cooldown_until')::timestamptz>now() THEN
  RETURN jsonb_build_object('outcome','paused','retry_at',(c->>'cooldown_until')::timestamptz,'reason','cooldown');
 END IF;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at,run_seq)
  VALUES(p_job_id,p_run_date,'extraction','running',gen_random_uuid(),now()+lease,coalesce(r.run_seq,0)+1) RETURNING * INTO r;
 RETURN jsonb_build_object('outcome','claimed','run',to_jsonb(r));
END $$;

-- S4: the worker renews the job lease before each model call.
CREATE OR REPLACE FUNCTION public.renew_context_extraction_run(p_run_id uuid,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.context_extraction_runs
 SET lease_expires_at=now()+make_interval(mins=>(public.context_cadence_policy()->>'run_lease_min')::integer)
 WHERE id=p_run_id AND lease_token=p_lease_token AND status='running' AND lease_expires_at>now();
 RETURN FOUND;
END $$;

-- 7. The tick lease (review M7): 5 minutes, any time of day, re-claimed every
-- tick. A running pass whose lease ran out is taken over and counted.
CREATE OR REPLACE FUNCTION public.claim_context_pass(p_run_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_pass_days; lease interval:=make_interval(mins=>(public.context_cadence_policy()->>'pass_lease_min')::integer);
BEGIN
 IF p_run_date IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF NOT (public.automation_lane_enabled('extraction') OR public.automation_lane_enabled('attribution')) THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM pg_advisory_xact_lock(20260911,2);
 SELECT * INTO r FROM public.context_pass_days WHERE run_date=p_run_date FOR UPDATE;
 IF FOUND THEN
  IF r.status='running' AND r.lease_expires_at>now() THEN RETURN jsonb_build_object('outcome','busy','pass',to_jsonb(r)); END IF;
  IF r.status<>'running' AND r.retry_at>now() THEN RETURN jsonb_build_object('outcome','paused','retry_at',r.retry_at,'pass',to_jsonb(r)); END IF;
  UPDATE public.context_pass_days SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+lease,retry_at=NULL,finished_at=NULL,
   lease_takeovers=lease_takeovers+CASE WHEN r.status='running' THEN 1 ELSE 0 END
   WHERE run_date=p_run_date RETURNING * INTO r;
 ELSE
  INSERT INTO public.context_pass_days(run_date,status,lease_token,lease_expires_at)
   VALUES(p_run_date,'running',gen_random_uuid(),now()+lease) RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('outcome','claimed','pass',to_jsonb(r),'lease_token',r.lease_token);
END $$;

-- Note d: the holder may renew or finish while it still holds the token.
CREATE OR REPLACE FUNCTION public.renew_context_pass(p_run_date date,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.context_pass_days SET lease_expires_at=now()+make_interval(mins=>(public.context_cadence_policy()->>'pass_lease_min')::integer)
 WHERE run_date=p_run_date AND lease_token=p_lease_token AND status='running';
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.finish_context_pass(p_run_date date,p_lease_token uuid,p_status text,p_retry_at timestamptz,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('done','failed','skipped') THEN RAISE EXCEPTION 'Invalid pass completion'; END IF;
 UPDATE public.context_pass_days SET status=p_status,finished_at=now(),retry_at=p_retry_at,error=p_error,lease_expires_at=NULL,
  runs=(SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=p_run_date)
 WHERE run_date=p_run_date AND lease_token=p_lease_token AND status='running';
 RETURN FOUND;
END $$;

-- 8. Freshness for one job (review M2, M3): what the dossier's freshness
-- section (K4) shows.
CREATE OR REPLACE FUNCTION public.context_job_freshness(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c jsonb; contact text; un_n integer; un_newest timestamptz; missing boolean; line text; unread integer; next_due timestamptz;
BEGIN
 c:=public.context_job_cadence(p_job_id);
 IF c IS NULL THEN RETURN NULL; END IF;
 SELECT nullif(btrim(j.ghl_contact_id),'') INTO contact FROM public.jobs j WHERE j.id=p_job_id;
 missing:=contact IS NULL;
 SELECT count(*), max(coalesce(u.event_at,u.occurred_at)) INTO un_n, un_newest FROM public.context_unplaced_for_job(p_job_id) u;
 unread:=coalesce((c->>'unread_count')::integer,0);
 next_due:=(c->>'next_due_at')::timestamptz;
 line:=CASE WHEN c->>'last_run_finished_at' IS NULL THEN 'No facts read yet'
  ELSE 'Facts current to '||to_char((c->>'last_run_finished_at')::timestamptz AT TIME ZONE 'Australia/Perth','DD Mon HH24:MI') END
  ||'; '||unread||CASE WHEN unread=1 THEN ' newer item' ELSE ' newer items' END||' not yet read'
  ||CASE WHEN next_due IS NOT NULL THEN ', next read due '||to_char(next_due AT TIME ZONE 'Australia/Perth','DD Mon HH24:MI')
     WHEN unread>0 AND c->>'blocked_reason' IS NOT NULL THEN ', held: '||replace(c->>'blocked_reason','_',' ')
     WHEN unread>0 AND (c->>'run_live')::boolean THEN ', being read now' ELSE '' END
  ||CASE WHEN missing THEN '; no contact on this job'
     ELSE '; '||un_n||CASE WHEN un_n=1 THEN ' message' ELSE ' messages' END||' from this customer not yet placed on any job' END;
 RETURN jsonb_build_object('job_id',p_job_id,
  'last_run_finished_at',c->'last_run_finished_at','unread_count',unread,'oldest_unread_landed_at',c->'oldest_unread_landed_at',
  'next_due_at',c->'next_due_at','runs_today',c->'runs_today','blocked_reason',c->'blocked_reason',
  'unplaced_for_contact',jsonb_build_object('count',un_n,'newest_at',un_newest),
  'contact_missing',missing,'line',line);
END $$;
COMMENT ON FUNCTION public.context_job_freshness(uuid) IS
 'K1 freshness for one job (cadence.md section 4): last read, unread count, next read due, blocked reason, this customer''s unplaced messages (context_unplaced_for_job) and a rendered line.';

-- 9. The cadence status block, read by the F1 composer.
CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_cadence_policy(); now_t timestamptz:=now(); today date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 lane boolean; attribution_lane boolean; calls integer; attribution_calls integer; judged jsonb; due_n integer; waiting_n integer;
 ceiling_n integer; pacing_n integer; oldest_unread timestamptz; oldest_wait numeric; breach boolean;
 runs integer; jobs_run integer; max_runs integer; takeovers integer; not_service integer; unplaced_n integer; oldest_unplaced timestamptz; alarms jsonb:='[]'::jsonb;
BEGIN
 lane:=public.automation_lane_enabled('extraction'); attribution_lane:=public.automation_lane_enabled('attribution');
 SELECT count(*), count(*) FILTER (WHERE phase='attribution') INTO calls, attribution_calls FROM public.context_model_call_reservations WHERE run_date=today;
 SELECT coalesce(jsonb_agg(x.cadence),'[]'::jsonb) INTO judged
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id))) x;
 SELECT count(*) FILTER (WHERE (c->>'due')::boolean),
  count(*) FILTER (WHERE NOT (c->>'due')::boolean AND (coalesce((c->>'waking_count')::integer,0)+coalesce((c->>'status_only_count')::integer,0))>0),
  count(*) FILTER (WHERE c->>'blocked_reason'='daily_ceiling'), count(*) FILTER (WHERE c->>'blocked_reason'='pacing_reserve'),
  min((c->>'order_at')::timestamptz),
  max(extract(epoch FROM now_t-(c->>'due_since')::timestamptz)/60) FILTER (WHERE (c->>'due')::boolean)
 INTO due_n, waiting_n, ceiling_n, pacing_n, oldest_unread, oldest_wait FROM jsonb_array_elements(judged) AS c;
 breach:=lane AND calls<(pol->>'model_call_cap')::integer AND coalesce(oldest_wait,0)>(pol->>'breach_wait_min')::integer;
 SELECT count(*), count(DISTINCT job_id), coalesce(max(n),0) INTO runs, jobs_run, max_runs
  FROM (SELECT job_id, count(*) OVER (PARTITION BY job_id) AS n FROM public.context_extraction_runs WHERE run_date=today AND phase='extraction') r;
 SELECT coalesce(sum(lease_takeovers),0) INTO takeovers FROM public.context_pass_days WHERE run_date=today;
 SELECT count(*) INTO not_service FROM public.business_events
  WHERE context_captured_at>now_t-interval '24 hours' AND metadata ? 'written_as' AND metadata->>'written_as'<>'service_role';
 SELECT count(*), min(coalesce(event_at,occurred_at)) INTO unplaced_n, oldest_unplaced FROM public.business_events WHERE attribution_status='unplaced';
 IF breach THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','cadence_breach','severity','warning',
   'since',now_t-make_interval(secs=>oldest_wait*60),'oldest_due_wait_minutes',round(oldest_wait),
   'what_to_do','A job has been due for a read for more than 90 minutes with the extraction lane on and model budget left. Check that the Luna context worker is running and ticking.'));
 END IF;
 RETURN jsonb_build_object('as_of',now_t,'policy',pol,
  'lanes',jsonb_build_object('extraction',lane,'attribution',attribution_lane),
  'due_jobs',due_n,'waiting_jobs',waiting_n,'oldest_unread_landed_at',oldest_unread,
  'oldest_due_wait_minutes',CASE WHEN oldest_wait IS NULL THEN NULL ELSE round(oldest_wait) END,'cadence_breach',breach,
  'runs_today',runs,'jobs_run_today',jobs_run,'max_runs_one_job_today',max_runs,
  'jobs_at_daily_ceiling',ceiling_n,'pacing_held_jobs',pacing_n,'lease_takeovers_today',takeovers,
  'model_calls_today',calls,'attribution_calls_today',attribution_calls,
  'unplaced_count',unplaced_n,'oldest_unplaced_at',oldest_unplaced,
  'rows_not_service_role_24h',not_service,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_cadence_status() IS
 'Status block cadence, owned by cadence slice K1 (cadence.md 9.A item 9). Due and waiting jobs from context_job_cadence, runs today, ceiling and pacing holds, lease takeovers, unplaced rows, rows not written as service_role, and the cadence_breach alarm.';

-- 13. Grants: no PUBLIC, anon or authenticated execute; service_role only.
-- attribute_business_event is a trigger function and is not callable.
REVOKE ALL ON FUNCTION
 public.context_cadence_policy(),public.context_request_role(),public.context_event_status_only(public.business_events),
 public.context_unread_rows(uuid[]),public.context_unread_events(uuid),public.context_event_is_ours(public.business_events),
 public.context_jobs_cadence(uuid[]),public.context_job_cadence(uuid),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_ready_jobs_count(integer),
 public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[]),
 public.claim_context_extraction_run(uuid,date,text),public.renew_context_extraction_run(uuid,uuid),
 public.claim_context_pass(date),public.renew_context_pass(date,uuid),public.finish_context_pass(date,uuid,text,timestamptz,text),
 public.context_job_freshness(uuid),public.context_cadence_status(),public.attribute_business_event()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_cadence_policy(),public.context_request_role(),public.context_event_status_only(public.business_events),
 public.context_unread_rows(uuid[]),public.context_unread_events(uuid),public.context_event_is_ours(public.business_events),
 public.context_jobs_cadence(uuid[]),public.context_job_cadence(uuid),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_ready_jobs_count(integer),
 public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[]),
 public.claim_context_extraction_run(uuid,date,text),public.renew_context_extraction_run(uuid,uuid),
 public.claim_context_pass(date),public.renew_context_pass(date,uuid),public.finish_context_pass(date,uuid,text,timestamptz,text),
 public.context_job_freshness(uuid),public.context_cadence_status()
TO service_role;
