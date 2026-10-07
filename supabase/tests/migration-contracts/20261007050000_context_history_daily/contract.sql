-- History daily (20261007050000) behaviour contract. Every fixture write is
-- rolled back. Job numbers start HD-; contact ids are synthetic GHL-shaped
-- ids. Each fixture transaction first takes every other job out of the live
-- set (status complete) and clears the CRM ledgers, so earlier contracts'
-- fixtures never reach the lead rule, the CRM list or the Xero plan. Every
-- time is relative to the transaction's now(); rows written inside it get
-- their capture time pinned, so nothing depends on the wall clock.
--   1. Hardening, grants, the policy's numbers and the lane list.
--   2. The lead rule, inline: the 28-day edge, the newer of the newest quote
--      send and the customer's newest message, a message from someone else,
--      progress past quoted, a quote never sent, archived flags.
--   3. The lead rule's own function, once merged, decides; one of another
--      shape is not read; one that fails leaves the inline rule deciding.
--   4. The CRM load list: every monitored live job on it; M4's rows unchanged
--      (the 24 Sep ruling's quotes kept); never a closed or holding job.
--   5. The read: loaded, tried with no contact, missing (each reason), only
--      monitored live jobs, p_job_ids, the summary.
--   6. The daily Xero top-up: idle with the capture lane off; writes the
--      missing rows once with its run row and the keys it wrote; the next day
--      writes nothing; a batch limit leaves a partial run; a failed writer
--      leaves a failed run and nothing written; the status read.
--   7. The schedule on pg_cron stand-ins: created gated, once, on a re-apply.

CREATE FUNCTION pg_temp.hd_id(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('a1d00000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.hd_scope() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.jobs SET status = 'complete' WHERE job_number IS NULL OR job_number NOT LIKE 'HD-%';
 DELETE FROM public.context_ghl_history_contacts;
 DELETE FROM public.context_ghl_history_link_attempts;
END $$;
CREATE FUNCTION pg_temp.hd_job(p_n integer, p_status text, p_contact text DEFAULT NULL, p_archived boolean DEFAULT false,
 p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.hd_id(p_n);
BEGIN
 INSERT INTO public.jobs(id, org_id, status, type, job_number, ghl_contact_id, archived, metadata, created_at, updated_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', p_status, 'fencing', 'HD-' || lpad(p_n::text, 2, '0'), p_contact, p_archived,
         p_metadata, now() - interval '120 days', now() - interval '120 days');
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.hd_quote(p_n integer, p_sent_ago interval) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.job_documents(job_id, type, sent_at, file_name) VALUES (pg_temp.hd_id(p_n), 'quote', now() - p_sent_ago, 'hd-quote.pdf') $$;
-- An inbound text or email on the job, captured when it happened.
CREATE FUNCTION pg_temp.hd_in(p_n integer, p_contact text, p_channel text, p_ago interval) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id, match_method, direction, event_type, source, channel, contact_id, payload, occurred_at, event_at, metadata)
 VALUES (pg_temp.hd_id(p_n), 'direct_job_id', 'inbound', CASE WHEN p_channel = 'email' THEN 'client.email_in' ELSE 'client.sms_in' END,
         'hd_contract', p_channel, p_contact, jsonb_build_object('body', 'hd message'), now() - p_ago, now() - p_ago,
         jsonb_build_object('capture_mode', 'live'))
 RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at = now() - p_ago, recorded_at = now() - p_ago WHERE id = new_id;
 RETURN new_id;
END $$;
CREATE FUNCTION pg_temp.hd_run(p_source text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
 r := public.record_capture_run(jsonb_build_object('source', p_source, 'status', 'succeeded', 'cursor', jsonb_build_object('v', 1, 'actor', 'hd-test')));
 RETURN (r->>'run_id')::uuid;
END $$;
CREATE FUNCTION pg_temp.hd_contact(p_contact text, p_status text, p_job_ids uuid[] DEFAULT '{}') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id', p_contact, 'run_id', pg_temp.hd_run('ghl_history_load'),
  'status', p_status, 'jobs', cardinality(p_job_ids), 'job_ids', to_jsonb(p_job_ids), 'actor', 'hd-test',
  'error_code', CASE WHEN p_status = 'failed' THEN 'provider_request_failed' END,
  'resume', CASE WHEN p_status = 'partial' THEN jsonb_build_object('page', 2) END));
END $$;
CREATE FUNCTION pg_temp.hd_link(p_n integer, p_verdict text, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id', pg_temp.hd_id(p_n), 'run_id', pg_temp.hd_run('ghl_history_link'),
  'verdict', p_verdict, 'reason', p_reason, 'actor', 'hd-test'));
END $$;
-- The twenty jobs every section reads (comment: what each one is for).
CREATE FUNCTION pg_temp.hd_fixtures() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- The lead-rule PR's own function, once it is in the stack, is set aside
 -- inside this rolled-back transaction so the inline rule can be proved;
 -- section 3 proves the hand-over to a function of that shape.
 DROP FUNCTION IF EXISTS public.context_lead_monitored(uuid, timestamptz);
 PERFORM pg_temp.hd_scope();
 PERFORM pg_temp.hd_job(1, 'quoted', 'HDc0000001');            -- quote sent 40 days ago, no reply: not monitored
 PERFORM pg_temp.hd_quote(1, interval '40 days');
 PERFORM pg_temp.hd_job(2, 'quoted', 'HDc0000002');            -- sent 40 days ago, the customer texted 10 days ago: monitored
 PERFORM pg_temp.hd_quote(2, interval '40 days');
 PERFORM pg_temp.hd_in(2, 'HDc0000002', 'sms', interval '10 days');
 PERFORM pg_temp.hd_job(3, 'quoted');                          -- sent 40 days ago, mail from someone else 10 days ago: not monitored
 PERFORM pg_temp.hd_quote(3, interval '40 days');
 PERFORM pg_temp.hd_in(3, NULL, 'email', interval '10 days');
 PERFORM pg_temp.hd_job(4, 'quoted');                          -- sent 10 days ago: monitored
 PERFORM pg_temp.hd_quote(4, interval '10 days');
 PERFORM pg_temp.hd_job(5, 'quoted');                          -- a quote never sent starts no clock: monitored
 PERFORM pg_temp.hd_job(6, 'quoted');                          -- sent 40 days ago, accepted 35 days ago: monitored
 PERFORM pg_temp.hd_quote(6, interval '40 days');
 UPDATE public.jobs SET accepted_at = now() - interval '35 days' WHERE id = pg_temp.hd_id(6);
 PERFORM pg_temp.hd_job(7, 'quoted', 'bad contact');           -- quoted 50 days ago, re-sent by the app 20 days ago: monitored
 UPDATE public.jobs SET quoted_at = now() - interval '50 days' WHERE id = pg_temp.hd_id(7);
 INSERT INTO public.job_events(id, job_id, event_type, created_at) VALUES (gen_random_uuid(), pg_temp.hd_id(7), 'quote_sent', now() - interval '20 days');
 PERFORM pg_temp.hd_job(8, 'quoted');                          -- sent exactly 28 days ago: not monitored
 PERFORM pg_temp.hd_quote(8, interval '28 days');
 PERFORM pg_temp.hd_job(9, 'quoted', 'HDc0000009', true);      -- archived flag, sent 70 days ago, texted 5 days ago: monitored
 PERFORM pg_temp.hd_quote(9, interval '70 days');
 PERFORM pg_temp.hd_in(9, 'HDc0000009', 'sms', interval '5 days');
 PERFORM pg_temp.hd_job(10, 'invoiced', 'HDc0000010');         -- past quoted (not on M4's allow-list): monitored
 PERFORM pg_temp.hd_job(11, 'get_review', 'HDc0000011');
 PERFORM pg_temp.hd_job(12, 'scheduled', 'HDc0000012');        -- on M4's allow-list
 PERFORM pg_temp.hd_job(13, 'in_progress', 'HDc0000013', true);-- archived flag, on site
 PERFORM pg_temp.hd_job(14, 'quoted');                         -- sent 45 days ago: not monitored, inside the 24 Sep 60 days
 PERFORM pg_temp.hd_quote(14, interval '45 days');
 PERFORM pg_temp.hd_job(15, 'complete');                       -- not live
 PERFORM pg_temp.hd_job(16, 'draft');                          -- not live; a draft with a quote sent 10 days ago is on M4's list
 PERFORM pg_temp.hd_quote(16, interval '10 days');
 PERFORM pg_temp.hd_job(17, 'scheduled', NULL, false, '{"do_not_schedule": true}');  -- a live holding job
 PERFORM pg_temp.hd_job(18, 'cancelled');                      -- not live, never on the list
 PERFORM pg_temp.hd_quote(18, interval '10 days');
 PERFORM pg_temp.hd_job(19, 'quoted');                         -- sent 90 days ago: not monitored, off the list
 PERFORM pg_temp.hd_quote(19, interval '90 days');
 PERFORM pg_temp.hd_job(20, 'accepted');
 -- The CRM ledgers.
 PERFORM pg_temp.hd_contact('HDc0000002', 'done', ARRAY[pg_temp.hd_id(2)]);
 PERFORM pg_temp.hd_contact('HDc0000010', 'done');             -- done through another job: the job id is not on the row
 PERFORM pg_temp.hd_contact('HDc0000011', 'partial', ARRAY[pg_temp.hd_id(11)]);
 PERFORM pg_temp.hd_contact('HDc0000012', 'done', ARRAY[pg_temp.hd_id(12)]);
 PERFORM pg_temp.hd_contact('HDc0000013', 'failed', ARRAY[pg_temp.hd_id(13)]);
 PERFORM pg_temp.hd_link(4, 'none', 'not_in_ghl');
 PERFORM pg_temp.hd_link(5, 'failed', 'provider_request_failed');
 PERFORM pg_temp.hd_link(20, 'ambiguous', 'own_records_several');
END $$;
-- M4's list, verbatim (md5 49eb23015b724a29058c11b2743954bf), to prove its rows are unchanged.
CREATE FUNCTION pg_temp.hd_m4_live_jobs()
RETURNS TABLE(job_id uuid, job_number text, ghl_contact_id text, status text, live_basis text, tier integer, activity_at timestamptz)
LANGUAGE sql STABLE AS $$
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
CREATE FUNCTION pg_temp.hd_monitored() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT string_agg(m.job_number || ':' || CASE WHEN m.monitored THEN 'on' ELSE 'off' END, ',' ORDER BY m.job_number COLLATE "C")
 FROM public.context_history_monitored_jobs(now()) m WHERE m.job_number LIKE 'HD-%' $$;

BEGIN;
-- 1. Hardening: service side only, fixed search_path, the slice name first in
-- every comment; the cron caller callable by the cron owner only.
DO $$
DECLARE f regprocedure; pol jsonb := public.context_history_daily_policy();
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_history_daily_policy()', 'public.context_history_monitored_jobs(timestamptz,uuid[])',
  'public.context_history_crm_jobs(uuid[])', 'public.context_history_crm_summary()', 'public.context_history_xero_daily_status()',
  'public.context_ghl_history_live_jobs()', 'public.trigger_xero_history_daily(integer)']::regprocedure[] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('public', f, 'EXECUTE') THEN RAISE EXCEPTION 'hd public execute on %', f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = f) IS NULL THEN RAISE EXCEPTION 'hd % has no fixed search_path', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_history_daily_policy()', 'public.context_history_monitored_jobs(timestamptz,uuid[])',
  'public.context_history_crm_jobs(uuid[])', 'public.context_history_crm_summary()', 'public.context_history_xero_daily_status()',
  'public.trigger_xero_history_daily(integer)']::regprocedure[] LOOP
  IF coalesce(obj_description(f, 'pg_proc'), '') NOT LIKE 'History daily (20261007050000):%' THEN RAISE EXCEPTION 'hd comment of %', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_history_daily_policy()', 'public.context_history_monitored_jobs(timestamptz,uuid[])',
  'public.context_history_crm_jobs(uuid[])', 'public.context_history_crm_summary()', 'public.context_history_xero_daily_status()',
  'public.context_ghl_history_live_jobs()']::regprocedure[] LOOP
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN RAISE EXCEPTION 'hd service_role cannot execute %', f; END IF;
 END LOOP;
 IF has_function_privilege('service_role', 'public.trigger_xero_history_daily(integer)', 'EXECUTE')
  OR NOT has_function_privilege('postgres', 'public.trigger_xero_history_daily(integer)', 'EXECUTE')
 THEN RAISE EXCEPTION 'hd the cron caller must be callable by the cron owner only'; END IF;
 IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.context_ghl_history_live_jobs()'::regprocedure)
  OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_ghl_history_live_jobs()'::regprocedure) <> 's'
 THEN RAISE EXCEPTION 'hd the CRM list must stay a stable security definer read'; END IF;
 -- The numbers, in one place.
 IF pol->>'xero_cron_jobname' <> 'xero-history-daily' OR pol->>'xero_cron_schedule' <> '30 19 * * *'
  OR pol->>'xero_run_source' <> 'xero_history_daily' OR pol->'xero_batch_limit' <> '500' OR pol->'lead_cutoff_days' <> '28'
  OR pol->>'lead_rule_inline' <> 'inline_20261007050000'
  OR pol->>'xero_cron_command' <> 'SELECT public.trigger_xero_history_daily() WHERE public.automation_lane_enabled(''capture'')'
 THEN RAISE EXCEPTION 'hd policy %', pol; END IF;
 -- The capture lane owns the new job; every earlier row is still there.
 IF NOT (SELECT array_agg(cron_jobname || ':' || lane ORDER BY cron_jobname COLLATE "C") FROM public.automation_switch_cron_lanes())
    @> ARRAY['contact-matching:attribution', 'context-document-text:capture', 'ghl-call-transcript-fetch:capture', 'ghl-history-schedule:capture',
             'ghl-message-reconcile:capture', 'monitor-inbox-poll:capture', 'monitor-inbox-sweep:capture', 'outlook-mail-poll:capture',
             'xero-history-daily:capture']
 THEN RAISE EXCEPTION 'hd cron lane list %', (SELECT array_agg(to_jsonb(l)) FROM public.automation_switch_cron_lanes() l); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. The lead rule, inline.
