-- cl-payrun-escape contract. Every value, id and word is made up (ZZTEST).
--
-- An invoice the run's push moved to approved and then refused (the
-- repayment lock changed what it pays) is stuck: stamped, approved, no bill.
-- An approver releases it back to review, recorded and guarded; the run can
-- still finish; a later run can take it.
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts on.
\ir ../../../migrations/20261118999901_trade_pay_run_release.sql
\ir ../../../migrations/20261118999901_trade_pay_run_release.sql

CREATE FUNCTION pg_temp.zz_assert(ok boolean, words text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', words; END IF;
END $$;
CREATE FUNCTION pg_temp.zz_error(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$ BEGIN
  EXECUTE p_sql; RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'::regprocedure) = '152edcbbc1ddff5f29d91e8f8af71860',
  'own body installed after two runs');
SELECT pg_temp.zz_assert(has_function_privilege('service_role', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE'),
  'service role only');
SELECT pg_temp.zz_assert((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1'),
  'switch stays off');
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.trade_pay_run_invoices'::regclass
  AND NOT tgisinternal), 'no trigger on the run rows');

-- Rule 15: another body is never replaced by a re-apply nor dropped by the rollback.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.release_trade_pay_run_invoice(p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_reason text, p_xero_check jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../migrations/20261118999901_trade_pay_run_release.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply_error \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.release_trade_pay_run_invoice(p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_reason text, p_xero_check jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118999901_trade_pay_run_release_down.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_apply_error' LIKE '%release_trade_pay_run_invoice: Rule 15, another body is installed%',
  'a re-apply must refuse another body: ' || :'collide_apply_error');
SELECT pg_temp.zz_assert(:'collide_down_error' LIKE '%release_trade_pay_run_invoice rollback: another body is installed%',
  'the rollback must refuse another body: ' || :'collide_down_error');
-- A column of one of these names that is not this migration's is refused.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide_col;
COMMENT ON COLUMN public.trade_pay_run_invoices.release_reason IS 'someone else';
\ir ../../../migrations/20261118999901_trade_pay_run_release.sql
ROLLBACK TO SAVEPOINT zz_collide_col;
SELECT :'LAST_ERROR_MESSAGE' AS collide_col_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_col_error' LIKE '%columns release_reason exist and are not this migration''s%',
  'a foreign column must be refused: ' || :'collide_col_error');
-- The rollback, then a re-apply, round-trip to this body.
SAVEPOINT zz_round;
\ir ../../../rollbacks/20261118999901_trade_pay_run_release_down.sql
SELECT pg_temp.zz_assert(to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)') IS NULL,
  'the rollback drops the function');
\ir ../../../migrations/20261118999901_trade_pay_run_release.sql
RELEASE SAVEPOINT zz_round;

