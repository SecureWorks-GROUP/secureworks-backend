-- P1-10.1 contract. Every value, id and word below is made up (ZZTEST).
BEGIN;
-- Rule 17: re-apply what this contract asserts on. A stand-in for phase 2's
-- allow-list (P2-03.1's columns) exists only inside this transaction, so the
-- kind row is proved once after two runs of the migration.
\ir ../../../migrations/20261118063223_trade_pay_run_standing_checks.sql
SELECT to_regclass('public.reconcile_item_kinds') IS NULL AS need_kinds \gset
\if :need_kinds
CREATE TABLE public.reconcile_item_kinds (kind text PRIMARY KEY,
  tab text NOT NULL CHECK (tab IN ('bills','card_bank','receipts','messages','pay','other','weekly')),
  words text NOT NULL,
  card text NOT NULL CHECK (card IN ('cost','message','pay_claim','pay_line','weekly','generic')));
\endif
\ir ../../../migrations/20261118115852_trade_pay_runs.sql
\ir ../../../migrations/20261118115852_trade_pay_runs.sql

CREATE FUNCTION pg_temp.zz_assert(ok boolean, words text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', words; END IF;
END $$;
-- Runs a call and returns the error message, or null when it succeeded.
CREATE FUNCTION pg_temp.zz_error(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$ BEGIN
  EXECUTE p_sql; RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

-- Schema promises.
SELECT pg_temp.zz_assert((SELECT count(*) FROM public.reconcile_item_kinds WHERE kind = 'pay_run_stopped') = 1,
  'kind row must exist once after two runs');
SELECT pg_temp.zz_assert((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1'),
  'switch must be seeded off');
SELECT pg_temp.zz_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trade_pay_runs'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trade_pay_run_invoices'::regclass), 'row level security on');
SELECT pg_temp.zz_assert(NOT has_table_privilege(r, t, p), format('%s must not %s %s', r, p, t))
FROM unnest(ARRAY['anon','authenticated']) r,
     unnest(ARRAY['public.trade_pay_runs','public.trade_pay_run_invoices']) t,
     unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
SELECT pg_temp.zz_assert(has_table_privilege('service_role', t, p) AND NOT has_table_privilege('service_role', t, 'DELETE'),
  format('service_role %s on %s', p, t))
FROM unnest(ARRAY['public.trade_pay_runs','public.trade_pay_run_invoices']) t, unnest(ARRAY['SELECT','INSERT','UPDATE']) p;
SELECT pg_temp.zz_assert(has_function_privilege('service_role', 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)', 'EXECUTE'),
  'approve is service role only');
SELECT pg_temp.zz_assert((SELECT prosecdef FROM pg_proc WHERE oid = 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)'::regprocedure),
  'approve is security definer');
SELECT pg_temp.zz_assert((SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.trade_invoices'::regclass
  AND NOT attisdropped AND (attname, atttypid) IN (('pay_run_id','uuid'::regtype),('reviewed_by','uuid'::regtype),
  ('reviewed_at','timestamptz'::regtype))) = 3, 'three invoice columns');

-- Column ownership: a column of one of the three names that this migration
-- did not create (no "P1-10.1:" comment) is never touched. The apply refuses
-- it and the rollback refuses to drop it. Each run inside a savepoint; with
-- ON_ERROR_ROLLBACK each later statement still runs, so the last error is the
-- refusal itself.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_owner;
COMMENT ON COLUMN public.trade_invoices.reviewed_at IS 'ZZTEST another change owns this';
\ir ../../../migrations/20261118115852_trade_pay_runs.sql
ROLLBACK TO SAVEPOINT zz_owner;
SELECT :'LAST_ERROR_MESSAGE' AS apply_error \gset
SAVEPOINT zz_owner;
COMMENT ON COLUMN public.trade_invoices.reviewed_by IS NULL;
\ir ../../../rollbacks/20261118115852_trade_pay_runs_down.sql
ROLLBACK TO SAVEPOINT zz_owner;
SELECT :'LAST_ERROR_MESSAGE' AS down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'apply_error' LIKE '%trade_invoices already has reviewed_at, not created by this migration%',
  'apply must refuse a column it does not own: ' || :'apply_error');
SELECT pg_temp.zz_assert(:'down_error' LIKE '%trade_invoices.reviewed_by not created by this migration%',
  'rollback must refuse to drop a column it does not own: ' || :'down_error');
SELECT pg_temp.zz_assert((SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.trade_invoices'::regclass AND NOT attisdropped
  AND attname IN ('pay_run_id','reviewed_at','reviewed_by')
  AND col_description(attrelid, attnum) LIKE 'P1-10.1:%') = 3, 'all three columns owned after the refusals');

-- Rule 15 collision: another body at approve_trade_pay_run's signature is
-- never replaced by a re-apply, nor dropped by the rollback. Same savepoint
-- pattern as above; the captured last error is the refusal itself.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.approve_trade_pay_run(p_org_id uuid, p_week_start date, p_actor uuid, p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../migrations/20261118115852_trade_pay_runs.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply_error \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.approve_trade_pay_run(p_org_id uuid, p_week_start date, p_actor uuid, p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118115852_trade_pay_runs_down.sql
SELECT to_regclass('public.trade_pay_runs') IS NOT NULL
  AND to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)') IS NOT NULL AS collide_kept \gset
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_apply_error' LIKE '%approve_trade_pay_run: Rule 15, another body is installed%',
  'a re-apply must refuse another approve body: ' || :'collide_apply_error');
SELECT pg_temp.zz_assert(:'collide_down_error' LIKE '%approve_trade_pay_run is another body; refusing to drop it%'
  AND :'collide_kept'::boolean, 'the rollback must refuse to drop another approve body: ' || :'collide_down_error');
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)'::regprocedure) = '422a37ee4add48ff6bd7ca221d9fda7f',
  'own approve body after the collision proofs');

