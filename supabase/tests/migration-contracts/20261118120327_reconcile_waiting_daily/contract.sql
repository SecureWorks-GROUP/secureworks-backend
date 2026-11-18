BEGIN;
SET LOCAL statement_timeout = '120s';

-- Rule 17: re-apply prerequisite objects if an earlier contract removed them,
-- then re-apply this migration (proving idempotent re-application as well).
SELECT to_regclass('public.reconcile_items') IS NULL AS waiting_contract_needs_tables \gset
\if :waiting_contract_needs_tables
\ir ../20261118060051_reconcile_tables/main_lines_reader.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL AS waiting_contract_needs_raise \gset
\if :waiting_contract_needs_raise
\ir ../20261118073218_reconcile_item_raise/setup.sql
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif
\ir ../../../migrations/20261118120327_reconcile_waiting_daily.sql
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION pg_temp.expect_failure(command text, expected text) RETURNS void
LANGUAGE plpgsql AS $expect$
DECLARE failed boolean := false;
/* block */ BEGIN
  BEGIN EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected IN SQLERRM) = 0 THEN RAISE; END IF;
    failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'expected refusal: %', expected; END IF;
END $expect$;

DELETE FROM public.reconcile_waiting_daily;
DELETE FROM public.reconcile_items;

-- Fixture subjects (roles and ZZTEST identifiers only; no person names or real amounts).
CREATE TABLE public.zztest_waiting_messages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL
);
CREATE TABLE public.zztest_waiting_weekly (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL
);
INSERT INTO public.zztest_waiting_messages (id, org_id) VALUES
  ('13080000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.zztest_waiting_weekly (id, org_id) VALUES
  ('13080000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-0000000000a1');

INSERT INTO public.job_cost_lines (
  org_id, kind, document_kind, document_id, line_key, lane, amount_ex, source_hash, state
) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-1308-BILL-9D', '1', 'materials', 1200.00, 'zz1', 'needs_person'),
  ('00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-1308-BILL-2D', '1', 'materials', 350.50, 'zz2', 'needs_person'),
  ('00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-1308-BILL-DECIDED', '1', 'materials', 900.00, 'zz3', 'on_job'),
  ('00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-1308-BILL-WITHDRAWN', '1', 'materials', 450.00, 'zz4', 'needs_person');

-- 1. Empty open list (even when closed items and a weekly-check item exist):
--    waiting = 0 and oldest = null.
DO $empty_state$
DECLARE
  v_weekly uuid;
  v_decided uuid;
  v_withdrawn uuid;
  v_summary jsonb;
  v_written int;
  v_today date := (now() AT TIME ZONE 'Australia/Perth')::date;
/* block */ BEGIN
  v_weekly := public.reconcile_item_raise(
    'weekly_check', 'zztest_waiting_weekly', '13080000-0000-4000-8000-000000000002',
    NULL, NULL, '{"reason":"weekly_check","amount_ex":500.00}'::jsonb, 'answer_sheet'
  );
  UPDATE public.reconcile_items SET raised_at = now() - interval '12 days' WHERE id = v_weekly;

  v_decided := public.reconcile_item_raise(
    'bill', 'cost_document', 'xero_bill:ZZTEST-1308-BILL-DECIDED',
    NULL, NULL, '{"reason":"one_clue","amount_ex":900.00}'::jsonb, 'matcher:v1'
  );
  UPDATE public.reconcile_items
    SET status = 'decided', raised_at = now() - interval '20 days', closed_at = now()
  WHERE id = v_decided;

  v_withdrawn := public.reconcile_item_raise(
    'bill', 'cost_document', 'xero_bill:ZZTEST-1308-BILL-WITHDRAWN',
    NULL, NULL, '{"reason":"one_clue","amount_ex":450.00}'::jsonb, 'matcher:v1'
  );
  PERFORM public.reconcile_item_withdraw('bill', 'cost_document', 'xero_bill:ZZTEST-1308-BILL-WITHDRAWN', 'bill_voided');
  UPDATE public.reconcile_items SET raised_at = now() - interval '15 days' WHERE id = v_withdrawn;

  v_summary := public.reconcile_waiting_summary();
  IF (v_summary ->> 'waiting')::int <> 0
     OR jsonb_typeof(v_summary -> 'oldest') <> 'null'
     OR (v_summary ->> 'over_7_days')::int <> 0
     OR (v_summary ->> 'dollars_ex')::numeric <> 0.00
     OR v_summary -> 'by_kind' <> '[]'::jsonb
     OR jsonb_typeof(v_summary -> 'as_at') <> 'string' THEN
    RAISE EXCEPTION 'P2-13.8 empty list must return waiting 0 and oldest null: %', v_summary;
  END IF;

  v_written := public.reconcile_waiting_snapshot();
  IF v_written <> 1
     OR (SELECT count(*) FROM public.reconcile_waiting_daily WHERE day = v_today) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.reconcile_waiting_daily
       WHERE day = v_today AND kind = 'all' AND waiting = 0
         AND oldest_days IS NULL AND dollars_ex = 0.00
     ) THEN
    RAISE EXCEPTION 'P2-13.8 empty snapshot must write one all row with waiting 0 and oldest_days null';
  END IF;