-- Fixtures: four crew invoices for one week, n x 112 inclusive of n x 12
-- super, written with user triggers off; every trigger is back on after.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','users','work_orders','trade_invoices','trade_invoice_lines'] LOOP
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
SET LOCAL session_replication_role = replica;
INSERT INTO public.users (id, org_id, role) VALUES
  ('0a170000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'admin'),
  ('0a170000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'admin');
INSERT INTO public.users (id, org_id, role)
  SELECT ('0a170000-0000-4000-8000-0000000000' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001', 'crew'
  FROM generate_series(1, 4) n;
UPDATE public.trade_pay_settings SET inclusive_super_from = '2026-11-23',
  pay_run_approver_user_ids = ARRAY['0a170000-0000-4000-8000-000000000001'::uuid] WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, type, status)
  SELECT ('0a170000-0000-4000-8000-0000000001' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    'ZZTEST-ESC-' || n, 'fencing', 'accepted' FROM generate_series(1, 4) n;
INSERT INTO public.work_orders (id, org_id, job_id, kind, status, agreed_labour_ex)
  SELECT ('0a170000-0000-4000-8000-0000000002' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a170000-0000-4000-8000-0000000001' || (10 + n))::uuid, 'job', 'approved', 1000 FROM generate_series(1, 4) n;
INSERT INTO public.trade_invoices (id, org_id, user_id, invoice_number, week_start, status, invoice_kind,
    submitted_at, subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay, super_basis)
  SELECT ('0a170000-0000-4000-8000-0000000003' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a170000-0000-4000-8000-0000000000' || (10 + n))::uuid, 'ZZTEST-ESC-INV-' || n, '2026-11-16',
    CASE WHEN n = 4 THEN 'queried' ELSE 'pending_ops_review' END, 'standard',
    '2026-11-20 01:00Z'::timestamptz + n * interval '1 minute', n * 112, n * 112, 0, n * 112, false, .12,
    n * 12, n * 100, 'inclusive_12_112_v1' FROM generate_series(1, 4) n;
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, job_work_order_id, line_type, line_total_ex, description)
  SELECT ('0a170000-0000-4000-8000-0000000003' || (10 + n))::uuid, ('0a170000-0000-4000-8000-0000000001' || (10 + n))::uuid,
    'ZZTEST-ESC-' || n, ('0a170000-0000-4000-8000-0000000002' || (10 + n))::uuid, 'labour', n * 112, 'ZZTEST labour'
  FROM generate_series(1, 4) n;
-- Invoice 2 repays 30 of a 50 balance; a pushed invoice of an earlier week
-- already took 30, so only 20 is left (the save lock is not installed yet).
INSERT INTO public.trade_recurring_deductions (id, user_id, label, amount, first_week_start, kind, balance_total, xero_account_code)
  VALUES ('0a170000-0000-4000-8000-000000000601', '0a170000-0000-4000-8000-000000000012', 'ZZTEST repayment', 30,
    '2026-11-09', 'repayment', 50, 'ZZTEST-account');
UPDATE public.trade_invoices SET recurring_deduction_id = '0a170000-0000-4000-8000-000000000601',
    recurring_deduction_label = 'ZZTEST repayment', recurring_deduction_amount = 30
  WHERE id = '0a170000-0000-4000-8000-000000000312';
INSERT INTO public.trade_invoices (id, org_id, user_id, invoice_number, week_start, status, invoice_kind,
    submitted_at, subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay, super_basis,
    xero_bill_id, recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount)
  VALUES ('0a170000-0000-4000-8000-000000000399', '00000000-0000-0000-0000-000000000001',
    '0a170000-0000-4000-8000-000000000012', 'ZZTEST-ESC-PRIOR', '2026-11-09', 'approved', 'standard',
    '2026-11-13 01:00Z', 112, 112, 0, 112, false, .12, 12, 100, 'inclusive_12_112_v1', 'ZZTEST-BILL-PRIOR',
    '0a170000-0000-4000-8000-000000000601', 'ZZTEST repayment', 30);
SET LOCAL session_replication_role = origin;

-- The run, all four clean.
SELECT pg_temp.zz_assert(pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-000000000001', '2026-11-16', '0a170000-0000-4000-8000-000000000001',
  (SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_agg(jsonb_build_object(
    'invoice_id', i.id, 'verdict', 'clean', 'stops', '[]'::jsonb,
    'pays', i.net_pay - coalesce(i.recurring_deduction_amount, 0), 'super_amount', i.super_amount) ORDER BY i.invoice_number))
   FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-ESC-INV-%'))) IS NULL,
  'the run must be approved: ' || coalesce(pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-000000000001', '2026-11-16', '0a170000-0000-4000-8000-000000000001',
  (SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_agg(jsonb_build_object(
    'invoice_id', i.id, 'verdict', 'clean', 'stops', '[]'::jsonb,
    'pays', i.net_pay - coalesce(i.recurring_deduction_amount, 0), 'super_amount', i.super_amount) ORDER BY i.invoice_number))
   FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-ESC-INV-%'))), ''));
SELECT id AS zz_run FROM public.trade_pay_runs WHERE week_start = '2026-11-16' \gset
\set inv1 '0a170000-0000-4000-8000-000000000311'
\set inv2 '0a170000-0000-4000-8000-000000000312'
\set inv3 '0a170000-0000-4000-8000-000000000313'
\set inv4 '0a170000-0000-4000-8000-000000000314'
\set approver '0a170000-0000-4000-8000-000000000001'
\set other '0a170000-0000-4000-8000-000000000002'
CREATE FUNCTION pg_temp.zz_release(p_inv uuid, p_actor uuid, p_reason text, p_check jsonb DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.zz_error(format('SELECT public.release_trade_pay_run_invoice(%L, %L, %L, %L, %L)',
    (SELECT id FROM public.trade_pay_runs WHERE week_start = '2026-11-16'), p_inv, p_actor, p_reason, p_check))
$$;
CREATE TEMP TABLE zz_rows_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.invoice_id)::text, '')) AS h FROM public.trade_pay_run_invoices r;
CREATE TEMP TABLE zz_inv_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) AS h FROM public.trade_invoices i
  WHERE i.invoice_number LIKE 'ZZTEST-ESC-INV-%';

-- Job cost and Job Profit as the run left them (stamped, in review), before
-- the push's move. The release must bring both back to exactly this (the job
-- cost triggers on trade_invoices are installed, as 20261118163000's case does).
SELECT to_regprocedure('public.job_cost_lines_install_trade_triggers()') IS NOT NULL AS have_cost \gset
\if :have_cost
SELECT public.job_cost_lines_install_trade_triggers();
\endif
CREATE TEMP TABLE zz_cost_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id)::text, '')) AS h FROM public.job_cost_lines c;
CREATE TEMP TABLE zz_profit_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.job_id)::text, '')) AS h
  FROM public.v_job_profit v WHERE v.job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-ESC-%');
