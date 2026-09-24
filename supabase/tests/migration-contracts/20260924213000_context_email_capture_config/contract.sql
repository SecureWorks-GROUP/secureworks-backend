-- EM1 contract (email.md §14 row EM1: seed list; alarms on fabricated run
-- rows; grants). Every write is inside BEGIN / ROLLBACK.

-- 1. The seed list: the captain's 24 Sep list, exactly.
DO $$
DECLARE got text; want text;
BEGIN
 SELECT string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s',email,source_key,kind,enabled::text,status,owner_privacy::text,files_supplier_pdfs::text,scope_label,privacy_classification),E'\n' ORDER BY email)
 INTO got FROM public.monitored_mailboxes;
 want:=array_to_string(ARRAY[
  'admin@secureworkswa.com.au|admin|user|true|active|false|true|admin|restricted_pii',
  'approvals@secureworkswa.com.au|approvals|group|true|active|false|false|approvals|staff_only',
  'fencing@secureworkswa.com.au|fencing|group|true|active|false|false|fencing|staff_only',
  'finance@secureworkswa.com.au|finance|group|true|active|false|false|finance|staff_only',
  'info@secureworkswa.com.au|info|unknown|false|pending_review|false|false|other|staff_only',
  'jan@secureworkswa.com.au|jan|user|true|active|true|true|owner|restricted_pii',
  'khairo@secureworkswa.com.au|khairo|user|true|active|false|false|sales|restricted_pii',
  'marnin@secureworkswa.com.au|marnin|user|true|active|true|true|owner|restricted_pii',
  'nithin@secureworkswa.com.au|nithin|user|true|active|false|true|sales|restricted_pii',
  'patios@secureworkswa.com.au|patios|group|true|active|false|false|patios|staff_only',
  'plans@secureworkswa.com.au|plans|unknown|false|pending_review|false|false|approvals|staff_only',
  'sales@secureworkswa.com.au|sales|unknown|false|pending_review|false|false|sales|staff_only',
  'ses@secureworkswa.com.au|ses|group|true|active|false|false|ses|staff_only',
  'shaun@secureworkswa.com.au|shaun|user|true|active|false|true|ops|restricted_pii'],E'\n');
 IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'em1 seed list: got %', got; END IF;
 IF EXISTS(SELECT 1 FROM public.monitored_mailboxes WHERE updated_by<>'migration:20260924213000')
 THEN RAISE EXCEPTION 'em1 seed: updated_by not the migration'; END IF;
 IF EXISTS(SELECT 1 FROM public.monitored_mailbox_changes) THEN RAISE EXCEPTION 'em1 seed: the seed wrote change receipts'; END IF;
 -- Every run-source name the status block derives passes record_capture_run's grammar.
 IF EXISTS(SELECT 1 FROM public.monitored_mailboxes m, unnest(ARRAY['outlook_','outlook_sweep_','outlook_history_']) p
  WHERE (p||m.source_key) !~ '^[a-z][a-z0-9_]{2,62}$') THEN RAISE EXCEPTION 'em1 seed: a run source name is invalid'; END IF;
END $$;