SELECT pg_temp.hd_fixtures();
DO $$
DECLARE got text; rec record;
BEGIN
 got := pg_temp.hd_monitored();
 IF got IS DISTINCT FROM 'HD-01:off,HD-02:on,HD-03:off,HD-04:on,HD-05:on,HD-06:on,HD-07:on,HD-08:off,HD-09:on,HD-10:on,HD-11:on,HD-12:on,HD-13:on,HD-14:off,HD-17:on,HD-19:off,HD-20:on'
 THEN RAISE EXCEPTION 'hd lead rule: %', got; END IF;
 -- Every live job once, in job id order, judged by the inline rule.
 IF EXISTS (SELECT 1 FROM public.context_history_monitored_jobs(now()) m WHERE m.rule <> 'inline_20261007050000' OR m.inline_monitored IS DISTINCT FROM m.monitored)
  OR (SELECT array_agg(m.job_id) FROM public.context_history_monitored_jobs(now()) m)
     IS DISTINCT FROM (SELECT array_agg(jb.id ORDER BY jb.id) FROM public.jobs jb WHERE jb.job_number LIKE 'HD-%' AND jb.status NOT IN ('complete', 'draft', 'cancelled'))
 THEN RAISE EXCEPTION 'hd lead rule rows'; END IF;
 -- The dates it judged by.
 SELECT * INTO rec FROM public.context_history_monitored_jobs(now()) x WHERE x.job_id = pg_temp.hd_id(1);
 IF NOT rec.lead OR rec.quote_last_sent_at <> now() - interval '40 days' OR rec.customer_last_inbound_at IS NOT NULL
  OR rec.cutoff_at <> now() - interval '40 days' + interval '28 days' THEN RAISE EXCEPTION 'hd lead HD-01 %', to_jsonb(rec); END IF;
 SELECT * INTO rec FROM public.context_history_monitored_jobs(now()) x WHERE x.job_id = pg_temp.hd_id(2);
 IF rec.customer_last_inbound_at <> now() - interval '10 days' OR rec.cutoff_at <> now() - interval '10 days' + interval '28 days'
 THEN RAISE EXCEPTION 'hd lead HD-02 %', to_jsonb(rec); END IF;
 SELECT * INTO rec FROM public.context_history_monitored_jobs(now()) x WHERE x.job_id = pg_temp.hd_id(3);
 IF rec.customer_last_inbound_at IS NOT NULL THEN RAISE EXCEPTION 'hd lead HD-03: a message from someone else is not the customer''s %', to_jsonb(rec); END IF;
 SELECT * INTO rec FROM public.context_history_monitored_jobs(now()) x WHERE x.job_id = pg_temp.hd_id(5);
 IF NOT rec.lead OR rec.quote_last_sent_at IS NOT NULL OR rec.cutoff_at IS NOT NULL THEN RAISE EXCEPTION 'hd lead HD-05 %', to_jsonb(rec); END IF;
 SELECT * INTO rec FROM public.context_history_monitored_jobs(now()) x WHERE x.job_id = pg_temp.hd_id(6);
 IF rec.lead THEN RAISE EXCEPTION 'hd lead HD-06: an accepted quote is past quoted %', to_jsonb(rec); END IF;
 SELECT * INTO rec FROM public.context_history_monitored_jobs(now()) x WHERE x.job_id = pg_temp.hd_id(7);
 IF rec.quote_last_sent_at <> now() - interval '20 days' THEN RAISE EXCEPTION 'hd lead HD-07: the newest send %', to_jsonb(rec); END IF;
 SELECT * INTO rec FROM public.context_history_monitored_jobs(now()) x WHERE x.job_id = pg_temp.hd_id(10);
 IF rec.lead OR rec.quote_last_sent_at IS NOT NULL OR rec.cutoff_at IS NOT NULL THEN RAISE EXCEPTION 'hd lead HD-10 %', to_jsonb(rec); END IF;
 -- p_job_ids narrows; a job that is not live has no row.
 IF (SELECT string_agg(x.job_number, ',' ORDER BY x.job_number COLLATE "C")
     FROM public.context_history_monitored_jobs(now(), ARRAY[pg_temp.hd_id(1), pg_temp.hd_id(15), pg_temp.hd_id(20)]) x) IS DISTINCT FROM 'HD-01,HD-20'
 THEN RAISE EXCEPTION 'hd lead rule p_job_ids'; END IF;
 -- As of 30 days ago HD-01's quote was 10 days old: monitored then.
 IF NOT (SELECT x.monitored FROM public.context_history_monitored_jobs(now() - interval '30 days', ARRAY[pg_temp.hd_id(1)]) x)
 THEN RAISE EXCEPTION 'hd lead rule as of a past instant'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3a. The lead-rule PR's function, in the shape read here, decides.