-- The stuck state: the push moved invoice 2 to approved, the repayment save
-- lock took the instalment down to what is left (30 to 20), so its pay no
-- longer matched the run and the push refused.
SELECT public.install_trade_repayment_save_lock();
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'trade_repayments_v1';
UPDATE public.trade_invoices SET status = 'approved' WHERE id = :'inv2';
SELECT pg_temp.zz_assert((SELECT recurring_deduction_amount FROM public.trade_invoices WHERE id = :'inv2') = 20
  AND (SELECT pays FROM public.trade_pay_run_invoices WHERE invoice_id = :'inv2') = 170,
  'the stuck state: the move lowered the repayment, so the run''s pay no longer matches');
UPDATE zz_inv_before SET h = (SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) FROM public.trade_invoices i
  WHERE i.invoice_number LIKE 'ZZTEST-ESC-INV-%');

-- Refusals write nothing.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'other', 'ZZTEST the deduction changed') LIKE '%pay_run_not_approver%',
  'someone off the approver list is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', '  ab ') LIKE '%pay_run_release_reason_required%'
  AND pg_temp.zz_release(:'inv2', :'approver', NULL) LIKE '%pay_run_release_reason_required%'
  AND pg_temp.zz_release(:'inv2', :'approver', repeat('z', 501)) LIKE '%pay_run_release_reason_required%',
  'a missing, short or long reason is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', NULL, 'ZZTEST the deduction changed') LIKE '%pay_run_release_invalid%',
  'no actor is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release('0c400000-0000-4000-8000-0000000000ff', :'approver', 'ZZTEST the deduction changed') LIKE '%invoice_not_in_run%',
  'an invoice not in the run is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_error(format('SELECT public.release_trade_pay_run_invoice(%L, %L, %L, %L)',
  '0c400000-0000-4000-8000-0000000000fe', :'inv2', :'approver', 'ZZTEST the deduction changed')) LIKE '%pay_run_not_found%',
  'an unknown run is refused');
-- A live push claim: a press may be calling Xero.
SELECT public.claim_trade_pay_run_push(:'zz_run', :'inv2', :'approver') AS zz_claim \gset
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed') LIKE '%pay_run_push_in_progress%',
  'a live claim is refused');
UPDATE public.trade_pay_run_invoices SET push_claimed_at = clock_timestamp() - interval '11 minutes'
 WHERE run_id = :'zz_run' AND invoice_id = :'inv2';
-- A lapsed claim was never given back, so that press may have reached Xero.
-- Director ruling 18 Nov: released only with a recorded Xero check that says
-- the invoice is not in Xero, names the approver who checked, and is dated
-- after the claim lapsed.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed') LIKE '%pay_run_push_claim_lapsed%',
  'a lapsed claim without a Xero check is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed', '"checked"') LIKE '%pay_run_push_claim_lapsed%',
  'a Xero check that is not a record is refused');
SELECT jsonb_build_object('in_xero', false, 'checked_by', :'approver', 'checked_at', clock_timestamp())::text AS zz_good_check,
       (push_claimed_at + interval '10 minutes')::text AS zz_lapsed_at
  FROM public.trade_pay_run_invoices WHERE run_id = :'zz_run' AND invoice_id = :'inv2' \gset
