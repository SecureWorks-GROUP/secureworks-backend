-- EM1: email capture configuration and health, built with the flag off
-- (email.md §14 row EM1; INTEGRATION.md Wave 3E, X22, X31, X32).
--
-- The first email slice. It adds the data the new mail poller (EM2) will read
-- and the status block the CIO desk will watch. Nothing reads mail
-- differently: flag email_capture_v2 is created OFF, no poller reads the
-- source list yet, and the old monitor-inbox path is pinned to its own
-- hard-coded list (see the note on the old path below).
--
--   1. monitored_mailboxes, which already exists in production: the 2 May T7
--      draft (ledger 20260503063735), 17 columns, EMPTY, no seed, no trigger,
--      view, function or cron reading it. EM1 owns it from here (INTEGRATION
--      §2) and builds on it:
--        - adds source_key, kind, owner_privacy, files_supplier_pdfs,
--          updated_by;
--        - widens the scope_label rule with approvals (Plans and Approvals,
--          council plans) and ses;
--        - enabled now defaults to false, and a source may be enabled only in
--          status 'active'; selected = enabled and status 'active';
--        - drops last_polled_at and its index (the draft's per-mailbox cursor;
--          the cursor lives in context_capture_runs), which also makes the
--          old path's query fail (below);
--        - revokes every grant from PUBLIC, anon and authenticated and drops
--          the draft's authenticated_select policy (X32); service_role reads.
--      Seeded with the captain's list of 24 Sep 2026: user mailboxes marnin@,
--      jan@, nithin@, shaun@, admin@, khairo@; groups patios@, fencing@,
--      finance@, approvals@ and ses@, all enabled; info@, sales@ and plans@
--      disabled and pending_review until their delivery is located (email.md
--      P1, gate G-EM-MAILBOX). owner_privacy and files_supplier_pdfs carry
--      email.md's two per-mailbox rules (D-EM3, §7 step 8). The draft's other
--      columns (poll_interval_seconds, graph_*, last_message_at, last_error*,
--      privacy_classification) are kept and not read by EM code.
--   2. monitored_mailbox_changes: the receipt of every change made through
--      set_monitored_mailbox(), with the actor (X31). Append-only; RLS on, no
--      policies, revoked from PUBLIC, anon, authenticated; service_role reads.
--   3. set_monitored_mailbox(email, enabled, status, reason, actor): the one
--      writer after the seed (ops-api action set_monitored_mailbox). It
--      changes only enabled and status of an existing row, records updated_by
--      and a receipt, and never adds or removes a source (a migration does).
--   4. inbox_events gains the sighting columns EM2 writes: business_event_id
--      (the one evidence row this mailbox copy is), provider_message_id (its
--      'email:' key) and folder_kind. All null on every existing row; nothing
--      writes them yet. The table keeps its service-role-only policy.
--   5. feature_flags row email_capture_v2, enabled = false (email.md P3). The
--      guard requires it absent on a first apply; a re-apply leaves the row
--      this migration created as it is.
--   6. context_email_capture_policy() and context_email_capture_status(),
--      replacing F1b's stub with grouped health, never per-mailbox identities.
--      Output and alarm contract: docs/context/email-capture.md.
--
-- Run-row contract for the email writers (EM2, EM3). record_capture_run()
-- takes a source matching ^[a-z][a-z0-9_]{2,62}$, so a mailbox address cannot
-- be the source; each mailbox carries a source_key and its runs are named
--   outlook_<source_key>          the 5-minute poll
--   outlook_sweep_<source_key>    the 02:00 Perth sweep (one per source)
--   outlook_history_<source_key>  the history run
-- status 'succeeded' = the source finished; 'partial' = cut short (time
-- budget, throttling), the run did not finish; 'failed' = an error, with
-- error_code. A poll with pages left sets cursor.backlog = true. A sweep puts
-- the messages the poll missed in counts.sweep_misses.
--
-- The old path (email.md finding 15, review M14). The deployed monitor-inbox
-- reads monitored_mailboxes (select id, email, enabled, status,
-- last_polled_at ... enabled = true, status <> 'paused') and, once it has
-- rows, polls every one of them as a user mailbox instead of its own list:
-- the seeded groups and khairo@ would be polled by the wrong path. The same
-- change set pins that code to its hard-coded list, and this migration drops
-- last_polled_at, so the old query is refused by the database and falls back
-- to the hard-coded list even in the minutes between this migration and the
-- function deploy. The contract runs that exact query and requires it to fail.
--
-- No switch is turned on. The only rows written are the seed into the empty
-- table and the email_capture_v2 flag row, which must not exist yet and is
-- inserted as off. No grant,
-- policy or view is added for anon or authenticated; theirs are removed.
--
-- Built on the LIVE production definitions, read from production 24 Sep 2026
-- (read-only transaction, rolled back):
--   context_email_capture_status()  md5(prosrc) 155104bfb08b8b3c2f98bdec089d4ee4 (F1b stub)
--   context_pipeline_status()       md5(prosrc) 9183a756c0d4b3881507656751c0d422 (F1b; not replaced)
--   monitored_mailboxes: the T7 draft's 17 columns, 0 rows, checks on
--     scope_label (owner admin finance sales patios fencing ops other),
--     status (active paused discovered_in_code pending_review),
--     privacy_classification and poll_interval_seconds; unique email; policies
--     service_role_all and authenticated_select; no trigger or dependent view
--   monitored_mailbox_changes, set_monitored_mailbox(): absent
--   inbox_events: 19 columns incl. graph_message_id, mailbox, spine_event_id;
--     RLS on, policy service_role_all; none of the three sighting columns
--   business_events.id uuid primary key; feature_flags(flag_name unique), no
--     email_capture_v2 row; context_capture_runs with window_end_id (F1b)
--   ledger: nothing after 20260924201000
-- The guard refuses unless each object is still that pre-image or already
-- this migration's result (a re-apply). Anything else is a live change nobody
-- read, and replacing it would silently revert it.
--
-- Rollback: supabase/rollbacks/20260924213000_context_email_capture_config_down.sql
-- restores F1b's stub (md5 checked) and the draft table exactly as it was
-- (empty, its columns, checks, grants and policies), drops the receipts
-- table, the functions and the three inbox_events columns, and deletes the
-- flag row while it is still off. It refuses while the flag is on, a sighting
-- column holds a value, or a receipt exists.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text; t text; reapply boolean; n bigint;
 draft_cols constant text:='id:uuid:t,org_id:uuid:f,email:text:t,display_name:text:f,scope_label:text:t,enabled:boolean:t,status:text:t,poll_interval_seconds:integer:t,privacy_classification:text:t,graph_subscription_id:text:f,graph_app_credential_id:text:f,last_polled_at:timestamp with time zone:f,last_message_at:timestamp with time zone:f,last_error:text:f,last_error_at:timestamp with time zone:f,created_at:timestamp with time zone:t,updated_at:timestamp with time zone:t';
 em1_cols constant text:='id:uuid:t,org_id:uuid:f,email:text:t,display_name:text:f,scope_label:text:t,enabled:boolean:t,status:text:t,poll_interval_seconds:integer:t,privacy_classification:text:t,graph_subscription_id:text:f,graph_app_credential_id:text:f,last_message_at:timestamp with time zone:f,last_error:text:f,last_error_at:timestamp with time zone:f,created_at:timestamp with time zone:t,updated_at:timestamp with time zone:t,source_key:text:t,kind:text:t,owner_privacy:boolean:t,files_supplier_pdfs:boolean:t,updated_by:text:t';
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: F1b's stub, or this migration's body.
  ('public.context_email_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','39f700ff23752f161c2215ecc500ece8'],false),
  -- New: absent, or already this migration's body.
  ('public.context_email_capture_policy()',ARRAY['a7ebb664be0ffff255d7bc2481976054'],true),
  ('public.set_monitored_mailbox(text,boolean,text,text,text)',ARRAY['490a637f9ea0da6aae196e9ce1aeaf5d'],true),
  ('public.context_email_capture_status_at(timestamptz)',ARRAY['78aefd4a54766e3e4967373e46fb934a'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- No other function of these names (an overload would be a second writer).
 SELECT string_agg(p.oid::regprocedure::text,', ') INTO cols FROM pg_proc p
 WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('set_monitored_mailbox','context_email_capture_policy','context_email_capture_status_at','context_email_capture_status')
  AND p.oid NOT IN (coalesce(to_regprocedure('public.set_monitored_mailbox(text,boolean,text,text,text)'),0),
                    coalesce(to_regprocedure('public.context_email_capture_policy()'),0),
                    coalesce(to_regprocedure('public.context_email_capture_status_at(timestamptz)'),0),
                    coalesce(to_regprocedure('public.context_email_capture_status()'),0));
 IF cols IS NOT NULL THEN problems:=problems||format('unexpected overloads: %s',cols); END IF;
 -- monitored_mailboxes: the live T7 draft, empty; or this migration's shape.
 IF to_regclass('public.monitored_mailboxes') IS NULL THEN
  problems:=problems||'monitored_mailboxes missing (production has the T7 draft table)'::text;
 ELSE
  -- Compared as sets: a column re-added by a rollback sits last.
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||CASE WHEN a.attnotnull THEN 't' ELSE 'f' END,',' ORDER BY a.attname) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.monitored_mailboxes'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  reapply:=cols=(SELECT string_agg(c,',' ORDER BY split_part(c,':',1)) FROM unnest(string_to_array(em1_cols,',')) c);
  IF NOT reapply THEN
   IF cols IS DISTINCT FROM (SELECT string_agg(c,',' ORDER BY split_part(c,':',1)) FROM unnest(string_to_array(draft_cols,',')) c) THEN problems:=problems||format('monitored_mailboxes columns are %s',cols); END IF;
   EXECUTE 'SELECT count(*) FROM public.monitored_mailboxes' INTO n;
   IF n<>0 THEN problems:=problems||format('monitored_mailboxes is not empty (%s rows); someone seeded it',n); END IF;
   -- The flag is created off by this migration; on a first apply it must not
   -- exist yet (production had no row), so it can never inherit an 'on'.
   IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_capture_v2')
   THEN problems:=problems||'feature flag email_capture_v2 already exists; this migration creates it off'::text; END IF;
   -- The draft's checks, one per column, and its unique email.
   SELECT string_agg(a.attname,',' ORDER BY a.attname) INTO t FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
   WHERE c.conrelid='public.monitored_mailboxes'::regclass AND c.contype='c';
   IF t IS DISTINCT FROM 'poll_interval_seconds,privacy_classification,scope_label,status' THEN problems:=problems||format('monitored_mailboxes checks are on %s',t); END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.monitored_mailboxes'::regclass AND c.contype='u'
     AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='email')]::int2[])
   THEN problems:=problems||'monitored_mailboxes has no unique email'::text; END IF;
   SELECT pg_get_constraintdef(c.oid) INTO t FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
   WHERE c.conrelid='public.monitored_mailboxes'::regclass AND c.contype='c' AND a.attname='status';
   IF t IS NULL OR t !~ 'active' OR t !~ 'pending_review' THEN problems:=problems||format('monitored_mailboxes status check is %s',t); END IF;
   SELECT string_agg(policyname::text,',' ORDER BY policyname) INTO t FROM pg_policies WHERE schemaname='public' AND tablename='monitored_mailboxes';
   IF t IS DISTINCT FROM 'authenticated_select,service_role_all' THEN problems:=problems||format('monitored_mailboxes policies are %s',t); END IF;
   IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.monitored_mailboxes'::regclass AND NOT tgisinternal)
   THEN problems:=problems||'monitored_mailboxes has a trigger'::text; END IF;
   IF EXISTS(SELECT 1 FROM pg_depend d JOIN pg_rewrite rw ON rw.oid=d.objid WHERE d.refobjid='public.monitored_mailboxes'::regclass AND rw.ev_class<>'public.monitored_mailboxes'::regclass)
   THEN problems:=problems||'a view depends on monitored_mailboxes'::text; END IF;
  END IF;
 END IF;
 -- monitored_mailbox_changes: absent, or this migration's columns.
 IF to_regclass('public.monitored_mailbox_changes') IS NOT NULL THEN
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.monitored_mailbox_changes'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:bigint,email:text,changed_at:timestamp with time zone,actor:text,reason:text,before:jsonb,after:jsonb'
  THEN problems:=problems||format('monitored_mailbox_changes exists with columns %s',cols); END IF;
 END IF;
 -- inbox_events: the live table, and the three sighting columns absent or ours.
 IF to_regclass('public.inbox_events') IS NULL THEN problems:=problems||'inbox_events missing'::text; END IF;
 FOR x IN SELECT * FROM (VALUES ('business_event_id','uuid'),('provider_message_id','text'),('folder_kind','text')) AS t(col,typ) LOOP
  t:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO t FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.inbox_events') AND a.attname=x.col AND NOT a.attisdropped;
  IF t IS NOT NULL AND t<>x.typ THEN problems:=problems||format('inbox_events.%s exists as %s',x.col,t); END IF;
 END LOOP;
 -- What this migration reads or references.
 t:=NULL;
 SELECT format_type(a.atttypid,a.atttypmod) INTO t FROM pg_attribute a
 WHERE a.attrelid=to_regclass('public.business_events') AND a.attname='id' AND NOT a.attisdropped;
 IF t IS DISTINCT FROM 'uuid' THEN problems:=problems||format('business_events.id is %s',coalesce(t,'<missing>')); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.business_events') AND c.contype IN ('p','u')
   AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='id')]::int2[])
 THEN problems:=problems||'business_events.id has no primary key or unique constraint'::text; END IF;
 SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attname) INTO cols
 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.feature_flags') AND a.attname IN ('flag_name','enabled','description','updated_at') AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'description:text,enabled:boolean,flag_name:text,updated_at:timestamp with time zone'
 THEN problems:=problems||format('feature_flags columns are %s',coalesce(cols,'<missing table>')); END IF;
 IF to_regclass('public.context_capture_runs') IS NULL OR to_regprocedure('public.record_capture_run(jsonb)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_capture_runs') AND a.attname='window_end_id' AND NOT a.attisdropped)
 THEN problems:=problems||'context_capture_runs (F1, F1b) missing'::text; END IF;
 IF to_regprocedure('public.automation_lane_enabled(text)') IS NULL THEN problems:=problems||'automation_lane_enabled(text) missing'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_email_capture_config_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The source list: the live T7 draft table, built on.