-- Historical fixtures need not satisfy today's write guards; the guards stay
-- on the run tables, and every foreign key and unique constraint stays.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','users','work_orders','trade_invoices','trade_invoice_lines','job_assignments','job_events'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid = format('public.%I', t)::regclass AND NOT tgisinternal LOOP
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', t, c.tgname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND contype IN ('c','x') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid = format('public.%I', t)::regclass
        AND attnum > 0 AND NOT attisdropped AND attnotnull AND attname <> 'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', t, c.attname);
    END LOOP;
  END LOOP;
END $$;
DROP INDEX IF EXISTS public.idx_trade_inv_unique;

-- Roles only: one approver, one office person who is not, four crew.
INSERT INTO public.users (id, org_id, role) VALUES
  ('0a100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'admin'),
  ('0a100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'ops_manager');
INSERT INTO public.users (id, org_id, role)
  SELECT ('0a100000-0000-4000-8000-0000000000' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001', 'crew'
  FROM generate_series(1, 4) n;
UPDATE public.trade_pay_settings SET inclusive_super_from = '2026-11-23',
  pay_run_approver_user_ids = ARRAY['0a100000-0000-4000-8000-000000000001'::uuid] WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, type, status)
  SELECT ('0a100000-0000-4000-8000-0000000001' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    'ZZTEST-P101-' || n, 'fencing', 'accepted' FROM generate_series(1, 4) n;
INSERT INTO public.work_orders (id, org_id, job_id, kind, status, agreed_labour_ex)
  SELECT ('0a100000-0000-4000-8000-0000000002' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a100000-0000-4000-8000-0000000001' || (10 + n))::uuid, 'job', 'approved', 1000 FROM generate_series(1, 4) n;
-- Invoice n: n x 112 inclusive of n x 12 super. Invoice 3 is queried.
INSERT INTO public.trade_invoices (id, org_id, user_id, invoice_number, week_start, status, invoice_kind,
    submitted_at, subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay, super_basis)
  SELECT ('0a100000-0000-4000-8000-0000000003' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a100000-0000-4000-8000-0000000000' || (10 + n))::uuid, 'ZZTEST-P101-INV-' || n, '2026-11-16',
    CASE WHEN n = 3 THEN 'queried' ELSE 'pending_ops_review' END, 'standard',
    '2026-11-20 01:00Z'::timestamptz + n * interval '1 minute', n * 112, n * 112, 0, n * 112, false, .12,
    n * 12, n * 100, 'inclusive_12_112_v1' FROM generate_series(1, 4) n;
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, job_work_order_id, line_type, line_total_ex, description)
  SELECT ('0a100000-0000-4000-8000-0000000003' || (10 + n))::uuid, ('0a100000-0000-4000-8000-0000000001' || (10 + n))::uuid,
    'ZZTEST-P101-' || n, ('0a100000-0000-4000-8000-0000000002' || (10 + n))::uuid, 'labour', n * 112, 'ZZTEST labour'
  FROM generate_series(1, 4) n;

-- The snapshot the server would build: invoice n, its verdict, what it pays
-- (net_pay) and its stored super.
CREATE FUNCTION pg_temp.zz_snapshot(p_stopped int[]) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_agg(jsonb_build_object(
    'invoice_id', i.id, 'verdict', CASE WHEN n = ANY(p_stopped) THEN 'stopped' ELSE 'clean' END,
    'stops', CASE WHEN n = ANY(p_stopped) THEN '[{"code":"zztest","words":"ZZTEST stop"}]'::jsonb ELSE '[]'::jsonb END,
    'pays', i.net_pay, 'super_amount', i.super_amount) ORDER BY n))
  FROM generate_series(1, 4) n
  JOIN public.trade_invoices i ON i.id = ('0a100000-0000-4000-8000-0000000003' || (10 + n))::uuid
$$;
CREATE FUNCTION pg_temp.zz_approve(p_week date, p_actor uuid, p_snapshot jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
    '00000000-0000-0000-0000-000000000001', p_week, p_actor, p_snapshot))
$$;
CREATE FUNCTION pg_temp.zz_nothing_written() RETURNS boolean LANGUAGE sql AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.trade_pay_runs)
    AND NOT EXISTS (SELECT 1 FROM public.trade_pay_run_invoices)
    AND (SELECT count(*) FROM public.trade_invoices WHERE invoice_number LIKE 'ZZTEST-P101-INV-%'
         AND pay_run_id IS NULL AND reviewed_at IS NULL AND reviewed_by IS NULL
         AND status IN ('pending_ops_review','queried')) = 4
$$;

\set approver '0a100000-0000-4000-8000-000000000001'
\set office '0a100000-0000-4000-8000-000000000002'

-- A non-Monday is refused, by the function and by the table.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-17', :'approver', pg_temp.zz_snapshot('{}')) = 'pay_run_week_invalid',
  'non-Monday must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_error($$INSERT INTO public.trade_pay_runs (org_id, week_start, check_rule, approved_by,
  snapshot, standing, invoice_count, total_pays, super_total) VALUES ('00000000-0000-0000-0000-000000000001', '2026-11-17',
  'v2', '0a100000-0000-4000-8000-000000000001', '{}', '{}', 0, 0, 0)$$) LIKE '%trade_pay_runs_week_start_check%',
  'table must refuse a non-Monday');