-- Found in Xero: never released.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || '{"in_xero": true}') LIKE '%pay_run_xero_check_found_in_xero%',
  'a check that found the invoice in Xero is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) - 'in_xero') LIKE '%pay_run_xero_check_invalid%'
  AND pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || '{"in_xero": "false"}') LIKE '%pay_run_xero_check_invalid%',
  'a check that does not say plainly the invoice is not in Xero is refused');
-- Unnamed checker, or someone off the approver list.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) - 'checked_by') LIKE '%pay_run_xero_check_unnamed%'
  AND pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || '{"checked_by": "  "}') LIKE '%pay_run_xero_check_unnamed%'
  AND pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || '{"checked_by": "ZZTEST office"}') LIKE '%pay_run_xero_check_unnamed%'
  AND pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || '{"checked_by": null}') LIKE '%pay_run_xero_check_unnamed%',
  'a check that names no approver is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || jsonb_build_object('checked_by', :'other')) LIKE '%pay_run_xero_check_not_approver%',
  'a check by someone off the approver list is refused');
-- Stale: dated before, or exactly at, the lapse.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || jsonb_build_object('checked_at', :'zz_lapsed_at'::timestamptz - interval '1 minute')) LIKE '%pay_run_xero_check_stale%'
  AND pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || jsonb_build_object('checked_at', :'zz_lapsed_at'::timestamptz)) LIKE '%pay_run_xero_check_stale%',
  'a check dated before the claim lapsed is refused');
-- Undated, unreadable or in the future.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) - 'checked_at') LIKE '%pay_run_xero_check_invalid%'
  AND pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || '{"checked_at": "ZZTEST yesterday"}') LIKE '%pay_run_xero_check_invalid%'
  AND pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed',
    (:'zz_good_check'::jsonb) || jsonb_build_object('checked_at', clock_timestamp() + interval '1 hour')) LIKE '%pay_run_xero_check_invalid%',
  'a check with no readable date, or dated in the future, is refused');
-- Any Xero identity on the invoice.
UPDATE public.trade_invoices SET xero_pushed_at = now() WHERE id = :'inv2';
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed', :'zz_good_check') LIKE '%pay_run_invoice_billed%',
  'an invoice with a Xero push stamp is refused');
UPDATE public.trade_invoices SET xero_pushed_at = NULL, xero_bill_id = 'ZZTEST-BILL' WHERE id = :'inv2';
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed', :'zz_good_check') LIKE '%pay_run_invoice_billed%',
  'an invoice with a Xero bill is refused');
UPDATE public.trade_invoices SET xero_bill_id = NULL, status = 'acknowledged' WHERE id = :'inv2';
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', 'ZZTEST the deduction changed', :'zz_good_check') LIKE '%pay_run_invoice_status%',
  'a status outside approved, pending_ops_review and queried is refused');
UPDATE public.trade_invoices SET status = 'approved' WHERE id = :'inv2';
-- A pushed row and a stopped row.
UPDATE public.trade_pay_run_invoices SET pushed_at = now(), xero_bill_id = 'ZZTEST-BILL-1'
 WHERE run_id = :'zz_run' AND invoice_id = :'inv1';
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver', 'ZZTEST the deduction changed') LIKE '%pay_run_invoice_pushed%',
  'a pushed row is refused');
UPDATE public.trade_pay_run_invoices SET pushed_at = NULL, xero_bill_id = NULL, verdict = 'stopped'
 WHERE run_id = :'zz_run' AND invoice_id = :'inv1';
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver', 'ZZTEST the deduction changed') LIKE '%invoice_not_clean%',
  'a stopped row is refused');
UPDATE public.trade_pay_run_invoices SET verdict = 'clean' WHERE run_id = :'zz_run' AND invoice_id = :'inv1';
SELECT pg_temp.zz_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) FROM public.trade_invoices i
  WHERE i.invoice_number LIKE 'ZZTEST-ESC-INV-%') = (SELECT h FROM zz_inv_before), 'a refusal changed an invoice');
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.trade_pay_run_invoices WHERE released_at IS NOT NULL),
  'a refusal recorded a release');