SELECT pg_temp.hd_fixtures();
CREATE FUNCTION public.context_lead_monitored(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, monitored boolean, lead boolean) LANGUAGE sql STABLE AS $$
 SELECT jb.id, jb.job_number NOT IN ('HD-02', 'HD-12'), true FROM public.jobs jb WHERE jb.id = p_job_id AND jb.job_number <> 'HD-20' $$;
DO $$
DECLARE got text;
BEGIN
 got := pg_temp.hd_monitored();
 -- HD-02 and HD-12 off by the function; HD-01, HD-03, HD-08, HD-14 and HD-19 on by it; HD-20 has no row from it: on.
 IF got IS DISTINCT FROM 'HD-01:on,HD-02:off,HD-03:on,HD-04:on,HD-05:on,HD-06:on,HD-07:on,HD-08:on,HD-09:on,HD-10:on,HD-11:on,HD-12:off,HD-13:on,HD-14:on,HD-17:on,HD-19:on,HD-20:on'
 THEN RAISE EXCEPTION 'hd delegated lead rule: %', got; END IF;
 IF EXISTS (SELECT 1 FROM public.context_history_monitored_jobs(now()) m WHERE m.rule <> 'context_lead_monitored')
  OR (SELECT m.inline_monitored FROM public.context_history_monitored_jobs(now()) m WHERE m.job_id = pg_temp.hd_id(1))
 THEN RAISE EXCEPTION 'hd delegated rule name or the inline answer beside it'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3b. A function of another shape is not read.