-- Only a named approver; no settings row, no actor, someone else: refused.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'office', pg_temp.zz_snapshot('{}')) = 'pay_run_not_approver',
  'non-approver must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', NULL, pg_temp.zz_snapshot('{}')) = 'pay_run_not_approver',
  'null actor must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'refusals wrote something');

-- A snapshot missing an amount is refused, never read as 0.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver',
  pg_temp.zz_snapshot('{}') #- '{invoices,0,pays}') = 'pay_run_snapshot_invalid', 'missing pays must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver',
  jsonb_set(pg_temp.zz_snapshot('{}'), '{invoices,1,super_amount}', '"24"')) = 'pay_run_snapshot_invalid',
  'non-numeric super must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver',
  pg_temp.zz_snapshot('{}') - 'check_rule') = 'pay_run_snapshot_invalid', 'missing rule must be refused');

-- An invoice of another organisation is refused.
UPDATE public.trade_invoices SET org_id = '00000000-0000-0000-0000-000000000009' WHERE invoice_number = 'ZZTEST-P101-INV-4';
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{}')) = 'pay_run_snapshot_invalid',
  'another organisation''s invoice must be refused');
UPDATE public.trade_invoices SET org_id = '00000000-0000-0000-0000-000000000001' WHERE invoice_number = 'ZZTEST-P101-INV-4';

