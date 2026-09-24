-- EM1: email capture configuration and health, built with the flag off
-- (email.md §14 row EM1; INTEGRATION.md Wave 3E, X22, X31, X32).
--
-- The first email slice. It adds the data the new mail poller (EM2) will read
-- and the status block the CIO desk will watch. Nothing reads mail
-- differently: flag email_capture_v2 is created OFF, no poller reads the new
-- table, and the old monitor-inbox path is pinned to its own hard-coded list
-- (see the note on the old path below).
--
--   1. monitored_mailboxes: one row per Outlook source (user mailbox or M365
--      group). Seeded with the captain's list of 24 Sep 2026: user mailboxes
--      marnin@, jan@, nithin@, shaun@, admin@, khairo@; groups patios@,
--      fencing@, finance@, approvals@ (Plans and Approvals, council plans)
--      and ses@, all enabled; info@, sales@ and plans@ disabled and
--      pending_review until their delivery is located (email.md P1, gate
--      G-EM-MAILBOX). A source is polled only when enabled; enabling needs
--      state 'active'. owner_privacy and files_supplier_pdfs carry email.md's
--      two per-mailbox rules (D-EM3, §7 step 8) so EM2 reads them from here.
--      RLS on, no policies, revoked from PUBLIC, anon, authenticated;
--      service_role may read. Written only by this migration's seed and by
--      set_monitored_mailbox().
--   2. monitored_mailbox_changes: the receipt of every change made through
--      set_monitored_mailbox(), with the actor (X31). Append-only; same access
--      rule. Ids, flags and a short reason only.
--   3. set_monitored_mailbox(address, enabled, state, reason, actor): the one
--      writer after the seed (ops-api action set_monitored_mailbox). It
--      changes only enabled and state of an existing row, records updated_by
--      and a receipt, and never adds or removes a source (a migration does).
--   4. inbox_events gains the sighting columns EM2 writes: business_event_id
--      (the one evidence row this mailbox copy is), provider_message_id (its
--      'email:' key) and folder_kind. All null on every existing row; nothing
--      writes them yet. The table keeps its service-role-only policy.
--   5. feature_flags row email_capture_v2, enabled = false (email.md P3).
--      Inserted only when absent; an existing row is left as it is.
--   6. context_email_capture_policy() and context_email_capture_status(),
--      replacing F1b's stub for status block email_capture. Per source: its
--      poll, sweep and history run rows in context_capture_runs, and four
--      alarms (email.md §8): email_source_error, email_poll_missed,
--      email_backlog, sweep_incomplete. Alarms are raised only while the flag
--      is on and the capture lane is on: before that nothing is meant to run.
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
-- reads monitored_mailboxes when it has enabled rows (select id, email,
-- enabled, status, last_polled_at ... enabled = true, status <> 'paused') and
-- would then poll every seeded address as a user mailbox. The same change set
-- pins that code to its hard-coded list, and this table deliberately has
-- neither a status nor a last_polled_at column (the cursor lives in
-- context_capture_runs, the review state is 'state'), so the old query is
-- refused by the database and falls back to the hard-coded list even in the
-- minutes between this migration and the function deploy. The contract test
-- runs that exact query and requires it to fail.
--
-- No switch is turned on. No existing row is written or rewritten, except
-- that a missing email_capture_v2 flag row is inserted as off. No grant,
-- policy or view is added for anon or authenticated.
--
-- Built on the LIVE production definitions, read from production 24 Sep 2026
-- (read-only): see the guard below. The guard refuses unless each object is
-- still that pre-image or already this migration's result (a re-apply).
-- Anything else is a live change nobody read, and replacing it would silently
-- revert it.
--
-- Rollback: supabase/rollbacks/20260924213000_context_email_capture_config_down.sql
-- restores F1b's stub (md5 checked), drops the functions, the two tables and
-- the three inbox_events columns, and deletes the flag row while it is still
-- off. It refuses while the flag is on or a sighting column holds a value.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text; t text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: F1b's stub, or this migration's body.
  ('public.context_email_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','39f700ff23752f161c2215ecc500ece8'],false),
  -- New: absent, or already this migration's body.
  ('public.context_email_capture_policy()',ARRAY['ae811e23b69cc7ea382ca727d1b61b39'],true),
  ('public.set_monitored_mailbox(text,boolean,text,text,text)',ARRAY['1c06b0e19359e747c29b921ae7145ac8'],true),
  ('public.context_email_capture_status_at(timestamptz)',ARRAY['3e6866177bdda5f89305aff50206d01d'],true)
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
 -- The two new tables: absent, or exactly this migration's columns.
 FOR x IN SELECT * FROM (VALUES
  ('monitored_mailboxes','address:text,source_key:text,kind:text,enabled:boolean,state:text,owner_privacy:boolean,files_supplier_pdfs:boolean,note:text,created_at:timestamp with time zone,updated_at:timestamp with time zone,updated_by:text'),
  ('monitored_mailbox_changes','id:bigint,address:text,changed_at:timestamp with time zone,actor:text,reason:text,before:jsonb,after:jsonb')
 ) AS t(tbl,want) LOOP
  IF to_regclass('public.'||x.tbl) IS NOT NULL THEN
   SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
   FROM pg_attribute a WHERE a.attrelid=('public.'||x.tbl)::regclass AND a.attnum>0 AND NOT a.attisdropped;
   IF cols IS DISTINCT FROM x.want THEN problems:=problems||format('%s exists with columns %s',x.tbl,cols); END IF;
  END IF;
 END LOOP;
 -- inbox_events: the live table, and the three sighting columns absent or ours.
 IF to_regclass('public.inbox_events') IS NULL THEN problems:=problems||'inbox_events missing'::text; END IF;
 FOR x IN SELECT * FROM (VALUES ('business_event_id','uuid'),('provider_message_id','text'),('folder_kind','text')) AS t(col,typ) LOOP
  SELECT format_type(a.atttypid,a.atttypmod) INTO t FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.inbox_events') AND a.attname=x.col AND NOT a.attisdropped;
  IF t IS NOT NULL AND t<>x.typ THEN problems:=problems||format('inbox_events.%s exists as %s',x.col,t); END IF;
 END LOOP;
 -- What this migration reads or references.
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