-- 2. Flag off, and the old path cannot read the table.
DO $$
DECLARE refused boolean:=false;
BEGIN
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='email_capture_v2')<>1
  OR (SELECT enabled FROM public.feature_flags WHERE flag_name='email_capture_v2')
 THEN RAISE EXCEPTION 'em1 flag: email_capture_v2 must be exactly one row, off'; END IF;
 -- The exact query the deployed old monitor-inbox path runs (before this
 -- change set's pin deploys). It must be refused, so that path stays on its
 -- hard-coded list (email.md review M14, named row E22).
 BEGIN
  PERFORM id,email,enabled,status,last_polled_at FROM public.monitored_mailboxes WHERE enabled=true AND status<>'paused';
 EXCEPTION WHEN undefined_column THEN refused:=true;
 END;
 IF NOT refused THEN RAISE EXCEPTION 'em1 E22: the old path query against monitored_mailboxes was not refused'; END IF;
END $$;

-- 3. Access: nothing for the website key or signed-in logins; service_role
-- reads the tables and executes the functions, and cannot write the tables
-- directly.
DO $$
DECLARE r text; t text; f text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.monitored_mailboxes','public.monitored_mailbox_changes'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=t::regclass) THEN RAISE EXCEPTION 'em1 access: RLS off on %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname||'.'||tablename=t AND NOT roles<@ARRAY['service_role']::name[])
  THEN RAISE EXCEPTION 'em1 access: % has a policy for a role other than service_role',t; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_table_privilege(r,t,'select') OR has_table_privilege(r,t,'insert') OR has_table_privilege(r,t,'update') OR has_table_privilege(r,t,'delete')
   THEN RAISE EXCEPTION 'em1 access: % has a privilege on %',r,t; END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role',t,'select') THEN RAISE EXCEPTION 'em1 access: service_role cannot read %',t; END IF;
  IF has_table_privilege('service_role',t,'insert') OR has_table_privilege('service_role',t,'update') OR has_table_privilege('service_role',t,'delete')
  THEN RAISE EXCEPTION 'em1 access: service_role can write % directly',t; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.set_monitored_mailbox(text,boolean,text,text,text)','public.context_email_capture_policy()',
   'public.context_email_capture_status_at(timestamptz)','public.context_email_capture_status()'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','public'] LOOP
   IF r='public' THEN
    IF EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f::regprocedure AND a.grantee=0)
    THEN RAISE EXCEPTION 'em1 access: PUBLIC can execute %',f; END IF;
   ELSIF has_function_privilege(r,f,'execute') THEN RAISE EXCEPTION 'em1 access: % can execute %',r,f; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role',f,'execute') THEN RAISE EXCEPTION 'em1 access: service_role cannot execute %',f; END IF;
 END LOOP;
 IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.set_monitored_mailbox(text,boolean,text,text,text)'::regprocedure)
 THEN RAISE EXCEPTION 'em1 access: set_monitored_mailbox is not SECURITY DEFINER'; END IF;
END $$;

-- 3b. Built on the live draft table: its cursor column and index are gone,
-- enabled defaults to off, scope_label takes approvals and ses (one rule), the
-- draft's authenticated_select policy is gone and a new row with no enabled
-- is not selected.
DO $$
DECLARE bad boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.monitored_mailboxes'::regclass AND attname='last_polled_at' AND NOT attisdropped)
  OR to_regclass('public.idx_monitored_mailboxes_enabled') IS NOT NULL
 THEN RAISE EXCEPTION 'em1 table: the draft cursor column or its index survived'; END IF;
 IF (SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef WHERE adrelid='public.monitored_mailboxes'::regclass
     AND adnum=(SELECT attnum FROM pg_attribute WHERE attrelid='public.monitored_mailboxes'::regclass AND attname='enabled'))<>'false'
 THEN RAISE EXCEPTION 'em1 table: enabled does not default to false'; END IF;
 IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid='public.monitored_mailboxes'::regclass AND c.contype='c'
     AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='scope_label')]::int2[])<>1
 THEN RAISE EXCEPTION 'em1 table: scope_label must have exactly one check'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monitored_mailboxes' AND policyname='authenticated_select')
 THEN RAISE EXCEPTION 'em1 table: authenticated_select survived'; END IF;
 BEGIN
  INSERT INTO public.monitored_mailboxes(email,source_key,kind,scope_label,updated_by) VALUES('x@secureworkswa.com.au','x_new','user','other','t');
  IF (SELECT enabled FROM public.monitored_mailboxes WHERE email='x@secureworkswa.com.au') THEN RAISE EXCEPTION 'em1 table: a new row is enabled by default'; END IF;
  bad:=false;
  BEGIN INSERT INTO public.monitored_mailboxes(email,source_key,kind,scope_label,updated_by) VALUES('y@secureworkswa.com.au','y_new','user','council','t');
  EXCEPTION WHEN check_violation THEN bad:=true; END;
  IF NOT bad THEN RAISE EXCEPTION 'em1 table: an unknown scope_label was accepted'; END IF;
  bad:=false;
  BEGIN INSERT INTO public.monitored_mailboxes(email,source_key,kind,scope_label,enabled,status,updated_by) VALUES('z@secureworkswa.com.au','z_new','user','other',true,'paused','t');
  EXCEPTION WHEN check_violation THEN bad:=true; END;
  IF NOT bad THEN RAISE EXCEPTION 'em1 table: an enabled paused source was accepted'; END IF;
  RAISE EXCEPTION 'em1_rollback_block';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'em1_rollback_block' THEN RAISE; END IF;
 END;