SELECT pg_temp.hd_fixtures();
CREATE FUNCTION public.context_lead_monitored(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, followed boolean) LANGUAGE sql STABLE AS $$ SELECT p_job_id, false $$;
DO $$
BEGIN
 IF pg_temp.hd_monitored() IS DISTINCT FROM 'HD-01:off,HD-02:on,HD-03:off,HD-04:on,HD-05:on,HD-06:on,HD-07:on,HD-08:off,HD-09:on,HD-10:on,HD-11:on,HD-12:on,HD-13:on,HD-14:off,HD-17:on,HD-19:off,HD-20:on'
  OR EXISTS (SELECT 1 FROM public.context_history_monitored_jobs(now()) m WHERE m.rule <> 'inline_20261007050000')
 THEN RAISE EXCEPTION 'hd a lead function of another shape must not decide'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3c. One that fails leaves the inline rule deciding, with a warning.
SELECT pg_temp.hd_fixtures();
CREATE FUNCTION public.context_lead_monitored(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, monitored boolean) LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'hd lead rule down'; END $$;
DO $$
BEGIN
 IF pg_temp.hd_monitored() IS DISTINCT FROM 'HD-01:off,HD-02:on,HD-03:off,HD-04:on,HD-05:on,HD-06:on,HD-07:on,HD-08:off,HD-09:on,HD-10:on,HD-11:on,HD-12:on,HD-13:on,HD-14:off,HD-17:on,HD-19:off,HD-20:on'
  OR EXISTS (SELECT 1 FROM public.context_history_monitored_jobs(now()) m WHERE m.rule <> 'inline_20261007050000_fallback')
 THEN RAISE EXCEPTION 'hd a failing lead function must leave the inline rule deciding'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. The CRM load list.