-- Super one cent wrong on a clean invoice: the standing checks stop it, so
-- the week changed since it was shown and nothing is written.
UPDATE public.trade_invoices SET super_amount = 24.01, net_pay = 199.99 WHERE invoice_number = 'ZZTEST-P101-INV-2';
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{}')) = 'pay_run_changed_since_shown',
  'one cent wrong super in the clean set must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'changed week wrote something');

-- A snapshot whose super no longer matches the invoice is refused too.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver',
  jsonb_set(pg_temp.zz_snapshot('{2}'), '{invoices,0,super_amount}', '12.5')) = 'pay_run_changed_since_shown',
  'snapshot super that differs from the invoice must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'super drift wrote something');

-- One cent of pay drift with super unchanged: refused, nothing written.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver',
  jsonb_set(pg_temp.zz_snapshot('{2}'), '{invoices,0,pays}', '100.01')) = 'pay_run_changed_since_shown',
  'one cent of pay drift must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'pay drift wrote something');

-- A clean invoice missing a stored figure is refused, never read as 0.
SELECT pg_temp.zz_snapshot('{2}') AS shown \gset
SAVEPOINT zz_missing;
UPDATE public.trade_invoices SET net_pay = NULL WHERE invoice_number = 'ZZTEST-P101-INV-1';
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', :'shown') = 'pay_run_figures_unreadable',
  'a clean invoice with no stored net pay must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'missing figure wrote something');
ROLLBACK TO SAVEPOINT zz_missing;

-- An invoice already approved, pushed or paid, or already billed in Xero,
-- labelled clean: refused before anything is written.
SAVEPOINT zz_paid;
UPDATE public.trade_invoices SET status = 'paid' WHERE invoice_number = 'ZZTEST-P101-INV-1';
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', :'shown') = 'pay_run_changed_since_shown',
  'a paid invoice labelled clean must be refused');
UPDATE public.trade_invoices SET status = 'pending_ops_review', xero_bill_id = 'ZZTEST-BILL'
  WHERE invoice_number = 'ZZTEST-P101-INV-1';
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', :'shown') = 'pay_run_changed_since_shown',
  'an invoice billed in Xero labelled clean must be refused');
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.trade_pay_runs)
  AND NOT EXISTS (SELECT 1 FROM public.trade_pay_run_invoices), 'paid invoice wrote something');
ROLLBACK TO SAVEPOINT zz_paid;