END $$;

-- 4. inbox_events: three new columns, every existing row untouched, the
-- constraints hold.
DO $$
BEGIN
 IF (SELECT string_agg(attname||':'||format_type(atttypid,atttypmod),',' ORDER BY attname) FROM pg_attribute
     WHERE attrelid='public.inbox_events'::regclass AND attname IN ('business_event_id','provider_message_id','folder_kind') AND NOT attisdropped)
   IS DISTINCT FROM 'business_event_id:uuid,folder_kind:text,provider_message_id:text'
 THEN RAISE EXCEPTION 'em1 inbox_events: sighting columns wrong'; END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_events WHERE business_event_id IS NOT NULL OR provider_message_id IS NOT NULL OR folder_kind IS NOT NULL)
 THEN RAISE EXCEPTION 'em1 inbox_events: a sighting column holds a value'; END IF;
 IF (SELECT relrowsecurity FROM pg_class WHERE oid='public.inbox_events'::regclass) IS NOT TRUE
 THEN RAISE EXCEPTION 'em1 inbox_events: RLS off'; END IF;
END $$;

BEGIN;
DO $$
DECLARE ev uuid:=gen_random_uuid(); bad boolean;
BEGIN
 -- The old path's insert shape still works and leaves the sighting columns null.
 INSERT INTO public.inbox_events(id,graph_message_id,mailbox,subject,body_preview,received_at,metadata)
 VALUES('e1e1e1e1-0000-4000-8000-000000000001','AAMk-legacy-fixture-1','nithin@secureworkswa.com.au','fixture subject','legacy preview','2026-09-18 04:27+00','{"legacy":true}');
 IF NOT EXISTS(SELECT 1 FROM public.inbox_events WHERE id='e1e1e1e1-0000-4000-8000-000000000001'
   AND business_event_id IS NULL AND provider_message_id IS NULL AND folder_kind IS NULL)
 THEN RAISE EXCEPTION 'em1 inbox_events: an old-path insert got sighting values'; END IF;
 INSERT INTO public.business_events(id) VALUES(ev);
 INSERT INTO public.inbox_events(id,graph_message_id,mailbox,business_event_id,provider_message_id,folder_kind)
 VALUES('e1e1e1e1-0000-4000-8000-000000000002','AAMk-sighting','nithin@secureworkswa.com.au',ev,'email:abc@example.com','sent');
 -- A sighting may point only at a real evidence row.
 bad:=false;
 BEGIN INSERT INTO public.inbox_events(id,business_event_id) VALUES(gen_random_uuid(),gen_random_uuid());
 EXCEPTION WHEN foreign_key_violation THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'em1 inbox_events: sighting to a missing evidence row accepted'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.inbox_events(id,folder_kind) VALUES(gen_random_uuid(),'junk');
 EXCEPTION WHEN check_violation THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'em1 inbox_events: folder_kind junk accepted'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.inbox_events(id,provider_message_id) VALUES(gen_random_uuid(),'ghl:abc');
 EXCEPTION WHEN check_violation THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'em1 inbox_events: a non-email key accepted'; END IF;
 -- Deleting the evidence row clears the pointer; the sighting stays.
 DELETE FROM public.business_events WHERE id=ev;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_events WHERE id='e1e1e1e1-0000-4000-8000-000000000002' AND business_event_id IS NULL)
 THEN RAISE EXCEPTION 'em1 inbox_events: ON DELETE SET NULL did not hold'; END IF;
