-- EM2 + EM3 (context build plan Wave 3E; design email.md §2, §7, §8, §12,
-- §13a): the email reader's database side and its schedule. Built on EM1
-- (20260924213000: monitored_mailboxes, the email_capture_v2 flag, the
-- inbox_events sighting columns, the email_capture status block).
--
-- What it does:
--  1. Two feature flags, created OFF:
--       email_reader_v1           the reader (edge function outlook-mail-capture)
--                                 reads mail only while this is on;
--       email_reader_schedule_v1  the 5-minute poll and the 02:00 Perth sweep
--                                 call the reader only while this is on, and
--                                 the old monitor-inbox path stops writing its
--                                 own email evidence rows (it keeps
--                                 inbox_events) only while this is on.
--     email_capture_v2 (EM1) must also be on for the reader to run.
--  2. context_email_reader_flags(): the three flags as {reader, schedule,
--     program, states}. Missing or unreadable reads as off.
--  3. Read helpers for the reader (service_role): supplier domains, the
--     client emails of our jobs (owner-mailbox privacy rule, D-EM3), and the
--     live-job scope for history runs (captain ruling 24 Sep 2026, through
--     M4's context_ghl_history_live_jobs()).
--  4. public.context_email_attachments: one ledger row per email attachment
--     (stored, or skipped with the reason). Bytes live in the PRIVATE storage
--     bucket context-email-attachments (15 MB per file), never a public URL.
--     RLS on, no grant to anon or authenticated; service_role reads and
--     inserts.
--  5. EM3: trigger_context_email_poll() and trigger_context_email_sweep()
--     post to the outlook-mail-capture edge function with the service key,
--     only while email_reader_v1, email_reader_schedule_v1 and
--     email_capture_v2 are on. pg_cron jobs outlook-mail-poll (every 5
--     minutes) and monitor-inbox-sweep (18:00 UTC = 02:00 Perth, one post per
--     selected source; the name EM1's sweep_incomplete alarm text gives),
--     each wrapped in WHERE public.automation_lane_enabled('capture') and
--     listed in automation_switch_cron_lanes().
--
-- No flag or switch is turned on, no business_events row is written, no mail
-- is read by this migration, and no grant, policy or view is added for anon or
-- authenticated. Every new or re-created function: fixed search_path,
-- EXECUTE revoked from PUBLIC, anon, authenticated.
--
-- Pre-image (production once T2, 20261002100000, has applied):
--   automation_switch_cron_lanes()     md5(prosrc) 4f80b88d5c5ef6a49a6677f1a76d6350 (T2 body:
--     C1d's three rows plus ghl-call-transcript-fetch, 20261002100000)
--   capture_business_event(jsonb)      4819869e6dcc40d5cd19a7eba295392c (C1a)
--   record_capture_run(jsonb)          db03c98a6da49f128595342f5a93f84c (F1b)
--   context_ghl_history_live_jobs()    49eb23015b724a29058c11b2743954bf (M4)
--   monitored_mailboxes with EM1's source_key, kind, owner_privacy
--   feature_flags: no email_reader_v1 or email_reader_schedule_v1 row on the
--     first apply; cron jobs outlook-mail-poll and monitor-inbox-sweep absent
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply). A re-apply keeps whatever the owner set the
-- flags to.
--
-- Rollback: supabase/rollbacks/20261002150000_context_email_reader_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cmd text; first_apply boolean;
BEGIN
 first_apply:=to_regclass('public.context_email_attachments') IS NULL;
 FOR x IN SELECT * FROM (VALUES
  ('public.automation_switch_cron_lanes()',ARRAY['4f80b88d5c5ef6a49a6677f1a76d6350','5c1e0e526a74d5b4ad612792c7f076cc'],false),
  ('public.capture_business_event(jsonb)',ARRAY['4819869e6dcc40d5cd19a7eba295392c'],false),
  ('public.record_capture_run(jsonb)',ARRAY['db03c98a6da49f128595342f5a93f84c'],false),
  ('public.context_ghl_history_live_jobs()',ARRAY['49eb23015b724a29058c11b2743954bf'],false)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.monitored_mailboxes')
   AND a.attname='source_key' AND NOT a.attisdropped) THEN
  problems:=problems||'monitored_mailboxes lacks EM1''s source_key (apply 20260924213000 first)'::text;
 END IF;
 IF to_regclass('public.feature_flags') IS NULL THEN
  problems:=problems||'feature_flags table missing'::text;
 ELSIF first_apply AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1')) THEN
  problems:=problems||'feature flag email_reader_v1 or email_reader_schedule_v1 already exists; this migration creates them off'::text;
 END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT string_agg(jobname||'': ''||command,'' | '') FROM cron.job WHERE jobname IN (''outlook-mail-poll'',''monitor-inbox-sweep'')' INTO cmd;
  IF cmd IS NOT NULL AND cmd NOT IN (
   'outlook-mail-poll: SELECT public.trigger_context_email_poll() WHERE public.automation_lane_enabled(''capture'')',
   'monitor-inbox-sweep: SELECT public.trigger_context_email_sweep() WHERE public.automation_lane_enabled(''capture'')',
   'outlook-mail-poll: SELECT public.trigger_context_email_poll() WHERE public.automation_lane_enabled(''capture'') | monitor-inbox-sweep: SELECT public.trigger_context_email_sweep() WHERE public.automation_lane_enabled(''capture'')',
   'monitor-inbox-sweep: SELECT public.trigger_context_email_sweep() WHERE public.automation_lane_enabled(''capture'') | outlook-mail-poll: SELECT public.trigger_context_email_poll() WHERE public.automation_lane_enabled(''capture'')')
  THEN problems:=problems||'cron job outlook-mail-poll or monitor-inbox-sweep exists with another command'::text; END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'email_reader_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The flags, off. A re-apply keeps the owner's setting.
INSERT INTO public.feature_flags(flag_name,enabled,description)
SELECT 'email_reader_v1',false,'Email reader (EM2, outlook-mail-capture): reads monitored_mailboxes sources (inbound and sent, new words, attachments to the private store) into business_events. Also needs email_capture_v2 and the capture lane.'
WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_v1');
INSERT INTO public.feature_flags(flag_name,enabled,description)
SELECT 'email_reader_schedule_v1',false,'Email reader schedule (EM3): the 5-minute poll and the 02:00 Perth sweep call the reader, and the old monitor-inbox path stops writing email evidence rows (it keeps inbox_events). Needs email_reader_v1.'
WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_schedule_v1');

-- 2. The flags as one read. Fails closed.
CREATE OR REPLACE FUNCTION public.context_email_reader_flags() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r boolean; s boolean; p boolean;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN
  RETURN jsonb_build_object('reader',false,'schedule',false,'program',false,'state','missing');
 END IF;
 EXECUTE 'SELECT bool_or(enabled) FILTER (WHERE flag_name=''email_reader_v1''),
   bool_or(enabled) FILTER (WHERE flag_name=''email_reader_schedule_v1''),
   bool_or(enabled) FILTER (WHERE flag_name=''email_capture_v2'')
  FROM public.feature_flags WHERE flag_name IN (''email_reader_v1'',''email_reader_schedule_v1'',''email_capture_v2'')'
  INTO r,s,p;
 RETURN jsonb_build_object('reader',coalesce(r,false),'schedule',coalesce(s,false),'program',coalesce(p,false),
  'state',CASE WHEN r IS NULL OR s IS NULL OR p IS NULL THEN 'missing' ELSE 'present' END);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('reader',false,'schedule',false,'program',false,'state','unreadable');
END $$;
COMMENT ON FUNCTION public.context_email_reader_flags() IS
 'Email reader flags (EM2/EM3) as {reader: email_reader_v1, schedule: email_reader_schedule_v1, program: email_capture_v2, state}. Missing or unreadable reads as off.';

-- 3. Read helpers. Arrays, so the reader is not cut at PostgREST's row limit.
CREATE OR REPLACE FUNCTION public.context_email_supplier_domains() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT d ORDER BY d),'{}') FROM (
  SELECT lower(btrim(substring(s.email from '@([A-Za-z0-9.-]+)\s*$'))) AS d FROM public.suppliers s WHERE s.email LIKE '%@%'
 ) x
 WHERE d IS NOT NULL AND d<>''
  -- Our own domains and the common free-mail domains never mark a sender as a supplier.
  AND d !~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
  AND d NOT IN ('gmail.com','hotmail.com','outlook.com','live.com','live.com.au','yahoo.com','yahoo.com.au','bigpond.com','bigpond.net.au','icloud.com','me.com','iinet.net.au','optusnet.com.au','westnet.com.au','outlook.com.au','hotmail.com.au')
