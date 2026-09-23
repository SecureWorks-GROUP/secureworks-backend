-- MN1 (context build plan, Wave 2; design money.md §2, §6, §7, §12, §13;
-- INTEGRATION X17, X21, X22, X32): the open-book sweep's column, its mode
-- flags, and the money status block.
--
-- What it does:
--  1. xero_invoices.xero_verified_at: when this copy of the invoice was last
--     read from Xero. Written only by xero-sync's shared invoice builders
--     (xero_invoice_record.ts: the incremental loop, the open-book sweep, its
--     closure read, the single-record verify, the backfill). The ~20 ops-api
--     mirror writers keep writing synced_at and never this column, so
--     synced_at means "last local write" and this column means "verified".
--     Nullable, no default: an existing row is "never verified" until a read.
--  2. context_money_policy(): the thresholds, in one place.
--  3. context_money_open_book_mode(): the sweep's mode from two
--     feature_flags rows, parsed once for SQL and the edge function. The live
--     feature_flags table holds booleans, so money.md's three-state
--     money_open_book_v1 (off, observe, apply) is two rows:
--       money_open_book_v1        enabled: the sweep runs in observe;
--       money_open_book_apply_v1  enabled as well: apply.
--     A missing or unreadable row reads as off (review S5), so a missing or
--     unreadable apply row with money_open_book_v1 on is observe, and
--     turning money_open_book_v1 off is the whole rollback. This migration
--     creates and changes no flag row.
--  4. context_money_status() replaces the F1b stub (the composer itself is
--     untouched). The sweep part of the money block: the mode, the latest
--     xero_open_book run and the latest complete one, drift per class, closure
--     settlement, Xero's day quota, how fresh the verified copy of the open
--     book is, and open receivables linked to no job. Alarms (each: key,
--     severity, since, what_to_do), computed, never stored:
--       money_open_book_stale     no complete sweep for 45 minutes while the
--                                 mode is observe or apply;
--       money_closure_unverified  invoices open here that Xero no longer
--                                 lists stayed unsettled in each of the last
--                                 2 finished runs;
--       xero_quota_low            Xero's day quota below 500 on a run in the
--                                 last hour;
--       money_flag_unreadable     the mode flags could not be read (the sweep
--                                 behaves as off).
--     Credits, bank state and live-read actors are later money slices (MN2,
--     MN3, MN4) and are listed under not_measured.
--
-- No flag or switch is turned on, no xero_invoices row is written, and no
-- grant, policy or view is added for anon or authenticated. Every new or
-- re-created function: fixed search_path, EXECUTE revoked from PUBLIC, anon,
-- authenticated; service_role only.
--
-- Built on the LIVE production definitions, read 24 Sep 2026 (read-only, in a
-- rolled-back transaction):
--   context_money_status()      md5(prosrc) 155104bfb08b8b3c2f98bdec089d4ee4 (the F1b stub)
--   record_capture_run(jsonb)   md5(prosrc) db03c98a6da49f128595342f5a93f84c (F1b; the sweep's receipts)
--   context_money_policy, context_money_open_book_mode: absent
--   xero_invoices.xero_verified_at: absent
--   feature_flags(flag_name text, enabled boolean, updated_at timestamptz):
--     no money_open_book_v1 or money_open_book_apply_v1 row (reads as off)
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply).
--
-- Rollback: supabase/rollbacks/20260924190000_money_open_book_sweep_down.sql
-- restores the stub and drops the two new functions; it keeps the column,
-- because the MN1 xero-sync writes it on every invoice upsert. Behaviour
-- rollback needs no migration: money_open_book_v1 off.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; col text; ff text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_money_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','7724232a153c9d795b5d4bcd26e3dd6b'],false),
  ('public.record_capture_run(jsonb)',ARRAY['db03c98a6da49f128595342f5a93f84c'],false),
  ('public.context_money_policy()',ARRAY['815fa0d93470e23b20149bb131d1f9b4'],true),
  ('public.context_money_open_book_mode()',ARRAY['6288fa83702498c3097df69a5f5db23a'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regclass('public.xero_invoices') IS NULL THEN problems:=problems||'xero_invoices missing'::text;
 ELSE
  SELECT format_type(a.atttypid,a.atttypmod) INTO col FROM pg_attribute a
  WHERE a.attrelid='public.xero_invoices'::regclass AND a.attname='xero_verified_at' AND NOT a.attisdropped;
  IF col IS NOT NULL AND col<>'timestamp with time zone' THEN problems:=problems||format('xero_invoices.xero_verified_at exists as %s',col); END IF;
 END IF;
 SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attname) INTO ff
 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.feature_flags') AND a.attname IN ('flag_name','enabled','updated_at') AND NOT a.attisdropped;
 IF ff IS DISTINCT FROM 'enabled:boolean,flag_name:text,updated_at:timestamp with time zone' THEN
  problems:=problems||format('feature_flags columns are %s',coalesce(ff,'<missing table>'));
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'money_open_book_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The verified-read stamp.
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS xero_verified_at timestamptz;
COMMENT ON COLUMN public.xero_invoices.xero_verified_at IS
 'When this copy was last read from Xero (money MN1). Written only by xero-sync''s shared invoice builders (xero_invoice_record.ts); ops-api mirror writers never set it. synced_at is the last local write. Null: never verified since MN1.';

-- 2. Thresholds.
CREATE OR REPLACE FUNCTION public.context_money_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'open_book_flag','money_open_book_v1',
  'open_book_apply_flag','money_open_book_apply_v1',
  'run_source','xero_open_book',
  -- money_open_book_stale: minutes since the last complete sweep.
  'open_book_stale_minutes',45,
  -- money_closure_unverified: finished runs in a row with unsettled closures.
  'closure_unverified_runs',2,
  -- xero_quota_low: Xero day quota (5,000 a tenant) below this, on a run
  -- finished within quota_reading_max_age_minutes.
  'quota_low_below',500,
  'quota_reading_max_age_minutes',60,
  -- The verified copy of the open book is fresh within this many minutes
  -- (money.md §9 book check: every row verified within 20 minutes).
  'verified_fresh_minutes',20)