END $$;
ROLLBACK;

-- 5. The one writer: set_monitored_mailbox.
BEGIN;
DO $$
DECLARE r jsonb; code text; n integer;
BEGIN
 -- Disable khairo@: updated, updated_by and one receipt.
 r:=public.set_monitored_mailbox('Khairo@SecureWorksWA.com.au',false,NULL,'pause while Khairo is told (email.md P5)','user:0b7e0c0e-1111-4222-8333-444455556666');
 IF r->>'outcome'<>'updated' OR (r->>'enabled')::boolean THEN RAISE EXCEPTION 'em1 setter: disable gave %',r; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.monitored_mailboxes WHERE email='khairo@secureworkswa.com.au' AND NOT enabled
   AND updated_by='user:0b7e0c0e-1111-4222-8333-444455556666')
 THEN RAISE EXCEPTION 'em1 setter: khairo row not updated with the actor'; END IF;
 SELECT count(*) INTO n FROM public.monitored_mailbox_changes WHERE email='khairo@secureworkswa.com.au'
  AND actor='user:0b7e0c0e-1111-4222-8333-444455556666' AND before='{"enabled":true,"status":"active"}' AND after='{"enabled":false,"status":"active"}';
 IF n<>1 THEN RAISE EXCEPTION 'em1 setter: expected one receipt, got %',n; END IF;
 -- The same change again: unchanged, no second receipt.
 r:=public.set_monitored_mailbox('khairo@secureworkswa.com.au',false,NULL,'again','workflow:test');
 IF r->>'outcome'<>'unchanged' OR (SELECT count(*) FROM public.monitored_mailbox_changes)<>1 THEN RAISE EXCEPTION 'em1 setter: repeat gave %',r; END IF;
 -- Setting pending_review without naming enabled also disables.
 r:=public.set_monitored_mailbox('shaun@secureworkswa.com.au',NULL,'pending_review','mailbox under review','actor_missing');
 IF r->>'outcome'<>'updated' OR (r->>'enabled')::boolean OR r->>'status'<>'pending_review' THEN RAISE EXCEPTION 'em1 setter: pending_review gave %',r; END IF;
 -- Refusals, each by its code, each writing nothing.
 FOR code,r IN SELECT * FROM (VALUES
   ('monitored_mailbox_enable_requires_active',jsonb_build_object('a','info@secureworkswa.com.au','e',true,'s',NULL,'why','turn it on','who','workflow:test')),
   ('monitored_mailbox_kind_unknown',jsonb_build_object('a','info@secureworkswa.com.au','e',NULL,'s','active','why','located','who','workflow:test')),
   ('monitored_mailbox_unknown',jsonb_build_object('a','nobody@secureworkswa.com.au','e',false,'s',NULL,'why','nope','who','workflow:test')),
   ('monitored_mailbox_reason_invalid',jsonb_build_object('a','jan@secureworkswa.com.au','e',false,'s',NULL,'why','x','who','workflow:test')),
   ('monitored_mailbox_reason_invalid',jsonb_build_object('a','jan@secureworkswa.com.au','e',false,'s',NULL,'why',E'two\nlines','who','workflow:test')),
   ('monitored_mailbox_status_invalid',jsonb_build_object('a','jan@secureworkswa.com.au','e',NULL,'s','paused','why','pause it','who','workflow:test')),
   ('monitored_mailbox_change_missing',jsonb_build_object('a','jan@secureworkswa.com.au','e',NULL,'s',NULL,'why','nothing','who','workflow:test')),
   ('monitored_mailbox_actor_invalid',jsonb_build_object('a','jan@secureworkswa.com.au','e',false,'s',NULL,'why','no actor','who','two words')),
   ('monitored_mailbox_actor_invalid',jsonb_build_object('a','jan@secureworkswa.com.au','e',false,'s',NULL,'why','no actor','who',NULL))
  ) AS t(c,args) LOOP
  BEGIN
   PERFORM public.set_monitored_mailbox(r->>'a',(r->>'e')::boolean,r->>'s',r->>'why',r->>'who');
   RAISE EXCEPTION 'em1 setter: expected %', code;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM<>code THEN RAISE EXCEPTION 'em1 setter: expected %, got %',code,SQLERRM; END IF;
  END;
 END LOOP;
 IF (SELECT count(*) FROM public.monitored_mailbox_changes)<>2 THEN RAISE EXCEPTION 'em1 setter: a refusal wrote a receipt'; END IF;
 IF NOT (SELECT enabled FROM public.monitored_mailboxes WHERE email='jan@secureworkswa.com.au') THEN RAISE EXCEPTION 'em1 setter: a refusal changed jan@'; END IF;
 -- Re-enabling a reviewed source works.
 r:=public.set_monitored_mailbox('shaun@secureworkswa.com.au',true,'active','back from review','workflow:test');
 IF r->>'outcome'<>'updated' OR NOT (r->>'enabled')::boolean THEN RAISE EXCEPTION 'em1 setter: re-enable gave %',r; END IF;
