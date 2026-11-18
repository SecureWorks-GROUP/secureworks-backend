-- cl-payrun-xero-found contract. Every value, id and word is made up (ZZTEST).
--
-- A Xero bill ops-api found at a release press is kept on the run row: who
-- searched, when, the number searched, the bills (id, number, status) and
-- the result. Only for a row the release would have searched for (lapsed
-- claim, not pushed, not released), only the pressing approver's search made
-- at this press. Nothing is released and the invoice is never touched.
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts on.
\ir ../../../migrations/20261118194200_trade_pay_run_xero_found.sql
\ir ../../../migrations/20261118194200_trade_pay_run_xero_found.sql

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
  WHERE oid = 'public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)'::regprocedure) = '2c21adbf78f1aeeb2dd329e5c1beea71',
  'own body installed after two runs');
SELECT pg_temp.zz_assert(has_function_privilege('service_role', 'public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)', 'EXECUTE'),
  'service role only');
SELECT pg_temp.zz_assert((SELECT format_type(atttypid, atttypmod) = 'jsonb' AND NOT attnotnull AND NOT atthasdef
    FROM pg_attribute WHERE attrelid = 'public.trade_pay_run_invoices'::regclass AND attname = 'release_xero_found'),
  'a nullable jsonb column with no default');
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'::regprocedure) = '62293ef4dd638c21ab9a25c86669d9f4',
  'the release is untouched');
SELECT pg_temp.zz_assert((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1'),
  'switch stays off');

-- Rule 15: another body is never replaced by a re-apply or dropped by the rollback.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.record_trade_pay_run_xero_found(p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_found jsonb)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../migrations/20261118194200_trade_pay_run_xero_found.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply_error \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.record_trade_pay_run_xero_found(p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_found jsonb)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118194200_trade_pay_run_xero_found_down.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_apply_error' LIKE '%Rule 15, another body is installed%',
  'a re-apply must refuse another body: ' || :'collide_apply_error');
SELECT pg_temp.zz_assert(:'collide_down_error' LIKE '%rollback: another body is installed%',
  'the rollback must refuse another body: ' || :'collide_down_error');
-- Round trip: down, then up again.
SAVEPOINT zz_round;
\ir ../../../rollbacks/20261118194200_trade_pay_run_xero_found_down.sql
SELECT pg_temp.zz_assert(to_regprocedure('public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)') IS NULL,
  'the rollback drops the function');
\ir ../../../migrations/20261118194200_trade_pay_run_xero_found.sql
RELEASE SAVEPOINT zz_round;
\echo 'PASS: cl-payrun-xero-found column, body, grants, release untouched, switch off, Rule 15 guard and rollback round trip.'