SELECT pg_temp.hd_fixtures();
DO $$
DECLARE got text; missing text; o5 jsonb; o19 jsonb;
BEGIN
 -- Every monitored live job is on it, a holding job aside (owner, 7 Oct 2026).
 SELECT string_agg(m.job_number, ',' ORDER BY m.job_number COLLATE "C") INTO missing
 FROM public.context_history_monitored_jobs(now()) m JOIN public.jobs jb ON jb.id = m.job_id
 WHERE m.monitored AND coalesce(jb.metadata->>'do_not_schedule', '') NOT IN ('true', '1')
  AND NOT EXISTS (SELECT 1 FROM public.context_ghl_history_live_jobs() l WHERE l.job_id = m.job_id);
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'hd scope: a monitored live job is outside the CRM load: %', missing; END IF;
 -- The whole list, with why each job is on it and its tier.
 SELECT string_agg(l.job_number || ':' || l.live_basis || ':' || l.tier, ',' ORDER BY l.job_number COLLATE "C") INTO got
 FROM public.context_ghl_history_live_jobs() l WHERE l.job_number LIKE 'HD-%';
 IF got IS DISTINCT FROM 'HD-01:quote_sent:4,HD-02:quote_sent:4,HD-03:quote_sent:4,HD-04:quote_sent:4,HD-05:lead_monitored:4,HD-06:quote_sent:4,HD-07:lead_monitored:4,HD-08:quote_sent:4,HD-09:lead_monitored:4,HD-10:status:3,HD-11:status:3,HD-12:status:2,HD-13:status:1,HD-14:quote_sent:4,HD-16:quote_sent:4,HD-20:status:3'
 THEN RAISE EXCEPTION 'hd scope list: %', got; END IF;
 -- M4's rows are unchanged, every column (the 24 Sep ruling's quotes, HD-01, HD-08 and HD-14, kept).
 IF EXISTS (SELECT * FROM pg_temp.hd_m4_live_jobs() WHERE job_number LIKE 'HD-%'
            EXCEPT SELECT * FROM public.context_ghl_history_live_jobs())
  OR (SELECT count(*) FROM pg_temp.hd_m4_live_jobs() WHERE job_number LIKE 'HD-%') <> 10
 THEN RAISE EXCEPTION 'hd scope: M4''s rows changed'; END IF;
 -- One row per job; the contact as the job carries it.
 IF (SELECT count(*) FROM public.context_ghl_history_live_jobs() l WHERE l.job_number LIKE 'HD-%')
    <> (SELECT count(DISTINCT l.job_id) FROM public.context_ghl_history_live_jobs() l WHERE l.job_number LIKE 'HD-%')
  OR (SELECT l.ghl_contact_id FROM public.context_ghl_history_live_jobs() l WHERE l.job_id = pg_temp.hd_id(7)) IS DISTINCT FROM 'bad contact'
  OR (SELECT l.ghl_contact_id FROM public.context_ghl_history_live_jobs() l WHERE l.job_id = pg_temp.hd_id(5)) IS NOT NULL
 THEN RAISE EXCEPTION 'hd scope rows'; END IF;
 -- The link step's "still live" check and due list follow it: HD-06 (no
 -- contact, never tried) is due; the holding job never is.
 IF NOT EXISTS (SELECT 1 FROM public.context_ghl_history_link_due(500) d WHERE d.job_id = pg_temp.hd_id(6))
  OR EXISTS (SELECT 1 FROM public.context_ghl_history_link_due(500) d WHERE d.job_id = pg_temp.hd_id(17))
 THEN RAISE EXCEPTION 'hd scope: the link step does not follow the list'; END IF;
 -- The link writer's "still live" check follows it too: a quote never sent
 -- (added by the lead rule) links; a stale quote off the list is refused.
 -- (One statement each: a later read sees the write.)
 o5 := public.link_job_ghl_contact(jsonb_build_object('job_id', pg_temp.hd_id(5), 'contact_id', 'HDc0000005', 'key_kind', 'phone',
  'run_id', pg_temp.hd_run('ghl_history_link'), 'actor', 'hd-test', 'phone_key', NULL, 'email_key', NULL));
 o19 := public.link_job_ghl_contact(jsonb_build_object('job_id', pg_temp.hd_id(19), 'contact_id', 'HDc0000019', 'key_kind', 'phone',
  'run_id', pg_temp.hd_run('ghl_history_link'), 'actor', 'hd-test', 'phone_key', NULL, 'email_key', NULL));
 IF o5->>'outcome' IS DISTINCT FROM 'linked' OR o19->>'outcome' IS DISTINCT FROM 'not_live'
  OR (SELECT ghl_contact_id FROM public.jobs WHERE id = pg_temp.hd_id(5)) IS DISTINCT FROM 'HDc0000005'
  OR (SELECT ghl_contact_id FROM public.jobs WHERE id = pg_temp.hd_id(19)) IS NOT NULL
 THEN RAISE EXCEPTION 'hd scope: the link writer''s live check does not follow the list: % %', o5, o19; END IF;