END $$;
ROLLBACK;

-- 6. Status block and alarms on fabricated run rows, at a fixed clock.
-- T = 2026-09-24 10:00 Perth; last 02:00 Perth = 2026-09-24 02:00.
BEGIN;
UPDATE public.feature_flags SET enabled=true,updated_at='2026-09-20 09:00+08' WHERE flag_name='email_capture_v2';
UPDATE public.monitored_mailboxes SET updated_at='2026-09-20 09:00+08';
-- A run row: source, status, started (Perth), minutes long, counts, cursor, error code.
CREATE TEMP TABLE em1_runs(src text, st text, at timestamptz, mins integer, counts jsonb, cur jsonb, err text) ON COMMIT DROP;
INSERT INTO em1_runs VALUES
 -- marnin@: last two polls failed (E: email_source_error failed_last_runs).
 ('outlook_marnin','succeeded','2026-09-24 09:45+08',1,'{}',NULL,NULL),
 ('outlook_marnin','failed','2026-09-24 09:50+08',1,'{}',NULL,'graph_403'),
 ('outlook_marnin','failed','2026-09-24 09:55+08',1,'{}',NULL,'graph_403'),
 ('outlook_sweep_marnin','succeeded','2026-09-24 02:00+08',2,'{"sweep_misses":0}',NULL,NULL),
 -- jan@: three polls in a row left pages behind (email_backlog); recent, so no source error.
 ('outlook_jan','succeeded','2026-09-24 09:45+08',1,'{}','{"backlog":true}',NULL),
 ('outlook_jan','succeeded','2026-09-24 09:50+08',1,'{}','{"backlog":true}',NULL),
 ('outlook_jan','succeeded','2026-09-24 09:55+08',1,'{}','{"backlog":true}',NULL),
 ('outlook_sweep_jan','succeeded','2026-09-24 02:01+08',2,'{"sweep_misses":0}',NULL,NULL),
 -- nithin@: the sweep found two messages the poll missed (email_poll_missed).
 ('outlook_nithin','succeeded','2026-09-24 09:55+08',1,'{}','{"backlog":false}',NULL),
 ('outlook_sweep_nithin','succeeded','2026-09-24 02:02+08',2,'{"sweep_misses":2}',NULL,NULL),
 -- shaun@: the sweep was cut by its budget (sweep_incomplete).
 ('outlook_shaun','succeeded','2026-09-24 09:55+08',1,'{}',NULL,NULL),
 ('outlook_sweep_shaun','partial','2026-09-24 02:03+08',2,'{"sweep_misses":0}',NULL,NULL),
 -- admin@: healthy. An old failure long before does not count; two polls since succeeded.
 ('outlook_admin','failed','2026-09-23 09:00+08',1,'{}',NULL,'graph_throttled'),
 ('outlook_admin','succeeded','2026-09-24 09:50+08',1,'{}',NULL,NULL),
 ('outlook_admin','succeeded','2026-09-24 09:55+08',1,'{}',NULL,NULL),
 ('outlook_sweep_admin','succeeded','2026-09-24 02:04+08',2,'{"sweep_misses":0}',NULL,NULL),
 ('outlook_history_admin','partial','2026-09-24 03:00+08',2,'{}',NULL,'budget_exhausted');