-- Fixtures: two crew invoices for one week (one pending_ops_review, one
-- queried), written with user triggers off; every trigger is back on after.
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
  ('0a190000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'admin'),
  ('0a190000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'admin'),
  ('0a190000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'admin');
INSERT INTO public.users (id, org_id, role)
  SELECT ('0a190000-0000-4000-8000-0000000000' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001', 'crew'
  FROM generate_series(1, 2) n;
-- Two approvers (the presser and a second); 0...003 is no approver.
UPDATE public.trade_pay_settings SET inclusive_super_from = '2026-11-23',
  pay_run_approver_user_ids = ARRAY['0a190000-0000-4000-8000-000000000001'::uuid,
                                    '0a190000-0000-4000-8000-000000000002'::uuid] WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, type, status)
  SELECT ('0a190000-0000-4000-8000-0000000001' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    'ZZTEST-XF-' || n, 'fencing', 'accepted' FROM generate_series(1, 2) n;
INSERT INTO public.work_orders (id, org_id, job_id, kind, status, agreed_labour_ex)
  SELECT ('0a190000-0000-4000-8000-0000000002' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a190000-0000-4000-8000-0000000001' || (10 + n))::uuid, 'job', 'approved', 1000 FROM generate_series(1, 2) n;
INSERT INTO public.trade_invoices (id, org_id, user_id, invoice_number, week_start, status, invoice_kind,
    submitted_at, subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay, super_basis)
  SELECT ('0a190000-0000-4000-8000-0000000003' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a190000-0000-4000-8000-0000000000' || (10 + n))::uuid, 'ZZTEST-XF-INV-' || n, '2026-11-16',
    CASE WHEN n = 2 THEN 'queried' ELSE 'pending_ops_review' END, 'standard',
    '2026-11-20 01:00Z'::timestamptz + n * interval '1 minute', n * 112, n * 112, 0, n * 112, false, .12,
    n * 12, n * 100, 'inclusive_12_112_v1' FROM generate_series(1, 2) n;
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, job_work_order_id, line_type, line_total_ex, description)
  SELECT ('0a190000-0000-4000-8000-0000000003' || (10 + n))::uuid, ('0a190000-0000-4000-8000-0000000001' || (10 + n))::uuid,
    'ZZTEST-XF-' || n, ('0a190000-0000-4000-8000-0000000002' || (10 + n))::uuid, 'labour', n * 112, 'ZZTEST labour'
  FROM generate_series(1, 2) n;
SET LOCAL session_replication_role = origin;

SELECT coalesce(pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-000000000001', '2026-11-16', '0a190000-0000-4000-8000-000000000001',
  (SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_agg(jsonb_build_object(
    'invoice_id', i.id, 'verdict', 'clean', 'stops', '[]'::jsonb,
    'pays', i.net_pay, 'super_amount', i.super_amount) ORDER BY i.invoice_number))
   FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-XF-INV-%'))), '') AS zz_approve \gset
SELECT pg_temp.zz_assert(:'zz_approve' = '', 'the run must be approved: ' || :'zz_approve');
SELECT id AS zz_run FROM public.trade_pay_runs WHERE week_start = '2026-11-16' \gset
\set inv1 '0a190000-0000-4000-8000-000000000311'
\set inv2 '0a190000-0000-4000-8000-000000000312'
\set approver '0a190000-0000-4000-8000-000000000001'
\set approver2 '0a190000-0000-4000-8000-000000000002'
\set outsider '0a190000-0000-4000-8000-000000000003'
\set approver '0a190000-0000-4000-8000-000000000001'
\set approver2 '0a190000-0000-4000-8000-000000000002'
\set outsider '0a190000-0000-4000-8000-000000000003'
\set inv1 '0a190000-0000-4000-8000-000000000311'
\set inv2 '0a190000-0000-4000-8000-000000000312'
CREATE FUNCTION pg_temp.zz_found(p_inv uuid, p_actor uuid, p_found jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.zz_error(format('SELECT public.record_trade_pay_run_xero_found(%L, %L, %L, %L)',
    (SELECT id FROM public.trade_pay_runs WHERE week_start = '2026-11-16'), p_inv, p_actor, p_found))
$$;
SELECT jsonb_build_object('checked_by', :'approver', 'checked_at', clock_timestamp(),
    'source', 'ops_api_xero_lookup', 'searched_number', 'ZZTEST-XF-INV-1', 'bills_found', 1,
    'bills', jsonb_build_array(jsonb_build_object('xero_bill_id', 'ZZTEST-XERO-BILL-1', 'number', 'ZZTEST-XF-INV-1',
      'status', 'draft', 'Reference', 'ZZTEST a trade name', 'Total', 112)))::text AS zz_good \gset

-- Invoice 1 has no claim yet; invoice 2 a live claim. Neither is a row the
-- release searches for.
SELECT public.claim_trade_pay_run_push(:'zz_run', :'inv2', :'approver') AS zz_claim2 \gset
SELECT pg_temp.zz_assert(pg_temp.zz_found(:'inv1', :'approver', :'zz_good'::jsonb) LIKE '%pay_run_xero_found_not_lapsed%'
  AND pg_temp.zz_found(:'inv2', :'approver', :'zz_good'::jsonb) LIKE '%pay_run_xero_found_not_lapsed%',
  'no claim or a live claim: refused');
-- Invoice 1: a claim that lapsed 20 minutes ago.
SELECT public.claim_trade_pay_run_push(:'zz_run', :'inv1', :'approver') AS zz_claim \gset
UPDATE public.trade_pay_run_invoices SET push_claimed_at = clock_timestamp() - interval '30 minutes'
 WHERE run_id = :'zz_run' AND invoice_id = :'inv1';
CREATE TEMP TABLE zz_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) AS inv,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(r) - 'release_xero_found' ORDER BY r.invoice_id)::text, ''))
       FROM public.trade_pay_run_invoices r WHERE r.run_id = :'zz_run') AS rows
  FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-XF-INV-%';

SELECT pg_temp.zz_assert(pg_temp.zz_found(:'inv1', :'outsider', :'zz_good'::jsonb) LIKE '%pay_run_not_approver%',
  'someone off the approver list is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_found(:'inv1', :'approver2', :'zz_good'::jsonb) LIKE '%pay_run_xero_found_invalid%',
  'another approver than the one who searched is refused');
SELECT pg_temp.zz_assert(
  pg_temp.zz_found(:'inv1', :'approver', NULL) LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) || '{"source": "request_body"}') LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) - 'searched_number') LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) || '{"bills": [], "bills_found": 0}') LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) || '{"bills_found": 2}') LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) || '{"bills": [{"number": "ZZTEST"}]}') LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) || '{"checked_at": "not a time"}') LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) || jsonb_build_object('checked_at', clock_timestamp() - interval '10 minutes')) LIKE '%pay_run_xero_found_invalid%'
  AND pg_temp.zz_found(:'inv1', :'approver', (:'zz_good'::jsonb) || jsonb_build_object('checked_at', clock_timestamp() - interval '25 minutes')) LIKE '%pay_run_xero_found_invalid%',
  'no search, not the server''s, no number, no bill, a wrong count, a bill with no id, a bad, old or pre-lapse time: refused');