END $$;
-- Under the merged lead rule the list follows it too.
CREATE FUNCTION public.context_lead_monitored(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, monitored boolean) LANGUAGE sql STABLE AS $$
 SELECT jb.id, jb.job_number <> 'HD-05' FROM public.jobs jb WHERE jb.id = p_job_id $$;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.context_ghl_history_live_jobs() l WHERE l.job_id = pg_temp.hd_id(19) AND l.live_basis = 'lead_monitored')
  OR EXISTS (SELECT 1 FROM public.context_ghl_history_live_jobs() l WHERE l.job_id = pg_temp.hd_id(5))
 THEN RAISE EXCEPTION 'hd scope under the merged lead rule'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. The read for the scorecard v2.
SELECT pg_temp.hd_fixtures();
DO $$
DECLARE got text; s jsonb;
BEGIN
 SELECT string_agg(c.job_number || ':' || c.crm_state || ':' || c.reason, ',' ORDER BY c.job_number COLLATE "C") INTO got
 FROM public.context_history_crm_jobs() c WHERE c.job_number LIKE 'HD-%';
 IF got IS DISTINCT FROM 'HD-02:loaded:contact_history_done,HD-04:tried_no_contact:not_in_ghl,HD-05:missing:link_failed,HD-06:missing:link_not_tried,HD-07:missing:invalid_contact_id,HD-09:missing:history_not_started,HD-10:loaded:contact_history_done,HD-11:missing:history_partial,HD-12:loaded:contact_history_done,HD-13:missing:history_failed,HD-17:missing:holding_job,HD-20:tried_no_contact:own_records_several'
 THEN RAISE EXCEPTION 'hd crm read: %', got; END IF;
 IF EXISTS (SELECT 1 FROM public.context_history_crm_jobs() c WHERE c.in_load_scope IS DISTINCT FROM (c.job_number <> 'HD-17')
            OR c.lead_rule <> 'inline_20261007050000')
  OR (SELECT array_agg(c.job_id) FROM public.context_history_crm_jobs() c)
     IS DISTINCT FROM (SELECT array_agg(c.job_id ORDER BY c.job_id) FROM public.context_history_crm_jobs() c)
 THEN RAISE EXCEPTION 'hd crm read: load scope, rule or order'; END IF;
 IF (SELECT row(c.ghl_contact_id, c.contact_history, c.link_verdict) FROM public.context_history_crm_jobs() c WHERE c.job_id = pg_temp.hd_id(11))
    IS DISTINCT FROM row('HDc0000011'::text, 'partial'::text, NULL::text)
  OR (SELECT row(c.link_verdict, c.link_reason) FROM public.context_history_crm_jobs() c WHERE c.job_id = pg_temp.hd_id(20))
    IS DISTINCT FROM row('ambiguous'::text, 'own_records_several'::text)
  OR (SELECT c.contact_completed_at IS NULL FROM public.context_history_crm_jobs() c WHERE c.job_id = pg_temp.hd_id(10))
 THEN RAISE EXCEPTION 'hd crm read: detail columns'; END IF;
 -- p_job_ids: only monitored live jobs come back.
 IF (SELECT string_agg(c.job_number, ',' ORDER BY c.job_number COLLATE "C")
     FROM public.context_history_crm_jobs(ARRAY[pg_temp.hd_id(1), pg_temp.hd_id(2), pg_temp.hd_id(15)]) c) IS DISTINCT FROM 'HD-02'
 THEN RAISE EXCEPTION 'hd crm read p_job_ids'; END IF;
 s := public.context_history_crm_summary();
 IF s->'live_jobs' <> '17' OR s->'monitored_jobs' <> '12' OR s->'not_monitored_jobs' <> '5' OR s->'loaded' <> '3'
  OR s->'tried_no_contact' <> '2' OR s->'missing' <> '7' OR s->'done' <> '5' OR s->'done_pct' <> '41.7'
  OR s->'monitored_outside_load_scope' <> '1' OR s->'load_scope_jobs' <> '16' OR s->>'lead_rule' <> 'inline_20261007050000'
  OR s->'missing_by_reason' <> '{"holding_job": 1, "link_failed": 1, "history_failed": 1, "link_not_tried": 1, "history_partial": 1, "invalid_contact_id": 1, "history_not_started": 1}'::jsonb
  OR s->'tried_by_reason' <> '{"not_in_ghl": 1, "own_records_several": 1}'::jsonb
 THEN RAISE EXCEPTION 'hd crm summary %', s; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. The daily Xero top-up.