$$;

-- 3. The sweep's mode. Fails closed: no table, no row, or an error is off.
CREATE OR REPLACE FUNCTION public.context_money_open_book_mode() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_money_policy();
 names text[]:=ARRAY[policy->>'open_book_flag',policy->>'open_book_apply_flag'];
 flags jsonb:='{}'::jsonb; n text; on_flag boolean; changed timestamptz; st text;
 base boolean:=false; base_state text; base_since timestamptz; apply_on boolean:=false; apply_since timestamptz;
BEGIN
 FOREACH n IN ARRAY names LOOP
  on_flag:=NULL; changed:=NULL; st:='present';
  BEGIN
   IF to_regclass('public.feature_flags') IS NULL THEN st:='missing';
   ELSE
    EXECUTE 'SELECT f.enabled,f.updated_at FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1'
     INTO on_flag,changed USING n;
    IF on_flag IS NULL THEN st:='missing'; END IF;
   END IF;
  EXCEPTION WHEN OTHERS THEN on_flag:=NULL; changed:=NULL; st:='unreadable';
  END;
  flags:=flags||jsonb_build_object(n,jsonb_build_object('enabled',coalesce(on_flag,false),'updated_at',changed,'state',st));
  IF n=names[1] THEN base:=coalesce(on_flag,false); base_state:=st; base_since:=changed;
  ELSE apply_on:=coalesce(on_flag,false); apply_since:=changed; END IF;
 END LOOP;
 RETURN jsonb_build_object(
  'mode',CASE WHEN NOT base THEN 'off' WHEN apply_on THEN 'apply' ELSE 'observe' END,
  -- The state of the flag that decides whether the sweep runs at all; an
  -- unreadable apply row only holds the sweep at observe.
  'state',CASE WHEN base_state='unreadable' OR (flags->names[2]->>'state')='unreadable' THEN 'unreadable' ELSE base_state END,
  -- When the current mode began (the later of the two changes that set it).
  'since',CASE WHEN NOT base THEN base_since WHEN apply_on THEN greatest(base_since,apply_since) ELSE base_since END,
  'flags',flags);