END $empty_state$;

-- 2. Ticket fixture: three open items (two bills raised 9 and 2 days ago, one
--    message today), plus the open weekly_check item above (not counted).
--    Also proves snoozed items remain counted, snapshot writes all + per-kind
--    rows, and a second snapshot on the same day replaces that day cleanly.
DO $three_open_items$
DECLARE
  v_bill_9d uuid;
  v_bill_2d uuid;
  v_msg uuid;
  v_summary jsonb;
  v_written_1 int;
  v_written_2 int;
  v_today date := (now() AT TIME ZONE 'Australia/Perth')::date;
/* block */ BEGIN
  v_bill_9d := public.reconcile_item_raise(
    'bill', 'cost_document', 'xero_bill:ZZTEST-1308-BILL-9D',
    NULL, NULL,
    '{"reason":"one_clue","amount_ex":1200.00,"summary":{"party":"ZZTEST Supplier A","number":"ZZ-INV-9"}}'::jsonb,
    'matcher:v1'
  );
  UPDATE public.reconcile_items SET raised_at = now() - interval '9 days' WHERE id = v_bill_9d;

  v_bill_2d := public.reconcile_item_raise(
    'bill', 'cost_document', 'xero_bill:ZZTEST-1308-BILL-2D',
    NULL, NULL,
    '{"reason":"no_clue","amount_ex":350.50,"summary":{"party":"ZZTEST Supplier B","number":"ZZ-INV-2"}}'::jsonb,
    'matcher:v1'
  );
  UPDATE public.reconcile_items SET raised_at = now() - interval '2 days' WHERE id = v_bill_2d;

  v_msg := public.reconcile_item_raise(
    'message', 'zztest_waiting_messages', '13080000-0000-4000-8000-000000000001',
    NULL, NULL,
    '{"reason":"customer_message_no_job","summary":{"sender_role":"client","subject":"ZZTEST note"}}'::jsonb,
    'context:daily_list'
  );
  UPDATE public.reconcile_items SET raised_at = now() WHERE id = v_msg;

  v_summary := public.reconcile_waiting_summary();
  IF (v_summary ->> 'waiting')::int <> 3
     OR (v_summary -> 'oldest' ->> 'days')::int <> 9
     OR v_summary -> 'oldest' ->> 'kind_words' <> 'Bill'
     OR (v_summary -> 'oldest' ->> 'raised_at')::timestamptz
        IS DISTINCT FROM (SELECT raised_at FROM public.reconcile_items WHERE id = v_bill_9d)
     OR (v_summary ->> 'over_7_days')::int <> 1
     OR (v_summary ->> 'dollars_ex')::numeric <> 1550.50
     OR v_summary -> 'by_kind' <>
        '[{"kind":"bill","words":"Bill","waiting":2,"oldest_days":9},{"kind":"message","words":"Message","waiting":1,"oldest_days":0}]'::jsonb THEN
    RAISE EXCEPTION 'P2-13.8 summary mismatch on three open items: %', v_summary;
  END IF;

  -- Summary carries counts, days and kind words only: never party, document or person fields.
  IF v_summary::text LIKE '%ZZTEST Supplier%'
     OR v_summary::text LIKE '%ZZ-INV%'
     OR v_summary ? 'party'
     OR v_summary ? 'summary' THEN
    RAISE EXCEPTION 'P2-13.8 summary leaked item detail: %', v_summary;
  END IF;

  -- Snoozed items are NOT cleared: they still wait.
  UPDATE public.reconcile_items
    SET snooze_until = now() + interval '24 hours'
  WHERE id = v_bill_9d;

  v_summary := public.reconcile_waiting_summary();
  IF (v_summary ->> 'waiting')::int <> 3
     OR (v_summary -> 'oldest' ->> 'days')::int <> 9
     OR (v_summary ->> 'over_7_days')::int <> 1 THEN
    RAISE EXCEPTION 'P2-13.8 snoozed item must still count as waiting: %', v_summary;
  END IF;

  -- Snapshot writes an all row and one row per open kind (break-contract target).
  v_written_1 := public.reconcile_waiting_snapshot();
  IF v_written_1 <> 3
     OR (SELECT count(*) FROM public.reconcile_waiting_daily WHERE day = v_today) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM public.reconcile_waiting_daily
       WHERE day = v_today AND kind = 'all' AND waiting = 3
         AND oldest_days = 9 AND dollars_ex = 1550.50
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.reconcile_waiting_daily
       WHERE day = v_today AND kind = 'bill' AND waiting = 2
         AND oldest_days = 9 AND dollars_ex = 1550.50
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.reconcile_waiting_daily
       WHERE day = v_today AND kind = 'message' AND waiting = 1
         AND oldest_days = 0 AND dollars_ex IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.reconcile_waiting_daily
       WHERE day = v_today AND kind = 'weekly_check'
     ) THEN
    RAISE EXCEPTION 'P2-13.8 snapshot must write an all row and one row per open kind';
  END IF;

  -- Second snapshot on the same day replaces that day, leaving one row per kind.
  v_written_2 := public.reconcile_waiting_snapshot();
  IF v_written_2 <> 3
     OR (SELECT count(*) FROM public.reconcile_waiting_daily WHERE day = v_today) <> 3
     OR (SELECT count(*) FROM public.reconcile_waiting_daily WHERE day = v_today AND kind = 'bill') <> 1
     OR (SELECT count(*) FROM public.reconcile_waiting_daily WHERE day = v_today AND kind = 'message') <> 1
     OR (SELECT count(*) FROM public.reconcile_waiting_daily WHERE day = v_today AND kind = 'all') <> 1 THEN
    RAISE EXCEPTION 'P2-13.8 second snapshot on same day must leave one row per kind';
  END IF;

  -- Office/source clears both bills, leaving only the unknown-amount message:
  -- re-snapshotting the same day removes the stale bill row and keeps dollars_ex NULL (never 0).
  PERFORM public.reconcile_item_withdraw('bill', 'cost_document', 'xero_bill:ZZTEST-1308-BILL-9D', 'zz_cleared');
  PERFORM public.reconcile_item_withdraw('bill', 'cost_document', 'xero_bill:ZZTEST-1308-BILL-2D', 'zz_cleared');

  v_summary := public.reconcile_waiting_summary();
  IF (v_summary ->> 'waiting')::int <> 1
     OR jsonb_typeof(v_summary -> 'dollars_ex') <> 'null' THEN
    RAISE EXCEPTION 'P2-13.8 open items with no known amount must report dollars_ex null, never 0: %', v_summary;
  END IF;

  v_written_2 := public.reconcile_waiting_snapshot();
  IF v_written_2 <> 2
     OR EXISTS (SELECT 1 FROM public.reconcile_waiting_daily WHERE day = v_today AND kind = 'bill')
     OR NOT EXISTS (
       SELECT 1 FROM public.reconcile_waiting_daily
       WHERE day = v_today AND kind = 'all' AND waiting = 1
         AND oldest_days = 0 AND dollars_ex IS NULL
     ) THEN
    RAISE EXCEPTION 'P2-13.8 same-day replacement must remove cleared kind rows and keep unknown dollars null';
  END IF;