-- The other selected sources are healthy too, except khairo@ (no runs at all).
INSERT INTO em1_runs SELECT 'outlook_'||k,'succeeded','2026-09-24 09:55+08',1,'{}',NULL,NULL FROM unnest(ARRAY['patios','fencing','finance','approvals','ses']) k;
INSERT INTO em1_runs SELECT 'outlook_sweep_'||k,'succeeded','2026-09-24 02:05+08',2,'{"sweep_misses":0}',NULL,NULL FROM unnest(ARRAY['patios','fencing','finance','approvals','ses']) k;
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts,cursor,error_code)
SELECT src,st,at,at+make_interval(mins=>mins),at+make_interval(mins=>mins),counts,cur,err FROM em1_runs;

DO $$
DECLARE s jsonb; got text; want text; a jsonb; l jsonb;
BEGIN
 s:=public.context_email_capture_status_at('2026-09-24 10:00+08');
 IF NOT (s->>'alarms_active')::boolean OR NOT (s#>>'{flag,enabled}')::boolean THEN RAISE EXCEPTION 'em1 status: alarms not active with flag on'; END IF;
 IF s->'counts'<>'{"sources":14,"selected":11,"pending_review":3}' THEN RAISE EXCEPTION 'em1 status: counts %',s->'counts'; END IF;
 -- One line per shared label, the personal mailboxes (owner, sales, ops,
 -- other) only as one combined line, last.
 SELECT string_agg(format('%s|%s|%s|%s|%s|%s|%s',x->>'line',x->>'sources',x->>'selected',x->>'pending_review',x->>'healthy',x->>'erroring',x->>'never_seen'),E'\n' ORDER BY ord)
 INTO got FROM jsonb_array_elements(s->'lines') WITH ORDINALITY AS t(x,ord);
 want:=array_to_string(ARRAY[
  'admin|1|1|0|1|0|0',
  'approvals|2|1|1|1|0|0',
  'fencing|1|1|0|1|0|0',
  'finance|1|1|0|1|0|0',
  'patios|1|1|0|1|0|0',
  'ses|1|1|0|1|0|0',
  'personal|7|5|2|0|5|1'],E'\n');
 IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'em1 lines at 10:00: got %', got; END IF;
 SELECT x INTO l FROM jsonb_array_elements(s->'lines') x WHERE x->>'line'='personal';
 IF (l->>'oldest_last_seen_at')::timestamptz<>'2026-09-24 09:46+08' OR NOT (l->>'personal')::boolean THEN RAISE EXCEPTION 'em1 personal line: %',l; END IF;
 SELECT x INTO l FROM jsonb_array_elements(s->'lines') x WHERE x->>'line'='admin';
 IF (l->>'oldest_last_seen_at')::timestamptz<>'2026-09-24 09:56+08' OR (l->>'personal')::boolean THEN RAISE EXCEPTION 'em1 admin line: %',l; END IF;
 -- Alarms per line and key, counting sources, never naming one:
 -- marnin@ two failed polls, jan@ three backlog polls, nithin@ a sweep that
 -- found 2 misses, shaun@ a partial sweep and khairo@ no sweep at all.
 SELECT string_agg(format('%s|%s|%s',x->>'line',x->>'key',x->>'sources'),E'\n' ORDER BY x->>'line',x->>'key') INTO got
 FROM jsonb_array_elements(s->'alarms') x;
 want:=array_to_string(ARRAY[
  'personal|email_backlog|1',
  'personal|email_poll_missed|1',
  'personal|email_source_error|1',
  'personal|sweep_incomplete|2'],E'\n');
 IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'em1 alarms at 10:00: got %', got; END IF;
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='email_source_error';
 IF a->'error_codes'<>'["graph_403"]' OR (a->>'since')::timestamptz<>'2026-09-24 09:50+08' THEN RAISE EXCEPTION 'em1 alarm detail: %',a; END IF;
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='email_poll_missed';
 IF (a->>'sweep_misses')::integer<>2 THEN RAISE EXCEPTION 'em1 alarm detail: %',a; END IF;
 -- No mailbox identity or privacy setting anywhere in the block: no address,
 -- source key, run-row name, privacy field, or personal scope label on a line
 -- or alarm.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'lines') x WHERE x->>'line' IN ('owner','sales','ops','other')
     OR x ?| ARRAY['email','source_key','scope_label','owner_privacy','files_supplier_pdfs'])
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'line' IN ('owner','sales','ops','other')
     OR x ?| ARRAY['source','email','source_key','scope_label','owner_privacy','files_supplier_pdfs'])
  OR s::text ~* '@secureworkswa[.]com[.]au|outlook_(marnin|jan|nithin|shaun|khairo|admin)|owner_privacy|files_supplier_pdfs|restricted_pii'
 THEN RAISE EXCEPTION 'em1 status: mailbox identity or privacy settings leaked: %',s; END IF;

 -- Before 03:00 Perth the night's sweep is not yet due: no sweep_incomplete.
 s:=public.context_email_capture_status_at('2026-09-24 02:30+08');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='sweep_incomplete') THEN RAISE EXCEPTION 'em1 alarms at 02:30: sweep_incomplete raised early'; END IF;
