-- MN1 contract: the verified-read column, the mode parser, the money status
-- block and its alarms, the composer, the sweep's receipt shape, and grants.

-- 1. The column: timestamptz, nullable, no default; existing rows unverified.
DO $$
DECLARE t text; nn boolean; d text;
BEGIN
 SELECT format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(ad.adbin,ad.adrelid) INTO t,nn,d
 FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
 WHERE a.attrelid='public.xero_invoices'::regclass AND a.attname='xero_verified_at' AND NOT a.attisdropped;
 IF t IS DISTINCT FROM 'timestamp with time zone' OR nn OR d IS NOT NULL THEN
  RAISE EXCEPTION 'mn1 column: xero_verified_at is % notnull % default %',t,nn,d;
 END IF;
 IF EXISTS(SELECT 1 FROM public.xero_invoices WHERE xero_verified_at IS NOT NULL) THEN
  RAISE EXCEPTION 'mn1 column: an existing row was stamped verified';
 END IF;
END $$;

-- 2. The mode parser. Missing reads as off; apply needs money_open_book_v1.
BEGIN;
DO $$
DECLARE m jsonb;
BEGIN
 m:=public.context_money_open_book_mode();
 IF m->>'mode'<>'off' OR m->>'state'<>'missing' THEN RAISE EXCEPTION 'mn1 missing flags must read off/missing: %',m; END IF;
 INSERT INTO public.feature_flags(flag_name,enabled) VALUES('money_open_book_apply_v1',true);
 m:=public.context_money_open_book_mode();
 IF m->>'mode'<>'off' THEN RAISE EXCEPTION 'mn1 apply flag alone must read off: %',m; END IF;
 INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('money_open_book_v1',false,now()-interval '3 hours');
 IF public.context_money_open_book_mode()->>'mode'<>'off' THEN RAISE EXCEPTION 'mn1 disabled base flag must read off'; END IF;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='money_open_book_v1';
 m:=public.context_money_open_book_mode();
 IF m->>'mode'<>'apply' OR m->>'state'<>'present' THEN RAISE EXCEPTION 'mn1 both flags on must read apply: %',m; END IF;
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='money_open_book_apply_v1';
 m:=public.context_money_open_book_mode();
 IF m->>'mode'<>'observe' THEN RAISE EXCEPTION 'mn1 base flag alone must read observe: %',m; END IF;
 IF (m->'flags'->'money_open_book_v1'->>'enabled')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'mn1 flags detail: %',m; END IF;
END $$;
ROLLBACK;

-- An unreadable flag table reads as off, state unreadable.
BEGIN;
ALTER TABLE public.feature_flags RENAME COLUMN enabled TO enabled_gone;
DO $$
DECLARE m jsonb:=public.context_money_open_book_mode();
BEGIN
 IF m->>'mode'<>'off' OR m->>'state'<>'unreadable' THEN RAISE EXCEPTION 'mn1 unreadable flags must read off/unreadable: %',m; END IF;
END $$;
ROLLBACK;

-- 3. The status block with no runs and the sweep off: no alarm; the copy of
-- the open book and the open receivables with no job are counted.
BEGIN;
DELETE FROM public.xero_invoices;
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,amount_due,job_id,xero_verified_at) VALUES
 ('00000000-0000-0000-0000-000000000001','x-open-linked','INV-8001','ACCREC','AUTHORISED',100,gen_random_uuid(),now()-interval '5 minutes'),
 ('00000000-0000-0000-0000-000000000001','x-open-unlinked','INV-8002','ACCREC','AUTHORISED',734.48,NULL,NULL),
 ('00000000-0000-0000-0000-000000000001','x-submitted-unlinked','INV-8003','ACCREC','SUBMITTED',10,NULL,now()-interval '2 hours'),
 ('00000000-0000-0000-0000-000000000001','x-paid','INV-8004','ACCREC','PAID',0,NULL,NULL),
 ('00000000-0000-0000-0000-000000000001','x-bill','BILL-1','ACCPAY','AUTHORISED',50,NULL,NULL);