END $three_open_items$;

-- 3. reconcile_waiting_days(p_days) and reconcile_waiting_daily_trim(p_before, p_limit).
DO $days_and_trim$
DECLARE
  v_today date := (now() AT TIME ZONE 'Australia/Perth')::date;
  v_days jsonb;
/* block */ BEGIN
  DELETE FROM public.reconcile_waiting_daily;
  INSERT INTO public.reconcile_waiting_daily (day, kind, waiting, oldest_days, dollars_ex) VALUES
    (v_today,      'all',     4,  3, 400.00),
    (v_today,      'bill',    4,  3, 400.00),
    (v_today - 1,  'all',     7,  5, 710.00),
    (v_today - 1,  'bill',    6,  5, 710.00),
    (v_today - 14, 'all',    61, 11, 6100.00),
    (v_today - 15, 'all',    88, 12, 8800.00),
    (v_today - 40, 'all',    99, 15, 9900.00),
    (v_today - 40, 'message', 5,  4, NULL);

  v_days := public.reconcile_waiting_days(14);
  IF jsonb_array_length(v_days) <> 3
     OR (v_days -> 0 ->> 'day')::date <> v_today
     OR (v_days -> 0 ->> 'waiting')::int <> 4
     OR (v_days -> 1 ->> 'day')::date <> v_today - 1
     OR (v_days -> 1 ->> 'waiting')::int <> 7
     OR (v_days -> 2 ->> 'day')::date <> v_today - 14
     OR (v_days -> 2 ->> 'waiting')::int <> 61
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_days) e
       WHERE (e ->> 'kind') <> 'all'
     ) THEN
    RAISE EXCEPTION 'P2-13.8 reconcile_waiting_days(14) must return stored all rows newest first: %', v_days;
  END IF;

  -- Refusals on invalid day windows and trim parameters (leave stored rows untouched).
  PERFORM pg_temp.expect_failure('SELECT public.reconcile_waiting_days(0)', 'reconcile_waiting_days_invalid');
  PERFORM pg_temp.expect_failure('SELECT public.reconcile_waiting_days(-3)', 'reconcile_waiting_days_invalid');
  PERFORM pg_temp.expect_failure('SELECT public.reconcile_waiting_days(NULL)', 'reconcile_waiting_days_invalid');
  PERFORM pg_temp.expect_failure('SELECT public.reconcile_waiting_days(5000)', 'reconcile_waiting_days_invalid');
  PERFORM pg_temp.expect_failure('SELECT public.reconcile_waiting_daily_trim(NULL, 10)', 'reconcile_waiting_trim_invalid');
  PERFORM pg_temp.expect_failure('SELECT public.reconcile_waiting_daily_trim(CURRENT_DATE, 0)', 'reconcile_waiting_trim_invalid');

  -- Bounded trim deletes at most p_limit rows older than p_before, oldest first.
  IF public.reconcile_waiting_daily_trim(v_today - 14, 2) <> 2 THEN
    RAISE EXCEPTION 'P2-13.8 trim must honour p_limit = 2';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reconcile_waiting_daily WHERE day = v_today - 40)
     OR NOT EXISTS (SELECT 1 FROM public.reconcile_waiting_daily WHERE day = v_today - 15) THEN
    RAISE EXCEPTION 'P2-13.8 trim must remove oldest days first';
  END IF;
  DECLARE
    v_trimmed int;
  /* block */ BEGIN
    v_trimmed := public.reconcile_waiting_daily_trim(v_today - 14, 10);
    IF v_trimmed <> 1
       OR EXISTS (SELECT 1 FROM public.reconcile_waiting_daily WHERE day < v_today - 14)
       OR (SELECT count(*) FROM public.reconcile_waiting_daily WHERE day >= v_today - 14) <> 5 THEN
      RAISE EXCEPTION 'P2-13.8 trim must remove remaining rows before cutoff and preserve recent days';
    END IF;
  END;