END $$;

-- The flag off (or the capture lane off): lines listed, no alarm at all.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='email_capture_v2';
DO $$
DECLARE s jsonb:=public.context_email_capture_status_at('2026-09-24 10:00+08');
BEGIN
 IF jsonb_array_length(s->'alarms')<>0 OR (s->>'alarms_active')::boolean OR jsonb_array_length(s->'lines')<>7
 THEN RAISE EXCEPTION 'em1 status flag off: %',s->'alarms'; END IF;
END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_capture_v2';
UPDATE public.automation_switches SET capture=false WHERE id=1;
DO $$
DECLARE s jsonb:=public.context_email_capture_status_at('2026-09-24 10:00+08');
BEGIN
 IF jsonb_array_length(s->'alarms')<>0 OR (s->>'capture_lane')::boolean THEN RAISE EXCEPTION 'em1 status lane off: %',s->'alarms'; END IF;
END $$;
UPDATE public.automation_switches SET capture=true WHERE id=1;

-- A source switched on after 02:00 is not expected to have swept last night
-- (khairo@: only shaun@'s partial sweep remains), and a flag turned on after
-- 02:00 expects no sweep at all.
UPDATE public.monitored_mailboxes SET updated_at='2026-09-24 09:55+08' WHERE email='khairo@secureworkswa.com.au';
DO $$
DECLARE s jsonb:=public.context_email_capture_status_at('2026-09-24 10:00+08');
BEGIN
 IF (SELECT x->>'sources' FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='sweep_incomplete') IS DISTINCT FROM '1'
 THEN RAISE EXCEPTION 'em1 status: freshly enabled khairo@ expected a sweep: %',s->'alarms'; END IF;
END $$;
UPDATE public.feature_flags SET updated_at='2026-09-24 08:00+08' WHERE flag_name='email_capture_v2';
DO $$
DECLARE s jsonb:=public.context_email_capture_status_at('2026-09-24 10:00+08');
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='sweep_incomplete')
 THEN RAISE EXCEPTION 'em1 status: sweep expected before the flag was on'; END IF;