$$;
COMMENT ON FUNCTION public.context_email_supplier_domains() IS
 'EM2: lower-case email domains of suppliers.email (our domains and free-mail domains excluded). The email reader marks a sender from one of them as a supplier.';

CREATE OR REPLACE FUNCTION public.context_email_job_client_emails() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT e ORDER BY e),'{}') FROM (
  SELECT lower(btrim(j.client_email)) AS e FROM public.jobs j WHERE j.client_email LIKE '%@%'
 ) x
$$;
COMMENT ON FUNCTION public.context_email_job_client_emails() IS
 'EM2: lower-case client emails of our jobs. Owner-mailbox privacy rule (D-EM3): our own human-sent mail from an owner mailbox is captured when it goes to one of these (or names one of our references).';

CREATE OR REPLACE FUNCTION public.context_email_history_scope() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH live AS (SELECT l.job_id, l.job_number FROM public.context_ghl_history_live_jobs() l)
 SELECT jsonb_build_object(
  'jobs',(SELECT count(*) FROM live),
  'job_numbers',coalesce((SELECT jsonb_agg(DISTINCT upper(btrim(l.job_number))) FROM live l WHERE nullif(btrim(l.job_number),'') IS NOT NULL),'[]'::jsonb),
  'client_emails',coalesce((SELECT jsonb_agg(DISTINCT lower(btrim(j.client_email))) FROM live l JOIN public.jobs j ON j.id=l.job_id
   WHERE j.client_email LIKE '%@%'),'[]'::jsonb))