\echo 'PASS: cl-payrun-escape refusals: approver only, reason, live claim, lapsed claim with no Xero check, found in Xero, unnamed or non-approver checker, stale, undated or future check, Xero identity, status, pushed and stopped rows; nothing written.'

-- The release: back to review, recorded, the clean slot freed, the lapsed claim cleared.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver', '  ZZTEST the deduction changed  ', :'zz_good_check') IS NULL,
  'the release, with a Xero check that says not in Xero, names an approver and is dated after the lapse');
SELECT pg_temp.zz_assert((SELECT i.status = 'pending_ops_review' AND i.pay_run_id IS NULL
    AND i.reviewed_at IS NULL AND i.reviewed_by IS NULL AND i.xero_bill_id IS NULL
  FROM public.trade_invoices i WHERE i.id = :'inv2'), 'the invoice is back in review with no run');
-- The release's own status write passes the save lock again and changes
-- nothing: the lock only ever lowers, and 20 is what is left.
SELECT pg_temp.zz_assert((SELECT recurring_deduction_amount FROM public.trade_invoices WHERE id = :'inv2') = 20,
  'the release keeps the lowered repayment');
SELECT pg_temp.zz_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id)::text, '')) FROM public.job_cost_lines c)
  = (SELECT h FROM zz_cost_before), 'the release did not bring job cost back to the run''s state');
SELECT pg_temp.zz_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.job_id)::text, ''))
  FROM public.v_job_profit v WHERE v.job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-ESC-%'))
  = (SELECT h FROM zz_profit_before), 'the release did not bring Job Profit back to the run''s state');
SELECT pg_temp.zz_assert((SELECT r.verdict = 'stopped' AND r.released_by = :'approver'::uuid AND r.released_at IS NOT NULL
    AND r.release_reason = 'ZZTEST the deduction changed' AND r.push_claimed_at IS NULL AND r.push_claimed_by IS NULL
    AND r.stops @> '[{"code":"released_from_run","xero_check":{"in_xero":false}}]' AND r.pays = 170 AND r.super_amount = 24
    AND r.release_xero_check->'in_xero' = 'false'::jsonb
    AND (r.release_xero_check->>'checked_by')::uuid = :'approver'::uuid
    AND (r.release_xero_check->>'checked_at')::timestamptz = (:'zz_good_check'::jsonb->>'checked_at')::timestamptz
    AND (r.release_xero_check->>'claim_lapsed_at')::timestamptz = :'zz_lapsed_at'::timestamptz
  FROM public.trade_pay_run_invoices r WHERE r.run_id = :'zz_run' AND r.invoice_id = :'inv2'),
  'the run row records who, when and why, and keeps the figures it was approved with');
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.trade_pay_run_invoices WHERE invoice_id = :'inv2' AND verdict = 'clean'),
  'the invoice holds no clean row');
SELECT pg_temp.zz_assert(public.claim_trade_pay_run_push(:'zz_run', :'inv2', :'approver') IS NULL,
  'a push claim after the release gets nothing');
SELECT pg_temp.zz_assert((SELECT status = 'approved' AND invoice_count = 4 AND total_pays = 970 AND super_total = 120
  FROM public.trade_pay_runs WHERE id = :'zz_run'), 'the run record (its approved snapshot) is not rewritten');
-- A later run takes it: the real approval for the next week stamps it
-- (its own guard refuses an invoice that still holds a clean row).
SAVEPOINT zz_next_week;
SELECT coalesce(pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-000000000001', '2026-11-23', :'approver',
  (SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_build_array(jsonb_build_object(
    'invoice_id', i.id, 'verdict', 'clean', 'stops', '[]'::jsonb,
    'pays', round(i.net_pay + CASE WHEN i.gst_on THEN i.gst ELSE 0 END - coalesce(i.recurring_deduction_amount, 0), 2),
    'super_amount', i.super_amount)))
   FROM public.trade_invoices i WHERE i.id = :'inv2'))), '') AS zz_next \gset
SELECT pg_temp.zz_assert(:'zz_next' = ''
  AND (SELECT i.pay_run_id = r.id AND i.status = 'pending_ops_review'
       FROM public.trade_invoices i JOIN public.trade_pay_runs r ON r.week_start = '2026-11-23' WHERE i.id = :'inv2'),
  'the next week''s run must take the released invoice: ' || :'zz_next');