-- 1. The source list.
CREATE TABLE IF NOT EXISTS public.monitored_mailboxes (
 address text PRIMARY KEY,
 source_key text NOT NULL UNIQUE,
 kind text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'pending_review',
 owner_privacy boolean NOT NULL DEFAULT false,
 files_supplier_pdfs boolean NOT NULL DEFAULT false,
 note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL,
 CONSTRAINT monitored_mailboxes_address CHECK (address=lower(address) AND address ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'),
 CONSTRAINT monitored_mailboxes_source_key CHECK (source_key ~ '^[a-z][a-z0-9_]{1,40}$'),
 CONSTRAINT monitored_mailboxes_kind CHECK (kind IN ('user','group','unknown')),
 CONSTRAINT monitored_mailboxes_state CHECK (state IN ('active','pending_review')),
 -- Only a located, reviewed source is ever polled.
 CONSTRAINT monitored_mailboxes_enabled_active CHECK (NOT enabled OR state='active'),
 CONSTRAINT monitored_mailboxes_unknown_pending CHECK (kind<>'unknown' OR state='pending_review'),
 -- The two per-mailbox rules apply to user mailboxes only.
 CONSTRAINT monitored_mailboxes_user_rules CHECK (kind='user' OR NOT (owner_privacy OR files_supplier_pdfs)),
 CONSTRAINT monitored_mailboxes_note CHECK (note IS NULL OR length(note) BETWEEN 1 AND 300),
 CONSTRAINT monitored_mailboxes_updated_by CHECK (updated_by ~ '^[A-Za-z0-9_.:@-]{1,128}$')
);
ALTER TABLE public.monitored_mailboxes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.monitored_mailboxes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.monitored_mailboxes TO service_role;
COMMENT ON TABLE public.monitored_mailboxes IS
 'Outlook sources for email capture (email.md, slice EM1). One row per user mailbox or M365 group. Polled by the new poller (EM2) only while enabled and flag email_capture_v2 is on; enabling needs state active. Run rows in context_capture_runs are named outlook_<source_key>, outlook_sweep_<source_key>, outlook_history_<source_key>. owner_privacy: human-sent outbound mail is captured only with job evidence (D-EM3). files_supplier_pdfs: supplier PDF filing allowed (email.md §7 step 8). Written only by the EM1 seed and set_monitored_mailbox(). RLS on, no policies; service_role reads.';

CREATE TABLE IF NOT EXISTS public.monitored_mailbox_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 address text NOT NULL REFERENCES public.monitored_mailboxes(address),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor text NOT NULL,
 reason text NOT NULL,
 before jsonb NOT NULL,
 after jsonb NOT NULL,
 CONSTRAINT monitored_mailbox_changes_actor CHECK (actor ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
 CONSTRAINT monitored_mailbox_changes_reason CHECK (length(reason) BETWEEN 3 AND 300)
);
CREATE INDEX IF NOT EXISTS monitored_mailbox_changes_address ON public.monitored_mailbox_changes(address,changed_at DESC);
ALTER TABLE public.monitored_mailbox_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.monitored_mailbox_changes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.monitored_mailbox_changes TO service_role;
COMMENT ON TABLE public.monitored_mailbox_changes IS
 'Receipt of every change to monitored_mailboxes made through set_monitored_mailbox(): who (actor, INTEGRATION X31), when, why, and enabled/state before and after. Append-only; written only by set_monitored_mailbox(). RLS on, no policies; service_role reads.';

-- The captain's list, 24 Sep 2026. Re-apply leaves existing rows untouched.
INSERT INTO public.monitored_mailboxes(address,source_key,kind,enabled,state,owner_privacy,files_supplier_pdfs,note,updated_by) VALUES
 ('marnin@secureworkswa.com.au','marnin','user',true,'active',true,true,'Owner mailbox.','migration:20260924213000'),
 ('jan@secureworkswa.com.au','jan','user',true,'active',true,true,'Owner mailbox.','migration:20260924213000'),
 ('nithin@secureworkswa.com.au','nithin','user',true,'active',false,true,'Sales, patios.','migration:20260924213000'),
 ('shaun@secureworkswa.com.au','shaun','user',true,'active',false,true,'Operations.','migration:20260924213000'),
 ('admin@secureworkswa.com.au','admin','user',true,'active',false,true,'Shared admin mailbox.','migration:20260924213000'),
 ('khairo@secureworkswa.com.au','khairo','user',true,'active',false,false,'Sales, fencing. Not read by the old path. No PDF filing until private storage (F-EM6).','migration:20260924213000'),
 ('patios@secureworkswa.com.au','patios','group',true,'active',false,false,'Patios group.','migration:20260924213000'),
 ('fencing@secureworkswa.com.au','fencing','group',true,'active',false,false,'Fencing group.','migration:20260924213000'),
 ('finance@secureworkswa.com.au','finance','group',true,'active',false,false,'Supplier bills, remittances and delivery disputes.','migration:20260924213000'),
 ('approvals@secureworkswa.com.au','approvals','group',true,'active',false,false,'Plans and Approvals: council and certifier mail.','migration:20260924213000'),
 ('ses@secureworkswa.com.au','ses','group',true,'active',false,false,'SES make-safe intake group (captain 24 Sep). The make-safe intake pipeline keeps its own read.','migration:20260924213000'),
 ('info@secureworkswa.com.au','info','unknown',false,'pending_review',false,false,'Named to customers; delivery not located (email.md P1).','migration:20260924213000'),
 ('sales@secureworkswa.com.au','sales','unknown',false,'pending_review',false,false,'Named to customers; delivery not located (email.md P1).','migration:20260924213000'),
 ('plans@secureworkswa.com.au','plans','unknown',false,'pending_review',false,false,'Named to customers; may deliver to approvals@. Not located (email.md P1).','migration:20260924213000')
ON CONFLICT (address) DO NOTHING;

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
CREATE OR REPLACE FUNCTION public.set_monitored_mailbox(p_address text,p_enabled boolean,p_state text,p_reason text,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.monitored_mailboxes; addr text:=lower(btrim(coalesce(p_address,''))); why text:=btrim(coalesce(p_reason,''));
 new_enabled boolean; new_state text; before_v jsonb; after_v jsonb;
BEGIN
 IF p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'monitored_mailbox_actor_invalid'; END IF;
 IF length(why)<3 OR length(why)>300 OR why ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'monitored_mailbox_reason_invalid'; END IF;
 IF p_state IS NOT NULL AND p_state NOT IN ('active','pending_review') THEN RAISE EXCEPTION 'monitored_mailbox_state_invalid'; END IF;
 IF p_enabled IS NULL AND p_state IS NULL THEN RAISE EXCEPTION 'monitored_mailbox_change_missing'; END IF;
 SELECT * INTO r FROM public.monitored_mailboxes m WHERE m.address=addr FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'monitored_mailbox_unknown'; END IF;
 new_enabled:=coalesce(p_enabled,r.enabled);
 new_state:=coalesce(p_state,r.state);
 IF new_state='pending_review' AND p_enabled IS NULL THEN new_enabled:=false; END IF;
 IF new_enabled AND new_state<>'active' THEN RAISE EXCEPTION 'monitored_mailbox_enable_requires_active'; END IF;
 IF r.kind='unknown' AND new_state<>'pending_review' THEN RAISE EXCEPTION 'monitored_mailbox_kind_unknown'; END IF;
 before_v:=jsonb_build_object('enabled',r.enabled,'state',r.state);
 after_v:=jsonb_build_object('enabled',new_enabled,'state',new_state);
 IF before_v=after_v THEN
  RETURN jsonb_build_object('outcome','unchanged','address',r.address,'enabled',r.enabled,'state',r.state);
 END IF;
 UPDATE public.monitored_mailboxes m SET enabled=new_enabled,state=new_state,updated_at=clock_timestamp(),updated_by=p_actor WHERE m.address=r.address;
 INSERT INTO public.monitored_mailbox_changes(address,actor,reason,before,after) VALUES(r.address,p_actor,why,before_v,after_v);
 RETURN jsonb_build_object('outcome','updated','address',r.address,'enabled',new_enabled,'state',new_state,'before',before_v);
END $$;
COMMENT ON FUNCTION public.set_monitored_mailbox(text,boolean,text,text,text) IS
 'The one writer of monitored_mailboxes after the EM1 seed (ops-api set_monitored_mailbox). Changes enabled and/or state of an existing source, records updated_by and a monitored_mailbox_changes receipt; never adds or removes a source. Setting pending_review without naming enabled also disables. Refusal codes: monitored_mailbox_actor_invalid, monitored_mailbox_reason_invalid, monitored_mailbox_state_invalid, monitored_mailbox_change_missing, monitored_mailbox_unknown, monitored_mailbox_enable_requires_active, monitored_mailbox_kind_unknown.';

-- 5. Health: policy and the status block.
CREATE OR REPLACE FUNCTION public.context_email_capture_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'flag','email_capture_v2',
  'timezone','Australia/Perth',
  -- Run-row names in context_capture_runs, per source_key.
  'run_sources',jsonb_build_object('poll','outlook_<source_key>','sweep','outlook_sweep_<source_key>','history','outlook_history_<source_key>'),
  -- email_source_error: the last this many finished poll runs all failed ...
  'failed_runs_alarm',2,
  -- ... or no poll run finished for this long (the poll runs every 5 minutes).
  'no_run_alarm_minutes',15,
  -- email_backlog: the last this many finished poll runs all left pages behind.
  'backlog_runs_alarm',3,
  -- sweep_incomplete: each polled source must finish a sweep started at or
  -- after 02:00 Perth, checked from 03:00 Perth.
  'sweep_local_time','02:00',
  'sweep_grace_minutes',60,
  -- email_poll_missed: a sweep finished within this window found mail the poll missed.
  'sweep_miss_lookback_hours',26)
$$;
COMMENT ON FUNCTION public.context_email_capture_policy() IS
 'Thresholds and run-row names for context_email_capture_status() (EM1). Changed only by migration.';

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
 no_run interval:=make_interval(mins=>(policy->>'no_run_alarm_minutes')::integer);
 sweep_grace interval:=make_interval(mins=>(policy->>'sweep_grace_minutes')::integer);
 miss_lookback interval:=make_interval(hours=>(policy->>'sweep_miss_lookback_hours')::integer);
 flag_on boolean; flag_changed timestamptz; flag_state text:='present';
 lane_on boolean; alarms_active boolean;
 sweep_at timestamptz; sweep_due boolean;
 m record; poll jsonb; sweep jsonb; hist jsonb;
 poll_src text; sweep_src text; hist_src text;
 last_runs public.context_capture_runs[]; last_sweep public.context_capture_runs; last_hist public.context_capture_runs; miss_run public.context_capture_runs;
 recent_finish boolean; swept boolean; since timestamptz; polled boolean;
 n_failed integer; n_backlog integer; misses bigint;
 sources jsonb:='[]'::jsonb; alarms jsonb:='[]'::jsonb;
 n_sources integer:=0; n_polled integer:=0; n_pending integer:=0;
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

 FOR m IN SELECT * FROM public.monitored_mailboxes ORDER BY array_position(ARRAY['user','group','unknown'],kind),address LOOP
  n_sources:=n_sources+1;
  polled:=m.enabled AND m.state='active';
  IF polled THEN n_polled:=n_polled+1; END IF;
  IF m.state='pending_review' THEN n_pending:=n_pending+1; END IF;
  poll_src:='outlook_'||m.source_key; sweep_src:='outlook_sweep_'||m.source_key; hist_src:='outlook_history_'||m.source_key;
  SELECT coalesce(array_agg(c ORDER BY c.started_at DESC),'{}') INTO last_runs FROM (
   SELECT * FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status<>'running' ORDER BY r.started_at DESC LIMIT greatest(failed_n,backlog_n)) c;
  -- Bounded: judged on the latest finished poll only, never a scan of the source's history.
  recent_finish:=coalesce((last_runs[1]).finished_at>=now_time-no_run,false);
  SELECT count(*) FILTER (WHERE u.status='failed') INTO n_failed FROM unnest(last_runs[1:failed_n]) u;
  SELECT count(*) FILTER (WHERE (u.cursor->>'backlog')='true') INTO n_backlog FROM unnest(last_runs[1:backlog_n]) u;
  SELECT * INTO last_sweep FROM public.context_capture_runs r WHERE r.source=sweep_src ORDER BY r.started_at DESC LIMIT 1;
  SELECT * INTO last_hist FROM public.context_capture_runs r WHERE r.source=hist_src ORDER BY r.started_at DESC LIMIT 1;
  swept:=EXISTS(SELECT 1 FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.started_at>=sweep_at AND r.status='succeeded');
  -- The latest finished sweep inside the lookback: did it find mail the poll missed?
  SELECT * INTO miss_run FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.status<>'running' AND r.finished_at>=now_time-miss_lookback
  ORDER BY r.started_at DESC LIMIT 1;
  misses:=CASE WHEN jsonb_typeof(miss_run.counts->'sweep_misses')='number' THEN (miss_run.counts->>'sweep_misses')::bigint ELSE 0 END;
  -- Nothing is expected of a source before the flag, and its own enabling, have been in place.
  since:=greatest(flag_changed,m.updated_at);
  poll:=jsonb_build_object('run_source',poll_src,
   'last_started_at',(last_runs[1]).started_at,'last_finished_at',(last_runs[1]).finished_at,
   'last_status',(last_runs[1]).status,'last_error_code',(last_runs[1]).error_code,
   'last_succeeded_at',(SELECT max(r.finished_at) FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status='succeeded'),
   'failed_of_last',jsonb_build_object('runs',least(cardinality(last_runs),failed_n),'failed',n_failed),
   'backlog_of_last',jsonb_build_object('runs',least(cardinality(last_runs),backlog_n),'backlog',n_backlog));
  sweep:=jsonb_build_object('run_source',sweep_src,'last_started_at',last_sweep.started_at,'last_status',last_sweep.status,
   'last_error_code',last_sweep.error_code,'finished_since_last_0200',swept,'sweep_misses',misses);
  hist:=jsonb_build_object('run_source',hist_src,'last_started_at',last_hist.started_at,'last_status',last_hist.status,'last_error_code',last_hist.error_code);
  sources:=sources||jsonb_build_array(jsonb_build_object('address',m.address,'source_key',m.source_key,'kind',m.kind,
   'enabled',m.enabled,'state',m.state,'selected',polled,'owner_privacy',m.owner_privacy,'files_supplier_pdfs',m.files_supplier_pdfs,
   'poll',poll,'sweep',sweep,'history',hist));
  IF alarms_active AND polled THEN
   IF (cardinality(last_runs)>=failed_n AND n_failed=failed_n) THEN
    alarms:=alarms||jsonb_build_array(jsonb_build_object('key','email_source_error','severity','warning','since',(last_runs[failed_n]).started_at,
     'source',m.address,'reason','failed_last_runs','error_code',(last_runs[1]).error_code,
     'what_to_do','This mailbox failed its last polls. Check the Microsoft Graph credentials and the app''s permission on this mailbox or group.'));
   ELSIF NOT recent_finish AND (since IS NULL OR since<=now_time-no_run) THEN
    alarms:=alarms||jsonb_build_array(jsonb_build_object('key','email_source_error','severity','warning','since',coalesce((last_runs[1]).finished_at,since),
     'source',m.address,'reason','no_recent_run',
     'what_to_do','No poll of this mailbox has finished in the last 15 minutes. Check that the monitor-inbox cron job runs and that the function is not failing.'));
   END IF;
   IF cardinality(last_runs)>=backlog_n AND n_backlog=backlog_n THEN
    alarms:=alarms||jsonb_build_array(jsonb_build_object('key','email_backlog','severity','warning','since',(last_runs[backlog_n]).started_at,
     'source',m.address,'what_to_do','This mailbox has had more mail than one poll reads for three polls running. It will catch up; if it does not, raise the page bound.'));
   END IF;
   IF misses>0 THEN
    alarms:=alarms||jsonb_build_array(jsonb_build_object('key','email_poll_missed','severity','warning','since',miss_run.started_at,
     'source',m.address,'sweep_misses',misses,
     'what_to_do','The nightly sweep found mail the 5-minute poll missed (now captured). Check the poll''s run rows for this mailbox.'));
   END IF;
   IF sweep_due AND NOT swept AND (since IS NULL OR since<sweep_at) THEN
    alarms:=alarms||jsonb_build_array(jsonb_build_object('key','sweep_incomplete','severity','warning','since',sweep_at,
     'source',m.address,'last_status',last_sweep.status,
     'what_to_do','This mailbox did not finish its 02:00 sweep. Check the monitor-inbox-sweep cron job and this mailbox''s sweep run rows.'));
   END IF;
  END IF;
 END LOOP;
 IF alarms_active AND n_polled=0 THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','email_source_error','severity','warning','since',flag_changed,'source',NULL,
   'reason','no_polled_sources','what_to_do','Email capture is on but no mailbox is enabled. Enable the mailboxes with set_monitored_mailbox.'));
 END IF;
 RETURN jsonb_build_object('as_of',now_time,
  'flag',jsonb_build_object('name',policy->>'flag','enabled',coalesce(flag_on,false),'updated_at',flag_changed,'state',flag_state),
  'capture_lane',lane_on,'alarms_active',alarms_active,'last_sweep_due_at',sweep_at,
  'counts',jsonb_build_object('sources',n_sources,'selected',n_polled,'pending_review',n_pending),
  'policy',policy,'sources',sources,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_email_capture_status_at(timestamptz) IS
 'context_email_capture_status() judged at p_now (null = now()). For tests and diagnosis; same output shape.';

CREATE OR REPLACE FUNCTION public.context_email_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.context_email_capture_status_at(now()) $$;
COMMENT ON FUNCTION public.context_email_capture_status() IS
 'Status block email_capture (EM1, replacing the F1b stub): every monitored_mailboxes source with its poll, sweep and history run rows, and alarms email_source_error, email_poll_missed, email_backlog, sweep_incomplete, raised only while flag email_capture_v2 and the capture lane are on. Ids and codes only.';

-- 6. Grants. No PUBLIC, anon or authenticated execute; service_role only.
REVOKE ALL ON FUNCTION
 public.set_monitored_mailbox(text,boolean,text,text,text),public.context_email_capture_policy(),
 public.context_email_capture_status_at(timestamptz),public.context_email_capture_status()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.set_monitored_mailbox(text,boolean,text,text,text),public.context_email_capture_policy(),
 public.context_email_capture_status_at(timestamptz),public.context_email_capture_status()
TO service_role;