END $days_and_trim$;

-- 4. Permissions and RLS: service_role only; no function overrides caller statement_timeout.
DO $security$
DECLARE fn text;
/* block */ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.reconcile_waiting_daily'::regclass AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'P2-13.8 reconcile_waiting_daily must enable RLS';
  END IF;

  IF has_table_privilege('anon', 'public.reconcile_waiting_daily', 'SELECT')
     OR has_table_privilege('authenticated', 'public.reconcile_waiting_daily', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.reconcile_waiting_daily', 'SELECT') THEN
    RAISE EXCEPTION 'P2-13.8 table privileges must be service_role only';
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'public.reconcile_waiting_summary()',
    'public.reconcile_waiting_snapshot(date)',
    'public.reconcile_waiting_days(integer)',
    'public.reconcile_waiting_daily_trim(date,integer)',
    'public.reconcile_waiting_daily_install()',
    'public.reconcile_waiting_daily_remove()'
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE')
       OR has_function_privilege('authenticated', fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'P2-13.8 % must be executable by service_role only', fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p, unnest(p.proconfig) AS setting
      WHERE p.oid = fn::regprocedure AND setting LIKE 'statement_timeout=%'
    ) THEN
      RAISE EXCEPTION 'P2-13.8 % must not override caller statement_timeout', fn;
    END IF;
  END LOOP;
END $security$;

-- 5. Director-only timer install and remove (merge installs nothing; missing pg_cron refuses).
SAVEPOINT cron_fixture;
DO $no_cron$
/* block */ BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    PERFORM pg_temp.expect_failure(
      'SELECT public.reconcile_waiting_daily_install()',
      'reconcile_waiting_cron_unavailable'
    );
  END IF;
END $no_cron$;
SELECT to_regclass('cron.job') IS NULL AS waiting_contract_needs_cron_adapter \gset
\if :waiting_contract_needs_cron_adapter
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  jobname text UNIQUE,
  schedule text,
  command text
);
CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $cron$
  INSERT INTO cron.job (jobname, schedule, command) VALUES ($1, $2, $3)
  ON CONFLICT (jobname) DO UPDATE
    SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$cron$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $cron$
  WITH removed AS (DELETE FROM cron.job WHERE jobid = $1 RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM removed);