-- A run the standing checks block writes nothing. P1-08.3 only blocks after
-- the bills are drafted, so a stand-in answer is used inside a savepoint.
SAVEPOINT zz_blocked;
CREATE OR REPLACE FUNCTION public.trade_pay_run_standing_checks(p_org_id uuid, p_invoice_ids uuid[], p_stage text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT '{"rule":"zztest","checks":[],"stopped_invoices":[],"run_blocked":true,"run_blocked_words":"ZZTEST"}'::jsonb
$$;
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{2}')) = 'pay_run_standing_check_failed',
  'blocked run must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'blocked run wrote something');
-- An unreadable answer is refused, never read as clean.
CREATE OR REPLACE FUNCTION public.trade_pay_run_standing_checks(p_org_id uuid, p_invoice_ids uuid[], p_stage text)
RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{2}')) = 'pay_run_standing_check_unreadable',
  'unreadable standing answer must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'unreadable answer wrote something');
-- Any stop on an invoice sent as clean refuses: a malformed entry ([{}]) is
-- unreadable, a named clean invoice means the week changed.
CREATE OR REPLACE FUNCTION public.trade_pay_run_standing_checks(p_org_id uuid, p_invoice_ids uuid[], p_stage text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT '{"rule":"zztest","checks":[],"stopped_invoices":[{}],"run_blocked":false}'::jsonb
$$;
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{2}')) = 'pay_run_standing_check_unreadable',
  'stopped_invoices [{}] must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'malformed stop wrote something');
CREATE OR REPLACE FUNCTION public.trade_pay_run_standing_checks(p_org_id uuid, p_invoice_ids uuid[], p_stage text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('rule','zztest','checks','[]'::jsonb,'run_blocked',false,
    'stopped_invoices', jsonb_build_array(jsonb_build_object('invoice_id', p_invoice_ids[1], 'stops', '[]'::jsonb)))
$$;
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{2}')) = 'pay_run_changed_since_shown',
  'a stop on a clean invoice must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_nothing_written(), 'stop on a clean invoice wrote something');
ROLLBACK TO SAVEPOINT zz_blocked;

-- Three clean and one stopped (the one-cent invoice): one run, four rows,
-- three invoices approved and stamped, the stopped one untouched.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{2}')) IS NULL,
  'the run must be approved');
SELECT pg_temp.zz_assert((SELECT count(*) = 1 AND bool_and(r.invoice_count = 3 AND r.total_pays = 800
    AND r.super_total = 96 AND r.status = 'approved' AND r.check_rule = 'v2'
    AND r.approved_by = :'approver' AND r.standing->>'rule' = 'pay-run-standing-v1'
    AND r.snapshot = pg_temp.zz_snapshot('{2}') AND r.super_marked_paid_at IS NULL)
  FROM public.trade_pay_runs r), 'one run with clean totals');
SELECT pg_temp.zz_assert((SELECT count(*) = 4 AND count(*) FILTER (WHERE verdict = 'stopped') = 1
    AND bool_and(pushed_at IS NULL AND xero_bill_id IS NULL)
    AND bool_and(CASE WHEN verdict = 'stopped' THEN stops <> '[]' AND pays = 199.99 AND super_amount = 24.01 ELSE stops = '[]' END)
  FROM public.trade_pay_run_invoices), 'four run-invoice rows');
SELECT pg_temp.zz_assert((SELECT count(*) = 3 AND bool_and(i.status = 'approved' AND i.pay_run_id = r.id
    AND i.reviewed_by = :'approver' AND i.reviewed_at IS NOT NULL AND to_jsonb(i)->>'acknowledged_at' IS NULL)
  FROM public.trade_invoices i CROSS JOIN public.trade_pay_runs r
  WHERE i.invoice_number IN ('ZZTEST-P101-INV-1','ZZTEST-P101-INV-3','ZZTEST-P101-INV-4')), 'three invoices approved');
SELECT pg_temp.zz_assert((SELECT status = 'pending_ops_review' AND pay_run_id IS NULL AND reviewed_at IS NULL
    AND reviewed_by IS NULL FROM public.trade_invoices WHERE invoice_number = 'ZZTEST-P101-INV-2'), 'stopped invoice untouched');

-- A second call for the same week is refused, and writes nothing more.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-16', :'approver', pg_temp.zz_snapshot('{2}')) = 'pay_run_already_approved',
  'second approval must be refused');
-- An invoice already in a run cannot be approved again in another week.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-23', :'approver', pg_temp.zz_snapshot('{2}')) = 'pay_run_changed_since_shown',
  'an invoice already in a run must be refused');
SELECT pg_temp.zz_assert((SELECT count(*) FROM public.trade_pay_runs) = 1
  AND (SELECT count(*) FROM public.trade_pay_run_invoices) = 4, 'refusals after the run wrote something');

-- Existing invoice rows keep null review columns (only the run wrote them).
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.trade_invoices
  WHERE (reviewed_at IS NOT NULL OR reviewed_by IS NOT NULL OR pay_run_id IS NOT NULL)
    AND invoice_number NOT IN ('ZZTEST-P101-INV-1','ZZTEST-P101-INV-3','ZZTEST-P101-INV-4')), 'other invoices untouched');