SELECT pg_temp.hd_scope();
SELECT pg_temp.hd_job(31, 'scheduled');
SELECT pg_temp.hd_job(32, 'processing');
SELECT pg_temp.hd_job(33, 'complete');
SELECT pg_temp.hd_job(34, 'scheduled');
INSERT INTO public.xero_invoices(id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due, amount_paid,
 invoice_date, due_date, fully_paid_on, job_id, reference, updated_at) VALUES
 ('a1d00000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'hd-xid-1', 'INV-HD1', 'ACCREC', 'AUTHORISED', 550, 550, 0,
  '2026-09-20', '2026-10-04', NULL, pg_temp.hd_id(31), 'HD-31', '2026-09-20'),
 ('a1d00000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'hd-xid-2', 'INV-HD2', 'ACCREC', 'PAID', 1100, 0, 1100,
  '2026-09-01', '2026-09-15', '2026-09-10', pg_temp.hd_id(32), 'HD-32', '2026-09-10'),
 ('a1d00000-0000-4000-8000-0000000000b3', '00000000-0000-0000-0000-000000000001', 'hd-xid-3', 'INV-HD3', 'ACCREC', 'PAID', 300, 0, 300,
  '2026-09-02', NULL, '2026-09-12', pg_temp.hd_id(33), 'HD-33', '2026-09-12'),
 ('a1d00000-0000-4000-8000-0000000000b4', '00000000-0000-0000-0000-000000000001', 'hd-xid-4', 'INV-HD4', 'ACCREC', 'VOIDED', 200, 0, 0,
  '2026-09-03', NULL, NULL, pg_temp.hd_id(34), 'HD-34', '2026-09-03');
DO $$
DECLARE r jsonb; run record; want text[] := ARRAY['xero:invoice:hd-xid-1:authorised', 'xero:invoice:hd-xid-1:raised',
 'xero:invoice:hd-xid-2:authorised', 'xero:invoice:hd-xid-2:paid', 'xero:invoice:hd-xid-2:raised'];
BEGIN
 IF (SELECT array_agg(p.provider_message_id ORDER BY p.provider_message_id COLLATE "C") FROM public.context_xero_evidence_backfill_plan() p) IS DISTINCT FROM want
 THEN RAISE EXCEPTION 'hd xero fixture plan %', (SELECT array_agg(p.provider_message_id) FROM public.context_xero_evidence_backfill_plan() p); END IF;
 -- The capture lane off: idle, no run row, nothing written.
 UPDATE public.automation_switches SET capture = false WHERE id = 1;
 r := public.trigger_xero_history_daily();
 IF r->>'outcome' <> 'capture_off' OR EXISTS (SELECT 1 FROM public.context_capture_runs c WHERE c.source = 'xero_history_daily')
  OR (SELECT count(*) FROM public.context_xero_evidence_backfill_plan()) <> 5 THEN RAISE EXCEPTION 'hd xero lane off %', r; END IF;
 UPDATE public.automation_switches SET capture = true WHERE id = 1;
 -- The first day: every missing row once, through the one writer, and one run row naming them.
 r := public.trigger_xero_history_daily();
 IF r->>'outcome' <> 'ran' OR r->>'status' <> 'succeeded' THEN RAISE EXCEPTION 'hd xero first run %', r; END IF;
 SELECT * INTO run FROM public.context_capture_runs c WHERE c.id = (r->>'run_id')::uuid;
 IF run.source <> 'xero_history_daily' OR run.status <> 'succeeded' OR run.error_code IS NOT NULL OR run.finished_at IS NULL
  OR run.counts <> '{"missing_before": 5, "missing_after": 0, "jobs": 2, "raised": 2, "authorised": 2, "paid": 1, "inserted": 5, "duplicate": 0, "errors": 0, "written_keys": 5, "more": 0, "limit": 500}'::jsonb
  OR run.cursor <> jsonb_build_object('v', 1, 'actor', 'cron:xero-history-daily', 'limit', 500, 'written_keys', to_jsonb(want))
 THEN RAISE EXCEPTION 'hd xero first run row % %', run.counts, run.cursor; END IF;
 IF (SELECT count(*) FROM public.context_xero_evidence_backfill_plan()) <> 0
  OR (SELECT count(*) FROM public.business_events b WHERE b.provider_message_id = ANY (want) AND b.source = 'xero-history'
      AND b.metadata->>'capture_mode' = 'backfill'
      AND b.job_id = CASE WHEN b.provider_message_id LIKE 'xero:invoice:hd-xid-1:%' THEN pg_temp.hd_id(31) ELSE pg_temp.hd_id(32) END) <> 5
  OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.provider_message_id LIKE 'xero:invoice:hd-xid-3:%' OR b.provider_message_id LIKE 'xero:invoice:hd-xid-4:%')
 THEN RAISE EXCEPTION 'hd xero first run evidence'; END IF;
 -- The next day: nothing missing, nothing written, one more run row.
 r := public.trigger_xero_history_daily();
 IF r->>'status' <> 'succeeded' OR r->'counts'->'inserted' <> '0' OR r->'counts'->'missing_before' <> '0'
  OR (SELECT count(*) FROM public.context_capture_runs c WHERE c.source = 'xero_history_daily') <> 2
  OR (SELECT count(*) FROM public.business_events b WHERE b.provider_message_id = ANY (want)) <> 5
 THEN RAISE EXCEPTION 'hd xero second run %', r; END IF;
 -- The status read sees the newest run and nothing missing; pg_cron is absent here.
 r := public.context_history_xero_daily_status();
 IF r->'cron_present' <> 'null'::jsonb OR r->'cron_active' <> 'null'::jsonb OR r->>'cron_jobname' <> 'xero-history-daily'
  OR r->'runs_last_7_days' <> '2' OR r->'plan'->'missing_rows' <> '0' OR r->'last_run'->>'status' <> 'succeeded'
  OR r->'last_run'->'counts'->'inserted' <> '0'
 THEN RAISE EXCEPTION 'hd xero status %', r; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6b. A batch limit leaves a partial run (progress counted), then finishes.