-- The draft's per-mailbox cursor goes (the cursor lives in context_capture_runs);
-- with it goes the column the old monitor-inbox query selects.
DROP INDEX IF EXISTS public.idx_monitored_mailboxes_enabled;
ALTER TABLE public.monitored_mailboxes DROP COLUMN IF EXISTS last_polled_at;
-- A source is never selected by default.
ALTER TABLE public.monitored_mailboxes ALTER COLUMN enabled SET DEFAULT false;
ALTER TABLE public.monitored_mailboxes
 ADD COLUMN IF NOT EXISTS source_key text,
 ADD COLUMN IF NOT EXISTS kind text,
 ADD COLUMN IF NOT EXISTS owner_privacy boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS files_supplier_pdfs boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS updated_by text;
-- scope_label gains approvals (Plans and Approvals) and ses. The draft's check
-- has a generated name, so it is found by its column.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT con.conname FROM pg_constraint con
  WHERE con.conrelid='public.monitored_mailboxes'::regclass AND con.contype='c'
   AND con.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=con.conrelid AND attname='scope_label')]::int2[]
   AND con.conname<>'monitored_mailboxes_scope_label_em1' LOOP
  EXECUTE format('ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_scope_label_em1;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_scope_label_em1
 CHECK (scope_label IN ('owner','admin','finance','sales','patios','fencing','ops','other','approvals','ses'));
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_email_format;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_email_format
 CHECK (email=lower(email) AND email ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$');
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_source_key;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_source_key CHECK (source_key ~ '^[a-z][a-z0-9_]{1,40}$');
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_source_key_unique;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_source_key_unique UNIQUE (source_key);
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_kind;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_kind CHECK (kind IN ('user','group','unknown'));
-- Only a located, reviewed source is ever selected.
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_enabled_active;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_enabled_active CHECK (NOT enabled OR status='active');
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_unknown_pending;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_unknown_pending CHECK (kind<>'unknown' OR status='pending_review');
-- The two per-mailbox rules apply to user mailboxes only.
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_user_rules;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_user_rules CHECK (kind='user' OR NOT (owner_privacy OR files_supplier_pdfs));
ALTER TABLE public.monitored_mailboxes DROP CONSTRAINT IF EXISTS monitored_mailboxes_updated_by;
ALTER TABLE public.monitored_mailboxes ADD CONSTRAINT monitored_mailboxes_updated_by CHECK (updated_by ~ '^[A-Za-z0-9_.:@-]{1,128}$');

-- The captain's list, 24 Sep 2026. Re-apply leaves existing rows untouched.
INSERT INTO public.monitored_mailboxes(email,source_key,kind,enabled,status,scope_label,privacy_classification,owner_privacy,files_supplier_pdfs,updated_by) VALUES
 ('marnin@secureworkswa.com.au','marnin','user',true,'active','owner','restricted_pii',true,true,'migration:20260924213000'),
 ('jan@secureworkswa.com.au','jan','user',true,'active','owner','restricted_pii',true,true,'migration:20260924213000'),
 ('nithin@secureworkswa.com.au','nithin','user',true,'active','sales','restricted_pii',false,true,'migration:20260924213000'),
 ('shaun@secureworkswa.com.au','shaun','user',true,'active','ops','restricted_pii',false,true,'migration:20260924213000'),
 ('admin@secureworkswa.com.au','admin','user',true,'active','admin','restricted_pii',false,true,'migration:20260924213000'),
 ('khairo@secureworkswa.com.au','khairo','user',true,'active','sales','restricted_pii',false,false,'migration:20260924213000'),
 ('patios@secureworkswa.com.au','patios','group',true,'active','patios','staff_only',false,false,'migration:20260924213000'),
 ('fencing@secureworkswa.com.au','fencing','group',true,'active','fencing','staff_only',false,false,'migration:20260924213000'),
 ('finance@secureworkswa.com.au','finance','group',true,'active','finance','staff_only',false,false,'migration:20260924213000'),
 ('approvals@secureworkswa.com.au','approvals','group',true,'active','approvals','staff_only',false,false,'migration:20260924213000'),
 ('ses@secureworkswa.com.au','ses','group',true,'active','ses','staff_only',false,false,'migration:20260924213000'),
 ('info@secureworkswa.com.au','info','unknown',false,'pending_review','other','staff_only',false,false,'migration:20260924213000'),
 ('sales@secureworkswa.com.au','sales','unknown',false,'pending_review','sales','staff_only',false,false,'migration:20260924213000'),
 ('plans@secureworkswa.com.au','plans','unknown',false,'pending_review','approvals','staff_only',false,false,'migration:20260924213000')
ON CONFLICT (email) DO NOTHING;
ALTER TABLE public.monitored_mailboxes
 ALTER COLUMN source_key SET NOT NULL,
 ALTER COLUMN kind SET NOT NULL,
 ALTER COLUMN updated_by SET NOT NULL;

-- Access (X32): RLS on; nothing for PUBLIC, anon or authenticated; service_role
-- reads, and writes only through set_monitored_mailbox().
ALTER TABLE public.monitored_mailboxes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS authenticated_select ON public.monitored_mailboxes;
REVOKE ALL ON TABLE public.monitored_mailboxes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.monitored_mailboxes TO service_role;
COMMENT ON TABLE public.monitored_mailboxes IS
 'Outlook sources for email capture (email.md; built on the T7 draft by slice EM1). One row per user mailbox or M365 group. Selected for the new poller (EM2) when enabled and status active, and read only while flag email_capture_v2 is on; the old monitor-inbox path never reads it. Run rows in context_capture_runs are named outlook_<source_key>, outlook_sweep_<source_key>, outlook_history_<source_key>. owner_privacy: human-sent outbound mail is captured only with job evidence (D-EM3). files_supplier_pdfs: supplier PDF filing allowed (email.md §7 step 8). poll_interval_seconds, graph_*, last_message_at, last_error*, privacy_classification are T7 draft columns not read by EM code. Written only by the EM1 seed and set_monitored_mailbox(). No grants for anon or authenticated; service_role reads.';

CREATE TABLE IF NOT EXISTS public.monitored_mailbox_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 email text NOT NULL REFERENCES public.monitored_mailboxes(email),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor text NOT NULL,
 reason text NOT NULL,
 before jsonb NOT NULL,
 after jsonb NOT NULL,
 CONSTRAINT monitored_mailbox_changes_actor CHECK (actor ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
 CONSTRAINT monitored_mailbox_changes_reason CHECK (length(reason) BETWEEN 3 AND 300)
);
CREATE INDEX IF NOT EXISTS monitored_mailbox_changes_email ON public.monitored_mailbox_changes(email,changed_at DESC);
ALTER TABLE public.monitored_mailbox_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.monitored_mailbox_changes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.monitored_mailbox_changes TO service_role;
COMMENT ON TABLE public.monitored_mailbox_changes IS
 'Receipt of every change to monitored_mailboxes made through set_monitored_mailbox(): who (actor, INTEGRATION X31), when, why, and enabled/status before and after. Append-only; written only by set_monitored_mailbox(). RLS on, no policies; service_role reads.';

-- 2. Sighting columns on inbox_events (written by EM2's poller only).
ALTER TABLE public.inbox_events
 ADD COLUMN IF NOT EXISTS business_event_id uuid,
 ADD COLUMN IF NOT EXISTS provider_message_id text,
 ADD COLUMN IF NOT EXISTS folder_kind text;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_business_event_id_fkey;
ALTER TABLE public.inbox_events ADD CONSTRAINT inbox_events_business_event_id_fkey
 FOREIGN KEY (business_event_id) REFERENCES public.business_events(id) ON DELETE SET NULL;
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_folder_kind;
ALTER TABLE public.inbox_events ADD CONSTRAINT inbox_events_folder_kind
 CHECK (folder_kind IS NULL OR folder_kind IN ('inbox','sent','deleted','other','group'));
ALTER TABLE public.inbox_events DROP CONSTRAINT IF EXISTS inbox_events_provider_message_id;
ALTER TABLE public.inbox_events ADD CONSTRAINT inbox_events_provider_message_id
 CHECK (provider_message_id IS NULL OR (provider_message_id ~ '^(email|graph):' AND length(provider_message_id)<=1024));
CREATE INDEX IF NOT EXISTS inbox_events_business_event_id ON public.inbox_events(business_event_id) WHERE business_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_events_provider_message_id ON public.inbox_events(provider_message_id) WHERE provider_message_id IS NOT NULL;
COMMENT ON COLUMN public.inbox_events.business_event_id IS
 'The business_events row this mailbox copy is (email.md §3 sightings). Written by the new poller (EM2) only; readers resolve the job through it (EM-R1). Null on legacy rows. Added by EM1.';
COMMENT ON COLUMN public.inbox_events.provider_message_id IS
 'The evidence key of this copy: email:<internet message id>, or graph:<mailbox>:<immutable id> when there is none. Written by EM2 only. Added by EM1.';
COMMENT ON COLUMN public.inbox_events.folder_kind IS
 'Where this copy was seen: inbox, sent, deleted, other (any other folder), group (a group post). Written by EM2 only. Added by EM1.';

-- 3. The flag, off (email.md P3). A missing or unreadable flag also reads as off.
INSERT INTO public.feature_flags(flag_name,enabled,description)
SELECT 'email_capture_v2',false,'Email capture v2 (email.md): the whole-mailbox Outlook poller reads monitored_mailboxes. Off: the old monitor-inbox path runs, pinned to its own list.'
WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_capture_v2');

-- 4. The one writer after the seed.
CREATE OR REPLACE FUNCTION public.set_monitored_mailbox(p_email text,p_enabled boolean,p_status text,p_reason text,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.monitored_mailboxes; addr text:=lower(btrim(coalesce(p_email,''))); why text:=btrim(coalesce(p_reason,''));
 new_enabled boolean; new_status text; before_v jsonb; after_v jsonb;
BEGIN
 IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'monitored_mailbox_actor_invalid'; END IF;
 IF length(why)<3 OR length(why)>300 OR why ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'monitored_mailbox_reason_invalid'; END IF;
 IF p_status IS NOT NULL AND p_status NOT IN ('active','pending_review') THEN RAISE EXCEPTION 'monitored_mailbox_status_invalid'; END IF;
 IF p_enabled IS NULL AND p_status IS NULL THEN RAISE EXCEPTION 'monitored_mailbox_change_missing'; END IF;
 SELECT * INTO r FROM public.monitored_mailboxes m WHERE m.email=addr FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'monitored_mailbox_unknown'; END IF;
 new_enabled:=coalesce(p_enabled,r.enabled);
 new_status:=coalesce(p_status,r.status);
 IF new_status<>'active' AND p_enabled IS NULL THEN new_enabled:=false; END IF;
 IF new_enabled AND new_status<>'active' THEN RAISE EXCEPTION 'monitored_mailbox_enable_requires_active'; END IF;
 IF r.kind='unknown' AND new_status<>'pending_review' THEN RAISE EXCEPTION 'monitored_mailbox_kind_unknown'; END IF;
 before_v:=jsonb_build_object('enabled',r.enabled,'status',r.status);
 after_v:=jsonb_build_object('enabled',new_enabled,'status',new_status);
 IF before_v=after_v THEN
  RETURN jsonb_build_object('outcome','unchanged','email',r.email,'enabled',r.enabled,'status',r.status);
 END IF;
 UPDATE public.monitored_mailboxes m SET enabled=new_enabled,status=new_status,updated_at=clock_timestamp(),updated_by=p_actor WHERE m.email=r.email;
 INSERT INTO public.monitored_mailbox_changes(email,actor,reason,before,after) VALUES(r.email,p_actor,why,before_v,after_v);
 RETURN jsonb_build_object('outcome','updated','email',r.email,'enabled',new_enabled,'status',new_status,'before',before_v);
END $$;
COMMENT ON FUNCTION public.set_monitored_mailbox(text,boolean,text,text,text) IS
 'The one writer of monitored_mailboxes after the EM1 seed (ops-api set_monitored_mailbox). Changes enabled and/or status (active, pending_review) of an existing source, records updated_by and a monitored_mailbox_changes receipt; never adds or removes a source. Setting a status other than active without naming enabled also disables. Refusal codes: monitored_mailbox_actor_invalid, monitored_mailbox_reason_invalid, monitored_mailbox_status_invalid, monitored_mailbox_change_missing, monitored_mailbox_unknown, monitored_mailbox_enable_requires_active, monitored_mailbox_kind_unknown.';

-- 5. Health: policy and the status block.
CREATE OR REPLACE FUNCTION public.context_email_capture_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'flag','email_capture_v2',
  'timezone','Australia/Perth',
  -- Run-row names in context_capture_runs, per source_key.
  'run_sources',jsonb_build_object('poll','outlook_<source_key>','sweep','outlook_sweep_<source_key>','history','outlook_history_<source_key>'),
  -- The block never names a personal mailbox: sources with these scope
  -- labels are reported only as one combined line, 'personal'. Every other
  -- label (shared mailboxes and groups) is one line per label.
  'personal_scope_labels',jsonb_build_array('owner','sales','ops','other'),
  -- email_source_error: the last this many finished poll runs all failed.
  'failed_runs_alarm',2,
  -- email_backlog: the last this many finished poll runs all left pages behind.
  'backlog_runs_alarm',3,
  -- sweep_incomplete: each selected source must finish a sweep started at or
  -- after 02:00 Perth, checked from 03:00 Perth.
  'sweep_local_time','02:00',
  'sweep_grace_minutes',60,
  -- email_poll_missed: a sweep finished within this window found mail the poll missed.
  'sweep_miss_lookback_hours',26)
$$;
COMMENT ON FUNCTION public.context_email_capture_policy() IS
 'Thresholds, run-row names and the personal scope labels for context_email_capture_status() (EM1). Changed only by migration.';

-- The block, judged at a stated time (tests pass a fixed clock; the composer
-- goes through context_email_capture_status(), which passes now()).
CREATE OR REPLACE FUNCTION public.context_email_capture_status_at(p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_email_capture_policy();
 now_time timestamptz:=coalesce(p_now,now());
 tz text:=policy->>'timezone';
 failed_n integer:=(policy->>'failed_runs_alarm')::integer;
 backlog_n integer:=(policy->>'backlog_runs_alarm')::integer;
 sweep_grace interval:=make_interval(mins=>(policy->>'sweep_grace_minutes')::integer);
 miss_lookback interval:=make_interval(hours=>(policy->>'sweep_miss_lookback_hours')::integer);
 personal text[]:=ARRAY(SELECT jsonb_array_elements_text(policy->'personal_scope_labels'));
 flag_on boolean; flag_changed timestamptz; flag_state text:='present';
 lane_on boolean; alarms_active boolean;
 sweep_at timestamptz; sweep_due boolean;
 m record; line text; src_alarms jsonb;
 poll_src text; sweep_src text;
 last_runs public.context_capture_runs[]; last_sweep public.context_capture_runs; miss_run public.context_capture_runs;
 swept boolean; since timestamptz; selected boolean; last_seen timestamptz;
 n_failed integer; n_backlog integer; misses bigint;
 per_source jsonb:='[]'::jsonb; lines jsonb; alarms jsonb;
BEGIN
 -- Flag: fails closed (no table, no row or an error reads as off).
 BEGIN
  SELECT f.enabled,f.updated_at INTO flag_on,flag_changed FROM public.feature_flags f
  WHERE f.flag_name=policy->>'flag' ORDER BY f.updated_at DESC NULLS LAST LIMIT 1;
  IF flag_on IS NULL THEN flag_state:='missing'; END IF;
 EXCEPTION WHEN OTHERS THEN flag_on:=NULL; flag_changed:=NULL; flag_state:='unreadable';
 END;
 BEGIN lane_on:=public.automation_lane_enabled('capture');
 EXCEPTION WHEN OTHERS THEN lane_on:=NULL;
 END;
 alarms_active:=coalesce(flag_on,false) AND coalesce(lane_on,false);
 -- The most recent 02:00 Perth at or before now.
 sweep_at:=((date_trunc('day',now_time AT TIME ZONE tz)+(policy->>'sweep_local_time')::time) AT TIME ZONE tz);
 IF sweep_at>now_time THEN sweep_at:=((date_trunc('day',now_time AT TIME ZONE tz)-interval '1 day'+(policy->>'sweep_local_time')::time) AT TIME ZONE tz); END IF;
 sweep_due:=now_time>=sweep_at+sweep_grace;

 -- 1. Each source's health, kept inside this function: only the per-line
 -- aggregate below leaves it.
 FOR m IN SELECT * FROM public.monitored_mailboxes LOOP
  line:=CASE WHEN m.scope_label=ANY(personal) THEN 'personal' ELSE m.scope_label END;
  selected:=m.enabled AND m.status='active';
  poll_src:='outlook_'||m.source_key; sweep_src:='outlook_sweep_'||m.source_key;
  SELECT coalesce(array_agg(c ORDER BY c.started_at DESC),'{}') INTO last_runs FROM (
   SELECT * FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status<>'running' ORDER BY r.started_at DESC LIMIT greatest(failed_n,backlog_n)) c;
  SELECT count(*) FILTER (WHERE u.status='failed') INTO n_failed FROM unnest(last_runs[1:failed_n]) u;
  SELECT count(*) FILTER (WHERE (u.cursor->>'backlog')='true') INTO n_backlog FROM unnest(last_runs[1:backlog_n]) u;
  SELECT max(r.finished_at) INTO last_seen FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status='succeeded';
  SELECT * INTO last_sweep FROM public.context_capture_runs r WHERE r.source=sweep_src ORDER BY r.started_at DESC LIMIT 1;
  swept:=EXISTS(SELECT 1 FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.started_at>=sweep_at AND r.status='succeeded');
  -- The latest finished sweep inside the lookback: did it find mail the poll missed?
  SELECT * INTO miss_run FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.status<>'running' AND r.finished_at>=now_time-miss_lookback
  ORDER BY r.started_at DESC LIMIT 1;
  misses:=CASE WHEN jsonb_typeof(miss_run.counts->'sweep_misses')='number' THEN (miss_run.counts->>'sweep_misses')::bigint ELSE 0 END;
  -- A sweep is not expected on the night the flag or the source was switched on.
  since:=greatest(flag_changed,m.updated_at);
  src_alarms:='[]'::jsonb;
  IF alarms_active AND selected THEN
   IF cardinality(last_runs)>=failed_n AND n_failed=failed_n THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_source_error','since',(last_runs[failed_n]).started_at,'error_code',(last_runs[1]).error_code));
   END IF;
   IF cardinality(last_runs)>=backlog_n AND n_backlog=backlog_n THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_backlog','since',(last_runs[backlog_n]).started_at));
   END IF;
   IF misses>0 THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_poll_missed','since',miss_run.started_at,'sweep_misses',misses));
   END IF;
   IF sweep_due AND NOT swept AND (since IS NULL OR since<sweep_at) THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','sweep_incomplete','since',sweep_at,'last_status',last_sweep.status));
   END IF;
  END IF;
  per_source:=per_source||jsonb_build_array(jsonb_build_object('line',line,'selected',selected,
   'pending_review',m.status='pending_review','last_seen',last_seen,'alarms',src_alarms));
 END LOOP;

 -- 2. One line per shared label, one combined 'personal' line: counts,
 -- health and the oldest last-seen only.
 SELECT coalesce(jsonb_agg(l ORDER BY (l->>'line')='personal',l->>'line'),'[]'::jsonb) INTO lines FROM (
  SELECT jsonb_build_object('line',s->>'line','personal',(s->>'line')='personal',
   'sources',count(*),
   'selected',count(*) FILTER (WHERE (s->>'selected')::boolean),
   'pending_review',count(*) FILTER (WHERE (s->>'pending_review')::boolean),
   'healthy',count(*) FILTER (WHERE (s->>'selected')::boolean AND jsonb_array_length(s->'alarms')=0),
   'erroring',count(*) FILTER (WHERE (s->>'selected')::boolean AND jsonb_array_length(s->'alarms')>0),
   'never_seen',count(*) FILTER (WHERE (s->>'selected')::boolean AND s->'last_seen'='null'::jsonb),
   'oldest_last_seen_at',min((s->>'last_seen')::timestamptz) FILTER (WHERE (s->>'selected')::boolean)) AS l
  FROM jsonb_array_elements(per_source) s GROUP BY s->>'line') x;

 -- 3. Alarms, one per line and key: how many of the line's sources raise it,
 -- never which one.
 SELECT coalesce(jsonb_agg(a ORDER BY a->>'line',a->>'key'),'[]'::jsonb) INTO alarms FROM (
  SELECT jsonb_build_object('key',al->>'key','severity','warning','line',s->>'line','sources',count(*),
   'since',min((al->>'since')::timestamptz))
   ||CASE al->>'key'
      WHEN 'email_source_error' THEN jsonb_build_object('error_codes',(SELECT jsonb_agg(DISTINCT c) FROM unnest(array_agg(al->>'error_code')) c WHERE c IS NOT NULL),
       'what_to_do','Mailboxes on this line failed their last two polls. Check the Microsoft Graph credentials and the app''s permission on them.')
      WHEN 'email_backlog' THEN jsonb_build_object('what_to_do','Mailboxes on this line have had more mail than one poll reads for three polls running. They will catch up; if not, raise the page bound.')
      WHEN 'email_poll_missed' THEN jsonb_build_object('sweep_misses',sum((al->>'sweep_misses')::bigint),
       'what_to_do','The nightly sweep found mail the 5-minute poll missed (now captured). Check the poll run rows for this line.')
      ELSE jsonb_build_object('what_to_do','Mailboxes on this line did not finish their 02:00 sweep. Check the monitor-inbox-sweep cron job and the sweep run rows.')
     END AS a
  FROM jsonb_array_elements(per_source) s, jsonb_array_elements(s->'alarms') al
  GROUP BY s->>'line',al->>'key') x;

 RETURN jsonb_build_object('as_of',now_time,
  'flag',jsonb_build_object('name',policy->>'flag','enabled',coalesce(flag_on,false),'updated_at',flag_changed,'state',flag_state),
  'capture_lane',lane_on,'alarms_active',alarms_active,'last_sweep_due_at',sweep_at,
  'counts',jsonb_build_object('sources',jsonb_array_length(per_source),
    'selected',(SELECT count(*) FROM jsonb_array_elements(per_source) s WHERE (s->>'selected')::boolean),
    'pending_review',(SELECT count(*) FROM jsonb_array_elements(per_source) s WHERE (s->>'pending_review')::boolean)),
  'policy',policy,'lines',lines,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_email_capture_status_at(timestamptz) IS
 'context_email_capture_status() judged at p_now (null = now()). For tests and diagnosis; same output shape.';

CREATE OR REPLACE FUNCTION public.context_email_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.context_email_capture_status_at(now()) $$;
COMMENT ON FUNCTION public.context_email_capture_status() IS
 'Status block email_capture (EM1, replacing the F1b stub): mailbox health as one line per shared scope label and one combined personal line (owner, sales, ops, other), with counts, the oldest last-seen and alarms email_source_error, email_poll_missed, email_backlog, sweep_incomplete per line, raised only while flag email_capture_v2 and the capture lane are on. Never names a mailbox: no addresses, source keys or privacy settings.';

-- 6. Grants. No PUBLIC, anon or authenticated execute; service_role only.
REVOKE ALL ON FUNCTION
 public.set_monitored_mailbox(text,boolean,text,text,text),public.context_email_capture_policy(),
 public.context_email_capture_status_at(timestamptz),public.context_email_capture_status()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.set_monitored_mailbox(text,boolean,text,text,text),public.context_email_capture_policy(),
 public.context_email_capture_status_at(timestamptz),public.context_email_capture_status()
TO service_role;