-- Ruling A: the invoice stopped in week 16 is listed again in week 23 and,
-- now right, is paid there; an invoice can never be paid by a second run.
UPDATE public.trade_invoices SET super_amount = 24, net_pay = 200 WHERE invoice_number = 'ZZTEST-P101-INV-2';
CREATE FUNCTION pg_temp.zz_only(p_number text, p_verdict text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_agg(e || jsonb_build_object('verdict', p_verdict)))
  FROM jsonb_array_elements(pg_temp.zz_snapshot('{}')->'invoices') e
  JOIN public.trade_invoices i ON i.id = (e->>'invoice_id')::uuid AND i.invoice_number = p_number
$$;
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-23', :'approver', pg_temp.zz_only('ZZTEST-P101-INV-2', 'clean')) IS NULL,
  'a stopped invoice must list again and be paid next week');
SELECT pg_temp.zz_assert((SELECT count(*) = 2 AND count(*) FILTER (WHERE ri.verdict = 'clean' AND r.week_start = '2026-11-23'
    AND ri.pays = 200 AND ri.super_amount = 24) = 1
  FROM public.trade_pay_run_invoices ri JOIN public.trade_pay_runs r ON r.id = ri.run_id
  JOIN public.trade_invoices i ON i.id = ri.invoice_id WHERE i.invoice_number = 'ZZTEST-P101-INV-2'),
  'invoice 2: stopped in one run, paid by the next');
SELECT pg_temp.zz_assert((SELECT r.total_pays = 200 AND r.super_total = 24 AND r.invoice_count = 1
  FROM public.trade_pay_runs r WHERE r.week_start = '2026-11-23'), 'second run totals from the locked row');
-- A clean invoice cannot join a second run, as clean or as a stray row.
SELECT pg_temp.zz_assert(pg_temp.zz_approve('2026-11-30', :'approver', pg_temp.zz_only('ZZTEST-P101-INV-1', 'clean'))
  = 'pay_run_changed_since_shown', 'a paid invoice must not be approved by a second run');
SELECT pg_temp.zz_assert(pg_temp.zz_error($$INSERT INTO public.trade_pay_run_invoices (run_id, invoice_id, verdict, pays, super_amount)
  SELECT r.id, i.id, 'clean', 100, 12 FROM public.trade_pay_runs r, public.trade_invoices i
  WHERE r.week_start = '2026-11-23' AND i.invoice_number = 'ZZTEST-P101-INV-1'$$) LIKE '%trade_pay_run_invoices_clean_once%',
  'a second clean row for one invoice must be refused by the table');
SELECT pg_temp.zz_assert((SELECT count(*) FROM public.trade_pay_runs) = 2
  AND (SELECT count(*) FROM public.trade_pay_run_invoices) = 5, 'ruling A refusals wrote something');

-- Rule 16, on populated tables: the approval's lock read and its paid-run
-- check read a few rows by index, never the whole table.
INSERT INTO public.trade_invoices (id, org_id, invoice_number, status, invoice_kind)
  SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000009', 'ZZTEST-BULK-' || n, 'approved', 'standard'
  FROM generate_series(1, 20000) n;
INSERT INTO public.trade_pay_runs (org_id, week_start, check_rule, approved_by, snapshot, standing, invoice_count, total_pays, super_total)
  SELECT '00000000-0000-0000-0000-000000000009', '2020-01-06'::date + 7 * n, 'v2', :'approver', '{}', '{}', 0, 0, 0
  FROM generate_series(1, 200) n;
INSERT INTO public.trade_pay_run_invoices (run_id, invoice_id, verdict, pays, super_amount)
  SELECT r.id, i.id, 'stopped', 1, 0
  FROM (SELECT id, row_number() OVER (ORDER BY week_start) w FROM public.trade_pay_runs
        WHERE org_id = '00000000-0000-0000-0000-000000000009') r
  JOIN (SELECT id, row_number() OVER (ORDER BY invoice_number) k FROM public.trade_invoices
        WHERE invoice_number LIKE 'ZZTEST-BULK-%') i ON (i.k - 1) / 100 + 1 = r.w;