END $$;
COMMENT ON FUNCTION public.context_money_open_book_mode() IS
 'The open-book sweep''s mode (off, observe, apply) from feature_flags money_open_book_v1 (on: observe) and money_open_book_apply_v1 (also on: apply). Missing or unreadable reads as off. Called by xero-sync and context_money_status(). Owned by money slice MN1.';

-- 4. The money status block (sweep part).
CREATE OR REPLACE FUNCTION public.context_money_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_money_policy();
 now_time timestamptz:=now();
 flag jsonb:=public.context_money_open_book_mode();
 mode text:=flag->>'mode';
 src text:=policy->>'run_source';
 last_run jsonb; last_success timestamptz; last_success_counts jsonb; runs_by_status jsonb;
 recent_unverified integer[]; quota_left integer; quota_at timestamptz;
 open_n integer; fresh_n integer; never_n integer; oldest_verified timestamptz;
 unlinked_n integer; unlinked_due numeric;
 stale_since timestamptz; alarms jsonb:='[]'::jsonb; drift jsonb;
BEGIN
 -- Sweep runs (context_capture_runs, written only through record_capture_run).
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'counts',c.counts,'mode',c.cursor->>'mode','actor',c.cursor->>'actor')
 INTO last_run FROM public.context_capture_runs c WHERE c.source=src ORDER BY c.started_at DESC LIMIT 1;
 SELECT c.finished_at,c.counts INTO last_success,last_success_counts FROM public.context_capture_runs c
 WHERE c.source=src AND c.status='succeeded' ORDER BY c.finished_at DESC LIMIT 1;
 SELECT coalesce(jsonb_object_agg(s.status,s.n),'{}'::jsonb) INTO runs_by_status
 FROM (SELECT c.status,count(*) n FROM public.context_capture_runs c
  WHERE c.source=src AND c.started_at>now_time-interval '24 hours' GROUP BY c.status) s;
 SELECT array_agg(v ORDER BY finished_at DESC) INTO recent_unverified FROM (
  SELECT c.finished_at, CASE WHEN jsonb_typeof(c.counts->'closure_unverified')='number' THEN (c.counts->>'closure_unverified')::integer ELSE 0 END AS v
  FROM public.context_capture_runs c WHERE c.source=src AND c.status IN ('succeeded','partial')
  ORDER BY c.finished_at DESC LIMIT (policy->>'closure_unverified_runs')::integer) r;
 SELECT (c.counts->>'day_remaining')::integer, c.finished_at INTO quota_left, quota_at
 FROM public.context_capture_runs c
 WHERE c.source=src AND c.finished_at IS NOT NULL AND jsonb_typeof(c.counts->'day_remaining')='number'
 ORDER BY c.finished_at DESC LIMIT 1;
 SELECT coalesce(jsonb_object_agg(k,CASE WHEN jsonb_typeof(last_success_counts->k)='number' THEN (last_success_counts->>k)::integer ELSE 0 END),'{}'::jsonb)
 INTO drift FROM unnest(ARRAY['added_back','closed_here_open_there','amount_changed','status_changed','contact_changed','reference_changed',
  'open_here_not_in_xero','closed_by_ids_read','still_open_in_xero','closed_by_single_read','closure_unverified']) k
 WHERE last_success_counts IS NOT NULL;

 -- Our copy of the open receivable book (the debt book's definition).
 SELECT count(*),
  count(*) FILTER (WHERE x.xero_verified_at>now_time-make_interval(mins=>(policy->>'verified_fresh_minutes')::integer)),
  count(*) FILTER (WHERE x.xero_verified_at IS NULL),
  min(x.xero_verified_at),
  count(*) FILTER (WHERE x.job_id IS NULL),
  coalesce(sum(x.amount_due) FILTER (WHERE x.job_id IS NULL),0)
 INTO open_n,fresh_n,never_n,oldest_verified,unlinked_n,unlinked_due
 FROM public.xero_invoices x
 WHERE x.invoice_type='ACCREC' AND x.status IN ('AUTHORISED','SUBMITTED') AND x.amount_due>0;

 -- Alarms.
 IF mode IN ('observe','apply') THEN
  stale_since:=coalesce(last_success,(flag->>'since')::timestamptz);
  IF stale_since IS NOT NULL AND now_time-stale_since>make_interval(mins=>(policy->>'open_book_stale_minutes')::integer) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','money_open_book_stale','severity','warning','since',stale_since,
    'mode',mode,'last_run_status',last_run->>'status','last_run_error',last_run->>'error_code',
    'what_to_do','The 15-minute Xero open-book sweep has not completed for 45 minutes. Check the xero-invoice-sync cron job and xero-sync logs, the Xero token and day quota; until it recovers our copy of who owes what is not being checked against Xero.'));
  END IF;
 END IF;
 IF cardinality(recent_unverified)=(policy->>'closure_unverified_runs')::integer AND 0<ALL(recent_unverified) THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','money_closure_unverified','severity','warning',
   'since',(SELECT min(f) FROM (SELECT c.finished_at f FROM public.context_capture_runs c WHERE c.source=src AND c.status IN ('succeeded','partial')
     ORDER BY c.finished_at DESC LIMIT (policy->>'closure_unverified_runs')::integer) z),
   'closure_unverified',recent_unverified,
   'what_to_do','Invoices we hold as open are no longer in Xero''s open book and could not be settled by reading them from Xero. The ids are on the latest xero_open_book run; check each in Xero.'));
 END IF;
 IF quota_left IS NOT NULL AND quota_left<(policy->>'quota_low_below')::integer
  AND quota_at>now_time-make_interval(mins=>(policy->>'quota_reading_max_age_minutes')::integer) THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','xero_quota_low','severity','warning','since',quota_at,'day_remaining',quota_left,
   'what_to_do','Xero''s daily call quota is nearly used. Reads fall back to our verified copy and say how old it is; find what is spending the quota before it runs out.'));
 END IF;
 IF flag->>'state'='unreadable' THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','money_flag_unreadable','severity','warning','since',now_time,
   'what_to_do','The money_open_book flags could not be read, so the open-book sweep is treated as off. Check the feature_flags table.'));
 END IF;

 RETURN jsonb_build_object(
  'as_of',now_time,'policy',policy,
  'open_book',jsonb_build_object('flag',flag,'mode',mode,'last_run',last_run,'last_success_at',last_success,
   'runs_24h',runs_by_status,'drift_last_complete_run',drift,'closure_unverified_recent_runs',to_jsonb(recent_unverified),
   'xero_day_remaining',quota_left,'xero_day_remaining_at',quota_at),
  'copy',jsonb_build_object('open_receivables',coalesce(open_n,0),'verified_fresh',coalesce(fresh_n,0),
   'never_verified',coalesce(never_n,0),'oldest_verified_at',oldest_verified),
  'money_unlinked_open',jsonb_build_object('count',coalesce(unlinked_n,0),'amount_due',unlinked_due),
  'not_measured',jsonb_build_array('receivable_credits','bank_unreconciled','bank_reconciliation_state','live_read_actor_missing'),
  'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_money_status() IS
 'Status block money (money slice MN1, sweep part): open-book mode, latest and latest complete xero_open_book runs, drift per class, closure settlement, Xero day quota, freshness of the verified copy of the open book, open receivables with no job, and the alarms money_open_book_stale, money_closure_unverified, xero_quota_low, money_flag_unreadable. Counts, ids and codes; the one amount is money_unlinked_open.amount_due.';

-- 5. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_money_policy(),public.context_money_open_book_mode(),public.context_money_status()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_money_policy(),public.context_money_open_book_mode(),public.context_money_status() TO service_role;