-- Next week's push moves it to approved: the save lock leaves it alone, so
-- its pay still matches the new run and that push is not refused again.
UPDATE public.trade_invoices SET status = 'approved' WHERE id = :'inv2';
SELECT pg_temp.zz_assert((SELECT i.recurring_deduction_amount = 20 AND r.pays = i.net_pay - 20
  FROM public.trade_invoices i JOIN public.trade_pay_run_invoices r ON r.invoice_id = i.id
  JOIN public.trade_pay_runs pr ON pr.id = r.run_id AND pr.week_start = '2026-11-23'
  WHERE i.id = :'inv2'), 'next week''s move leaves the pay as the new run recorded it');
ROLLBACK TO SAVEPOINT zz_next_week;
\echo 'PASS: cl-payrun-escape release: back to review, recorded, claim cleared, slot freed, run snapshot kept.'

-- A second press says already released and writes nothing.
UPDATE zz_rows_before SET h = (SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.invoice_id)::text, '')) FROM public.trade_pay_run_invoices r);
UPDATE zz_inv_before SET h = (SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) FROM public.trade_invoices i
  WHERE i.invoice_number LIKE 'ZZTEST-ESC-INV-%');
SELECT pg_temp.zz_assert((SELECT (public.release_trade_pay_run_invoice(:'zz_run', :'inv2', :'approver', 'ZZTEST again please'))->>'already_released') = 'true',
  'a second press says already released');
SELECT pg_temp.zz_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.invoice_id)::text, '')) FROM public.trade_pay_run_invoices r)
  = (SELECT h FROM zz_rows_before)
  AND (SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) FROM public.trade_invoices i
       WHERE i.invoice_number LIKE 'ZZTEST-ESC-INV-%') = (SELECT h FROM zz_inv_before),
  'a second press wrote something');

-- A held invoice still in pending_ops_review or queried keeps its status.
SELECT coalesce(pg_temp.zz_release(:'inv4', :'approver', 'ZZTEST office wants it back'), '') AS zz_q4 \gset
SELECT pg_temp.zz_assert(:'zz_q4' = ''
  AND (SELECT status = 'queried' AND pay_run_id IS NULL FROM public.trade_invoices WHERE id = :'inv4')
  AND (SELECT release_xero_check IS NULL FROM public.trade_pay_run_invoices WHERE invoice_id = :'inv4'),
  'a queried invoice with no push claim is released with no Xero check needed, and stays queried: ' || :'zz_q4');

-- The run can finish: once its last clean unpushed row is released, it is pushed.
UPDATE public.trade_pay_run_invoices SET pushed_at = now(), xero_bill_id = 'ZZTEST-BILL-1'
 WHERE run_id = :'zz_run' AND invoice_id = :'inv1';
SELECT pg_temp.zz_assert((SELECT status FROM public.trade_pay_runs WHERE id = :'zz_run') = 'approved',
  'the run is still waiting for invoice 3');
SELECT public.release_trade_pay_run_invoice(:'zz_run', :'inv3', :'approver', 'ZZTEST last one out') AS zz_last \gset
SELECT pg_temp.zz_assert((:'zz_last'::jsonb)->>'run_status' = 'pushed'
  AND (SELECT status FROM public.trade_pay_runs WHERE id = :'zz_run') = 'pushed',
  'releasing the last clean unpushed row moves the run to pushed: ' || :'zz_last'
  || (SELECT string_agg(invoice_id || ':' || verdict || ':' || coalesce(pushed_at::text, '-'), ', ') FROM public.trade_pay_run_invoices WHERE run_id = :'zz_run'));
\echo 'PASS: cl-payrun-escape a queried invoice keeps its status; releasing the last unpushed row lets the run finish.'

-- The rollback refuses while a release is recorded.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_recorded;
\ir ../../../rollbacks/20261118999901_trade_pay_run_release_down.sql
ROLLBACK TO SAVEPOINT zz_recorded;
SELECT :'LAST_ERROR_MESSAGE' AS recorded_down \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'recorded_down' LIKE '%a release is recorded%',
  'the rollback must refuse a recorded release: ' || :'recorded_down');
ROLLBACK;
\echo 'PASS: cl-payrun-escape rollback refuses while a release is recorded.'