SELECT pg_temp.zz_assert((SELECT inv FROM zz_before) = (SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, ''))
    FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-XF-INV-%')
  AND NOT EXISTS (SELECT 1 FROM public.trade_pay_run_invoices WHERE run_id = :'zz_run' AND release_xero_found IS NOT NULL),
  'a refusal wrote nothing');
\echo 'PASS: cl-payrun-xero-found refusals: no lapsed claim, outsider, another approver, not the server''s search, bad bills, bad or old time; nothing written.'

-- The record: who, when, the number, the bills (id, number, status only), the result.
SELECT pg_temp.zz_assert(pg_temp.zz_found(:'inv1', :'approver', :'zz_good'::jsonb) IS NULL, 'the record');
SELECT pg_temp.zz_assert((SELECT r.release_xero_found->>'result' = 'found_in_xero'
    AND (r.release_xero_found->>'checked_by')::uuid = :'approver'::uuid
    AND r.release_xero_found->>'checked_at' IS NOT NULL
    AND r.release_xero_found->>'source' = 'ops_api_xero_lookup'
    AND r.release_xero_found->>'searched_number' = 'ZZTEST-XF-INV-1'
    AND r.release_xero_found->'bills_found' = '1'::jsonb
    AND r.release_xero_found->'bills' = '[{"xero_bill_id":"ZZTEST-XERO-BILL-1","number":"ZZTEST-XF-INV-1","status":"DRAFT"}]'::jsonb
    FROM public.trade_pay_run_invoices r WHERE r.run_id = :'zz_run' AND r.invoice_id = :'inv1'),
  'the found bill is kept, with no reference or amount');
SELECT pg_temp.zz_assert((SELECT inv FROM zz_before) = (SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, ''))
    FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-XF-INV-%')
  AND (SELECT rows FROM zz_before) = (SELECT md5(coalesce(jsonb_agg(to_jsonb(r) - 'release_xero_found' ORDER BY r.invoice_id)::text, ''))
    FROM public.trade_pay_run_invoices r WHERE r.run_id = :'zz_run'),
  'the record changes no invoice and nothing else on the run rows: not released');
-- A newer search replaces it.
SELECT pg_temp.zz_assert(pg_temp.zz_found(:'inv1', :'approver2', (:'zz_good'::jsonb) || jsonb_build_object('checked_by', :'approver2',
    'bills_found', 2, 'bills', '[{"xero_bill_id":"ZZTEST-XERO-BILL-1"},{"xero_bill_id":"ZZTEST-XERO-BILL-2","status":"paid"}]'::jsonb)) IS NULL,
  'a second search');
SELECT pg_temp.zz_assert((SELECT (r.release_xero_found->>'checked_by')::uuid = :'approver2'::uuid
    AND r.release_xero_found->'bills_found' = '2'::jsonb
    AND r.release_xero_found->'bills'->1 = '{"xero_bill_id":"ZZTEST-XERO-BILL-2","number":null,"status":"PAID"}'::jsonb
    FROM public.trade_pay_run_invoices r WHERE r.run_id = :'zz_run' AND r.invoice_id = :'inv1'),
  'the newest search replaces the earlier one');
-- The release still refuses that row while Xero has a bill.
SELECT pg_temp.zz_assert(pg_temp.zz_error(format('SELECT public.release_trade_pay_run_invoice(%L, %L, %L, %L, %L)',
    :'zz_run', :'inv1', :'approver', 'ZZTEST the deduction changed',
    jsonb_build_object('in_xero', true, 'checked_by', :'approver', 'checked_at', clock_timestamp(),
      'source', 'ops_api_xero_lookup', 'searched_number', 'ZZTEST-XF-INV-1', 'bills_found', 1)))
  LIKE '%pay_run_xero_check_found_in_xero%', 'the release still refuses a found bill');
-- The rollback keeps a record: it refuses while one is held.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_keep;
\ir ../../../rollbacks/20261118194200_trade_pay_run_xero_found_down.sql
ROLLBACK TO SAVEPOINT zz_keep;
SELECT :'LAST_ERROR_MESSAGE' AS keep_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'keep_error' LIKE '%a run row holds a found Xero bill%',
  'the rollback must refuse while a record is held: ' || :'keep_error');
\echo 'PASS: cl-payrun-xero-found the found bill is kept on the run row (who, when, number, bills, result), the newest replaces it, nothing is released, and the rollback keeps it.'
ROLLBACK;