DO $$
DECLARE s jsonb:=public.context_money_status();
BEGIN
 IF s->'open_book'->>'mode'<>'off' OR jsonb_array_length(s->'alarms')<>0 THEN RAISE EXCEPTION 'mn1 off: %',s; END IF;
 IF (s->'copy'->>'open_receivables')::int<>3 OR (s->'copy'->>'verified_fresh')::int<>1 OR (s->'copy'->>'never_verified')::int<>1 THEN
  RAISE EXCEPTION 'mn1 copy counts: %',s->'copy'; END IF;
 IF (s->'money_unlinked_open'->>'count')::int<>2 OR (s->'money_unlinked_open'->>'amount_due')::numeric<>744.48 THEN
  RAISE EXCEPTION 'mn1 unlinked open: %',s->'money_unlinked_open'; END IF;
 IF s->'open_book'->'last_run'<>'null'::jsonb OR s->'open_book'->'drift_last_complete_run'<>'{}'::jsonb THEN RAISE EXCEPTION 'mn1 no runs: %',s->'open_book'; END IF;
END $$;
ROLLBACK;

-- 4. Stale: the sweep on for 2 hours with no complete run alarms from when the
-- mode began; a complete run 10 minutes ago clears it and reports its drift.
BEGIN;
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('money_open_book_v1',true,now()-interval '2 hours');
DO $$
DECLARE s jsonb:=public.context_money_status(); a jsonb;
BEGIN
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='money_open_book_stale';
 IF a IS NULL OR (a->>'since')::timestamptz>now()-interval '119 minutes' THEN RAISE EXCEPTION 'mn1 stale alarm missing: %',s->'alarms'; END IF;
END $$;
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts,cursor) VALUES
 ('xero_open_book','partial',now()-interval '40 minutes',now()-interval '39 minutes',now()-interval '39 minutes','{"closure_unverified":0}','{"actor":"workflow:xero-sync","mode":"observe"}'),
 ('xero_open_book','succeeded',now()-interval '11 minutes',now()-interval '10 minutes',now()-interval '10 minutes',
  '{"pages":2,"live_open":102,"added_back":1,"contact_changed":1,"reference_changed":1,"closure_unverified":0,"day_remaining":1866}',
  '{"actor":"workflow:xero-sync","mode":"observe","ids":{"added_back":["925f4829-ae21-4df2-b2a6-4f1e5e63edff"]}}');
DO $$
DECLARE s jsonb:=public.context_money_status();
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='money_open_book_stale') THEN RAISE EXCEPTION 'mn1 stale after success: %',s->'alarms'; END IF;
 IF (s->'open_book'->'drift_last_complete_run'->>'added_back')::int<>1 OR (s->'open_book'->'drift_last_complete_run'->>'contact_changed')::int<>1
  OR (s->'open_book'->'drift_last_complete_run'->>'amount_changed')::int<>0 THEN RAISE EXCEPTION 'mn1 drift: %',s->'open_book'; END IF;
 IF s->'open_book'->'last_run'->>'actor'<>'workflow:xero-sync' OR (s->'open_book'->>'xero_day_remaining')::int<>1866 THEN RAISE EXCEPTION 'mn1 last run: %',s->'open_book'; END IF;
 IF (s->'open_book'->'runs_24h'->>'succeeded')::int<>1 OR (s->'open_book'->'runs_24h'->>'partial')::int<>1 THEN RAISE EXCEPTION 'mn1 runs_24h: %',s->'open_book'->'runs_24h'; END IF;
END $$;
ROLLBACK;

-- 5. Closure unverified in each of the last 2 finished runs alarms; in only
-- the latest one it does not. Quota under 500 on a recent run alarms; the same
-- reading 90 minutes old does not.
BEGIN;
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts) VALUES
 ('xero_open_book','succeeded',now()-interval '31 minutes',now()-interval '30 minutes',now()-interval '30 minutes','{"closure_unverified":0}'),
 ('xero_open_book','succeeded',now()-interval '16 minutes',now()-interval '15 minutes',now()-interval '15 minutes','{"closure_unverified":1,"day_remaining":450}');
DO $$
DECLARE s jsonb:=public.context_money_status();
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='money_closure_unverified') THEN RAISE EXCEPTION 'mn1 one run must not alarm: %',s->'alarms'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='xero_quota_low' AND (x->>'day_remaining')::int=450) THEN RAISE EXCEPTION 'mn1 quota alarm: %',s->'alarms'; END IF;
END $$;
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts) VALUES
 ('xero_open_book','partial',now()-interval '2 minutes',now()-interval '1 minute',now()-interval '1 minute','{"closure_unverified":3}');