$$;
COMMENT ON FUNCTION public.context_email_history_scope() IS
 'EM2 history runs: the live jobs (captain ruling 24 Sep 2026, M4 context_ghl_history_live_jobs) as their job numbers and client emails. A history run keeps only mail that names one of the numbers or involves one of the emails.';

-- 4. The attachment ledger.
CREATE TABLE IF NOT EXISTS public.context_email_attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider_message_id text NOT NULL CHECK (provider_message_id ~ '^(email|graph):' AND length(provider_message_id)<=1000),
 attachment_key text NOT NULL CHECK (attachment_key ~ '^[0-9a-f]{64}$'),
 business_event_id uuid REFERENCES public.business_events(id) ON DELETE SET NULL,
 file_name text CHECK (file_name IS NULL OR length(file_name)<=255),
 content_type text CHECK (content_type IS NULL OR length(content_type)<=255),
 size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes>=0),
 sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
 storage_bucket text,
 storage_path text,
 status text NOT NULL CHECK (status IN ('stored','skipped_inline','skipped_kind','skipped_too_large','skipped_message_cap','skipped_scope')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_email_attachments_one UNIQUE (provider_message_id, attachment_key),
 CONSTRAINT context_email_attachments_stored CHECK (
  (status='stored') = (storage_path IS NOT NULL AND storage_bucket='context-email-attachments' AND sha256 IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS context_email_attachments_event ON public.context_email_attachments(business_event_id);
COMMENT ON TABLE public.context_email_attachments IS
 'EM2: one row per attachment of a captured email (keyed by the email''s provider_message_id and sha-256 of the Graph attachment id). stored rows point at the PRIVATE bucket context-email-attachments; skipped rows say why (inline, not a file, over 15 MB, over 10 files or 30 MB per email, ses@ scope). Written only by the outlook-mail-capture reader. No anon or authenticated access.';
ALTER TABLE public.context_email_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_email_attachments FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON TABLE public.context_email_attachments TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.context_email_attachments;
CREATE POLICY service_role_all ON public.context_email_attachments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- The private bucket. Skipped where Supabase storage is absent (contract runner).
DO $bucket$
BEGIN
 IF to_regclass('storage.buckets') IS NULL THEN
  RAISE NOTICE 'context-email-attachments: storage absent, bucket not created';
  RETURN;
 END IF;
 EXECUTE $q$INSERT INTO storage.buckets (id, name, public, file_size_limit)
  VALUES ('context-email-attachments','context-email-attachments',false,15728640) ON CONFLICT (id) DO NOTHING$q$;
 IF EXISTS (SELECT 1 FROM storage.buckets WHERE id='context-email-attachments' AND public) THEN
  RAISE EXCEPTION 'email_reader_bucket_public: bucket context-email-attachments exists and is public';
 END IF;
END $bucket$;

-- 5. EM3: the schedule. Idle until all three flags are on.
CREATE OR REPLACE FUNCTION public.trigger_context_email_poll() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags();
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN RETURN; END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
  body := jsonb_build_object('mode','poll','actor','cron:outlook-mail-poll'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
END $$;
COMMENT ON FUNCTION public.trigger_context_email_poll() IS
 'pg_cron outlook-mail-poll (every 5 minutes, capture lane): posts {mode: poll} to the outlook-mail-capture edge function with the service key while email_reader_v1, email_reader_schedule_v1 and email_capture_v2 are on. EM3.';

CREATE OR REPLACE FUNCTION public.trigger_context_email_sweep() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags(); k text;
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN RETURN; END IF;
 FOR k IN SELECT m.source_key FROM public.monitored_mailboxes m
  WHERE m.enabled AND m.status='active' AND m.kind IN ('user','group') ORDER BY m.source_key LOOP
  PERFORM net.http_post(
   url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
   body := jsonb_build_object('mode','sweep','source',k,'actor','cron:monitor-inbox-sweep'),
   headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
   timeout_milliseconds := 5000
  );
 END LOOP;
END $$;
COMMENT ON FUNCTION public.trigger_context_email_sweep() IS
 'pg_cron monitor-inbox-sweep (18:00 UTC = 02:00 Perth, capture lane): one {mode: sweep, source} post per selected source to outlook-mail-capture while email_reader_v1, email_reader_schedule_v1 and email_capture_v2 are on. EM3.';

-- The capture lane owns the two new jobs. Same body as 20260924133000 plus two rows.
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
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its
-- unwrap can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'email reader: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='outlook-mail-poll') THEN
  PERFORM cron.schedule('outlook-mail-poll','2-59/5 * * * *',
   $cmd$SELECT public.trigger_context_email_poll() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='monitor-inbox-sweep') THEN
  PERFORM cron.schedule('monitor-inbox-sweep','0 18 * * *',
   $cmd$SELECT public.trigger_context_email_sweep() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
END $cron$;

-- 6. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_email_reader_flags(),public.context_email_supplier_domains(),public.context_email_job_client_emails(),
 public.context_email_history_scope(),public.trigger_context_email_poll(),public.trigger_context_email_sweep() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_email_reader_flags(),public.context_email_supplier_domains(),public.context_email_job_client_emails(),
 public.context_email_history_scope() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_context_email_poll(),public.trigger_context_email_sweep() TO postgres;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