ANALYZE public.trade_invoices;
ANALYZE public.trade_pay_run_invoices;
CREATE FUNCTION pg_temp.zz_plan(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE line text; plan text := '';
BEGIN
  FOR line IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ' || p_sql LOOP
    plan := plan || line || E'\n';
  END LOOP;
  RETURN plan;
END $$;
SELECT pg_temp.zz_plan(format($q$SELECT 1 FROM public.trade_invoices i WHERE i.id = ANY(%L::uuid[]) ORDER BY i.id FOR UPDATE$q$,
  (SELECT array_agg(id) FROM public.trade_invoices WHERE invoice_number LIKE 'ZZTEST-P101-INV-%'))) AS lock_plan \gset
SELECT pg_temp.zz_assert(:'lock_plan' NOT LIKE '%Seq Scan on trade_invoices%', 'lock read scanned trade_invoices: ' || :'lock_plan');
SELECT pg_temp.zz_plan(format($q$SELECT 1 FROM public.trade_pay_run_invoices ri WHERE ri.invoice_id = %L AND ri.verdict = 'clean'$q$,
  (SELECT id FROM public.trade_invoices WHERE invoice_number = 'ZZTEST-BULK-5'))) AS run_plan \gset
SELECT pg_temp.zz_assert(:'run_plan' NOT LIKE '%Seq Scan on trade_pay_run_invoices%', 'paid-run check scanned the run rows: ' || :'run_plan');
SELECT pg_temp.zz_assert((SELECT count(*) FROM public.trade_pay_run_invoices) = 20005, 'bulk run rows loaded');
-- The approval's whole eligibility read (the moved-since-shown EXISTS: the
-- snapshot join, the run check and the clean-invoice comparisons), as
-- PL/pgSQL runs it: a generic plan with the snapshot as a parameter. Each
-- table is read through an index, never scanned.
SET LOCAL plan_cache_mode = force_generic_plan;
PREPARE zz_eligibility(jsonb) AS
SELECT EXISTS (
  SELECT 1 FROM public.trade_invoices i
  JOIN jsonb_array_elements($1->'invoices') e ON (e->>'invoice_id')::uuid = i.id
  WHERE i.pay_run_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.trade_pay_run_invoices ri
                WHERE ri.invoice_id = i.id AND ri.verdict = 'clean')
     OR (e->>'verdict' = 'clean' AND (
          i.status NOT IN ('pending_ops_review', 'queried')
          OR i.xero_bill_id IS NOT NULL
          OR i.super_amount <> (e->>'super_amount')::numeric
          OR round(i.net_pay + CASE WHEN i.gst_on THEN i.gst ELSE 0 END
                   - coalesce(i.recurring_deduction_amount, 0), 2) <> (e->>'pays')::numeric)));
SELECT pg_temp.zz_plan(format('EXECUTE zz_eligibility(%L)', jsonb_build_object('check_rule', 'v2', 'invoices',
  (SELECT jsonb_agg(jsonb_build_object('invoice_id', i.id, 'verdict', 'clean', 'pays', 1, 'super_amount', 0))
   FROM public.trade_invoices i WHERE i.invoice_number IN ('ZZTEST-BULK-7', 'ZZTEST-BULK-8007', 'ZZTEST-BULK-15007'))))) AS elig_plan \gset
SELECT pg_temp.zz_assert(:'elig_plan' NOT LIKE '%Seq Scan%' AND :'elig_plan' LIKE '%Index%trade_invoices%'
  AND :'elig_plan' LIKE '%Index%trade_pay_run_invoices%', 'eligibility read is not index bound: ' || :'elig_plan');
DEALLOCATE zz_eligibility;
RESET plan_cache_mode;

ROLLBACK;
\echo 'PASS: P1-10.1 pay run record, approval, refusals, ruling A, plans and kind row.'