DO $$
DECLARE s jsonb:=public.context_money_status();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='money_closure_unverified' AND x->'closure_unverified'='[3,1]'::jsonb)
 THEN RAISE EXCEPTION 'mn1 closure alarm: %',s->'alarms'; END IF;
 -- The newest run carries no quota reading; the one before it is still recent.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='xero_quota_low') THEN RAISE EXCEPTION 'mn1 quota from latest reading'; END IF;
END $$;
UPDATE public.context_capture_runs SET finished_at=now()-interval '90 minutes',started_at=now()-interval '91 minutes',updated_at=now()-interval '90 minutes'
 WHERE counts ? 'day_remaining';
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(public.context_money_status()->'alarms') x WHERE x->>'key'='xero_quota_low') THEN RAISE EXCEPTION 'mn1 old quota must not alarm'; END IF;
END $$;
ROLLBACK;

-- 6. Unreadable flags alarm and read as off; the composer carries the money
-- block and its alarms tagged with the block.
BEGIN;
ALTER TABLE public.feature_flags RENAME COLUMN enabled TO enabled_gone;
DO $$
DECLARE p jsonb:=public.context_pipeline_status();
BEGIN
 IF p->'money'->'open_book'->>'mode'<>'off' THEN RAISE EXCEPTION 'mn1 composer money block: %',p->'money'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'alarms') x WHERE x->>'key'='money_flag_unreadable' AND x->>'block'='money')
 THEN RAISE EXCEPTION 'mn1 composer alarm: %',p->'alarms'; END IF;
END $$;
ROLLBACK;

-- 7. The sweep's receipt shape is accepted by the one run writer: source
-- xero_open_book, every count key the edge function sends, and a cursor at
-- the edge function's byte bound (seven classes of ten ids).
BEGIN;
DO $$
DECLARE r jsonb; id uuid; ids jsonb:='{}'::jsonb; k text; cur jsonb;
BEGIN
 FOREACH k IN ARRAY ARRAY['added_back','closed_here_open_there','amount_changed','status_changed','contact_changed','reference_changed','open_here_not_in_xero'] LOOP
  ids:=ids||jsonb_build_object(k,(SELECT jsonb_agg(gen_random_uuid()::text) FROM generate_series(1,10)));
 END LOOP;
 cur:=jsonb_build_object('actor','workflow:xero-sync','mode','apply','flag_state','present','ids',ids,'ids_truncated',true);
 IF octet_length(cur::text)>4096 THEN RAISE EXCEPTION 'mn1 fixture cursor over the column bound: %',octet_length(cur::text); END IF;
 r:=public.record_capture_run(jsonb_build_object('source','xero_open_book','status','running','window_to',now(),
  'cursor',jsonb_build_object('actor','workflow:xero-sync','mode','apply','flag_state','present','ids','{}'::jsonb,'ids_truncated',false)));
 id:=(r->>'run_id')::uuid;
 r:=public.record_capture_run(jsonb_build_object('run_id',id,'source','xero_open_book','status','succeeded','error_code',NULL,'cursor',cur,
  'counts',jsonb_build_object('pages',2,'live_open',102,'cached_open',101,'in_sync',98,'applied',103,'apply_errors',0,'deposit_stamps',0,
   'jobs_completed',0,'links_made',0,'ses_refusals',0,'added_back',1,'closed_here_open_there',0,'amount_changed',1,'status_changed',0,
   'contact_changed',1,'reference_changed',1,'open_here_not_in_xero',1,'closed_by_ids_read',1,'still_open_in_xero',0,
   'closed_by_single_read',0,'closure_unverified',0,'xero_calls',3,'day_remaining',1866)));
 IF r->>'status'<>'succeeded' THEN RAISE EXCEPTION 'mn1 receipt: %',r; END IF;
 IF (public.context_money_status()->'open_book'->'last_run'->'counts'->>'closed_by_ids_read')::int<>1 THEN RAISE EXCEPTION 'mn1 receipt read back'; END IF;
END $$;
ROLLBACK;

-- 8. Grants: service_role only on every MN1 function.
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_money_policy()','public.context_money_open_book_mode()','public.context_money_status()'] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'mn1 grants: % open to anon or authenticated',f; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'mn1 grants: % not callable by service_role',f; END IF;
 END LOOP;
END $$;