$cron$;
\endif
\ir ../../../migrations/20261118120327_reconcile_waiting_daily.sql
DO $cron_checks$
/* block */ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-waiting-daily') THEN
    RAISE EXCEPTION 'P2-13.8 migration must not install a schedule on merge';
  END IF;
  PERFORM public.reconcile_waiting_daily_install();
  PERFORM public.reconcile_waiting_daily_install();
  IF (
    SELECT count(*) FROM cron.job
    WHERE jobname = 'reconcile-waiting-daily'
      AND schedule = '5 9 * * *'
      AND command = $cmd$SET LOCAL statement_timeout = '60s'; SELECT public.reconcile_waiting_snapshot();$cmd$
      AND command NOT LIKE '%net.http_post%'
  ) <> 1 THEN
    RAISE EXCEPTION 'P2-13.8 install must register one database-only timer at 5 9 * * *';
  END IF;
  PERFORM public.reconcile_waiting_daily_remove();
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-waiting-daily') THEN
    RAISE EXCEPTION 'P2-13.8 remove must unschedule reconcile-waiting-daily';
  END IF;
END $cron_checks$;
ROLLBACK TO SAVEPOINT cron_fixture;

-- 6. Rule 16: every read over reconcile_items and reconcile_waiting_daily is
--    index-bound with no Seq Scan on populated tables.
SAVEPOINT plan_fixture;
DELETE FROM public.reconcile_items;
DELETE FROM public.reconcile_waiting_daily;

INSERT INTO public.reconcile_items (
  org_id, kind, subject_table, subject_id, reason, amount_ex, evidence_hash, status, raised_by, raised_at, closed_at
)
SELECT
  '00000000-0000-0000-0000-0000000000a1',
  CASE WHEN g % 3 = 0 THEN 'message' ELSE 'bill' END,
  'cost_document',
  'xero_bill:ZZTEST-CLOSED-' || g,
  'one_clue',
  100.00,
  'zz',
  CASE WHEN g % 2 = 0 THEN 'decided' ELSE 'withdrawn' END,
  'matcher:v1',
  now() - interval '30 days',
  now() - interval '29 days'