END $$;

-- Only selected sources are judged: with every source switched off there is
-- no alarm, whatever their run rows say.
UPDATE public.monitored_mailboxes SET enabled=false;
DO $$
DECLARE s jsonb:=public.context_email_capture_status_at('2026-09-24 10:00+08');
BEGIN
 IF jsonb_array_length(s->'alarms')<>0 OR s#>>'{counts,selected}'<>'0' THEN RAISE EXCEPTION 'em1 status nothing selected: %',s->'alarms'; END IF;
END $$;
ROLLBACK;

-- 7. The composer carries the block and its alarms (real clock).
BEGIN;
UPDATE public.feature_flags SET enabled=true,updated_at=now()-interval '2 days' WHERE flag_name='email_capture_v2';
UPDATE public.monitored_mailboxes SET updated_at=now()-interval '2 days';
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts,error_code)
VALUES ('outlook_marnin','failed',now()-interval '9 minutes',now()-interval '8 minutes',now()-interval '8 minutes','{}','graph_403'),
       ('outlook_marnin','failed',now()-interval '4 minutes',now()-interval '3 minutes',now()-interval '3 minutes','{}','graph_403');
DO $$
DECLARE s jsonb:=public.context_pipeline_status();
BEGIN
 IF s->'email_capture' IS NULL OR jsonb_typeof(s->'email_capture')<>'object' OR s#>>'{email_capture,counts,sources}'<>'14'
 THEN RAISE EXCEPTION 'em1 composer: email_capture block %',s->'email_capture'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x
   WHERE x->>'block'='email_capture' AND x->>'key'='email_source_error' AND x->>'line'='personal' AND x->>'sources'='1')
 THEN RAISE EXCEPTION 'em1 composer: alarm not carried: %',s->'alarms'; END IF;
 -- Health is staff-visible; mailbox identity and privacy settings stay service-role only.
 IF (s->'email_capture')::text ~* '@secureworkswa[.]com[.]au|outlook_(marnin|jan|nithin|shaun|khairo)|owner_privacy|files_supplier_pdfs'
  OR (s->'email_capture')::text ~* 'subject|body|preview'
 THEN RAISE EXCEPTION 'em1 composer: identity, privacy settings or mail text leaked'; END IF;
END $$;
ROLLBACK;

-- 8. Today, flag off, no runs: the block reads, raises no alarm.
DO $$
DECLARE s jsonb:=public.context_pipeline_status();
BEGIN
 IF jsonb_array_length(s#>'{email_capture,alarms}')<>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'block'='email_capture')
 THEN RAISE EXCEPTION 'em1 today: the email block raised an alarm with the flag off'; END IF;
END $$;

-- 9. Re-apply is a no-op that clobbers nothing: a later owner change and the
-- flag's state survive.
BEGIN;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_capture_v2';
SELECT public.set_monitored_mailbox('ses@secureworkswa.com.au',false,NULL,'owner paused ses@','workflow:test');
\ir ../../../migrations/20260924213000_context_email_capture_config.sql
DO $$
BEGIN
 IF NOT (SELECT enabled FROM public.feature_flags WHERE flag_name='email_capture_v2') THEN RAISE EXCEPTION 'em1 re-apply: flag clobbered'; END IF;
 IF (SELECT enabled FROM public.monitored_mailboxes WHERE email='ses@secureworkswa.com.au') THEN RAISE EXCEPTION 'em1 re-apply: owner change clobbered'; END IF;
 IF (SELECT count(*) FROM public.monitored_mailboxes)<>14 OR (SELECT count(*) FROM public.monitored_mailbox_changes)<>1 THEN RAISE EXCEPTION 'em1 re-apply: rows changed'; END IF;
END $$;
ROLLBACK;