SELECT pg_temp.hd_scope();
SELECT pg_temp.hd_job(31, 'scheduled');
SELECT pg_temp.hd_job(32, 'processing');
INSERT INTO public.xero_invoices(id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due, amount_paid,
 invoice_date, due_date, fully_paid_on, job_id, reference, updated_at) VALUES
 ('a1d00000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'hd-xid-1', 'INV-HD1', 'ACCREC', 'AUTHORISED', 550, 550, 0,
  '2026-09-20', '2026-10-04', NULL, pg_temp.hd_id(31), 'HD-31', '2026-09-20'),
 ('a1d00000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'hd-xid-2', 'INV-HD2', 'ACCREC', 'PAID', 1100, 0, 1100,
  '2026-09-01', '2026-09-15', '2026-09-10', pg_temp.hd_id(32), 'HD-32', '2026-09-10');
DO $$
DECLARE r jsonb; run record;
BEGIN
 r := public.trigger_xero_history_daily(2);
 SELECT * INTO run FROM public.context_capture_runs c WHERE c.id = (r->>'run_id')::uuid;
 IF run.status <> 'partial' OR run.counts->'inserted' <> '2' OR run.counts->'missing_after' <> '3' OR run.counts->'more' <> '1'
  OR jsonb_array_length(run.cursor->'written_keys') <> 2 OR run.error_code IS NOT NULL
 THEN RAISE EXCEPTION 'hd xero partial run % %', run.counts, run.cursor; END IF;
 r := public.trigger_xero_history_daily(2);
 r := public.trigger_xero_history_daily(2);
 IF r->>'status' <> 'succeeded' OR r->'counts'->'inserted' <> '1' OR (SELECT count(*) FROM public.context_xero_evidence_backfill_plan()) <> 0
 THEN RAISE EXCEPTION 'hd xero partial runs did not finish %', r; END IF;
 BEGIN
  PERFORM public.trigger_xero_history_daily(0);
  RAISE EXCEPTION 'hd xero accepted limit 0';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE 'xero_history_daily_limit_invalid%' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;

BEGIN;
-- 6c. A failed writer leaves a failed run and nothing written.
SELECT pg_temp.hd_scope();
SELECT pg_temp.hd_job(31, 'scheduled');
INSERT INTO public.xero_invoices(id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due, amount_paid,
 invoice_date, due_date, fully_paid_on, job_id, reference, updated_at) VALUES
 ('a1d00000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'hd-xid-1', 'INV-HD1', 'ACCREC', 'AUTHORISED', 550, 550, 0,
  '2026-09-20', '2026-10-04', NULL, pg_temp.hd_id(31), 'HD-31', '2026-09-20');
CREATE OR REPLACE FUNCTION public.context_xero_evidence_backfill(p_dry_run boolean DEFAULT true, p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.capture_business_event(r.row_json) FROM public.context_xero_evidence_backfill_plan() r LIMIT 1;
 RAISE EXCEPTION 'hd backfill down';
END $$;
DO $$
DECLARE r jsonb; run record;
BEGIN
 r := public.trigger_xero_history_daily();
 SELECT * INTO run FROM public.context_capture_runs c WHERE c.id = (r->>'run_id')::uuid;
 IF r->>'outcome' <> 'failed' OR run.status <> 'failed' OR run.error_code <> 'xero_history_daily_failed:p0001'
  OR run.counts->'inserted' <> '0' OR run.cursor->'written_keys' <> '[]'::jsonb
  OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.provider_message_id LIKE 'xero:invoice:hd-xid-1:%')
 THEN RAISE EXCEPTION 'hd xero failed run % %', r, to_jsonb(run); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 7. The schedule on pg_cron stand-ins: created gated, once, on a re-apply.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL DEFAULT true, jobname text);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid
$$;
\ir ../../../migrations/20261007050000_context_history_daily.sql
\ir ../../../migrations/20261007050000_context_history_daily.sql
DO $$
DECLARE r jsonb;
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname = 'xero-history-daily') <> 1 THEN RAISE EXCEPTION 'hd re-apply scheduled twice'; END IF;
 IF (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'xero-history-daily')
    <> '30 19 * * * SELECT public.trigger_xero_history_daily() WHERE public.automation_lane_enabled(''capture'')'
 THEN RAISE EXCEPTION 'hd job %', (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j); END IF;
 r := public.context_history_xero_daily_status();
 IF r->'cron_present' <> 'true' OR r->'cron_active' <> 'true' OR r->>'cron_schedule' <> '30 19 * * *' OR r->'cron_command_matches' <> 'true'
 THEN RAISE EXCEPTION 'hd xero status with pg_cron %', r; END IF;
 IF (SELECT count(*) FROM public.automation_switch_cron_lanes() WHERE cron_jobname = 'xero-history-daily' AND lane = 'capture') <> 1
 THEN RAISE EXCEPTION 'hd re-apply lane list'; END IF;
END $$;
ROLLBACK;