FROM generate_series(1, 6000) g;

INSERT INTO public.reconcile_items (
  org_id, kind, subject_table, subject_id, reason, amount_ex, evidence_hash, status, raised_by, raised_at
) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'bill', 'cost_document', 'xero_bill:ZZTEST-OPEN-1', 'one_clue', 250.00, 'zz', 'open', 'matcher:v1', now() - interval '9 days'),
  ('00000000-0000-0000-0000-0000000000a1', 'message', 'zztest_waiting_messages', '13080000-0000-4000-8000-000000000001', 'no_clue', NULL, 'zz', 'open', 'context:daily_list', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000a1', 'weekly_check', 'zztest_waiting_weekly', '13080000-0000-4000-8000-000000000002', 'weekly_check', NULL, 'zz', 'open', 'answer_sheet', now() - interval '4 days');

INSERT INTO public.reconcile_waiting_daily (day, kind, waiting, oldest_days, dollars_ex)
SELECT
  (now() AT TIME ZONE 'Australia/Perth')::date - g,
  k,
  5,
  2,
  500.00
FROM generate_series(0, 700) g
CROSS JOIN (VALUES ('all'), ('bill'), ('message')) kinds(k);

ANALYZE public.reconcile_items, public.reconcile_item_kinds, public.reconcile_waiting_daily;

DO $plan$
DECLARE
  v_kinds text[];
  v_today date := (now() AT TIME ZONE 'Australia/Perth')::date;
  plan jsonb;
  rel text;
  q text;
  max_rows int;
/* block */ BEGIN
  SELECT array_agg(k.kind ORDER BY k.kind COLLATE "C")
    INTO v_kinds
  FROM public.reconcile_item_kinds k
  WHERE k.tab <> 'weekly' AND k.kind <> 'all';

  FOR rel, max_rows, q IN VALUES
    (
      'reconcile_items',
      5,
      format(
        $q$SELECT i.kind, i.amount_ex, i.raised_at
           FROM public.reconcile_items i
           WHERE i.status = 'open' AND i.kind = ANY(%L::text[])$q$,
        v_kinds
      )
    ),
    (
      'reconcile_waiting_daily',
      20,
      format(
        $q$SELECT d.day, d.kind, d.waiting, d.oldest_days, d.dollars_ex
           FROM public.reconcile_waiting_daily d
           WHERE d.kind = 'all' AND d.day >= %L::date - 14 AND d.day <= %L::date
           ORDER BY d.day DESC$q$,
        v_today,
        v_today
      )
    ),
    (
      'reconcile_waiting_daily',
      15,
      format(
        $q$SELECT d.day, d.kind
           FROM public.reconcile_waiting_daily d
           WHERE d.day < %L::date
           ORDER BY d.day ASC, d.kind ASC
           LIMIT 10
           FOR UPDATE SKIP LOCKED$q$,
        v_today - 690
      )
    )
  LOOP
    EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO plan;
    IF EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
      WHERE node ->> 'Relation Name' = rel AND node ->> 'Node Type' = 'Seq Scan'
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
      WHERE node ->> 'Relation Name' = rel
        AND node ->> 'Node Type' IN ('Index Scan', 'Index Only Scan', 'Bitmap Heap Scan')
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
      WHERE node ->> 'Relation Name' = rel
        AND coalesce((node ->> 'Actual Rows')::numeric, 0)
            + coalesce((node ->> 'Rows Removed by Filter')::numeric, 0) > max_rows
    ) THEN
      RAISE EXCEPTION 'P2-13.8 % query must be index-bound within % rows: %', rel, max_rows, plan;
    END IF;
  END LOOP;
END $plan$;
ROLLBACK TO SAVEPOINT plan_fixture;

SELECT 'PASS P2-13.8: waiting summary, snoozed items kept, weekly excluded, daily snapshot idempotency and replacement, 14-day trend, bounded trim, director-only cron install/remove and indexed plans';
ROLLBACK;
