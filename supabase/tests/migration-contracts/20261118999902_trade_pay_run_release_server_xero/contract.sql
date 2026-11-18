-- cl-payrun-xero-lookup contract. Every value, id and word is made up (ZZTEST).
--
-- A run row with a lapsed push claim is released only on ops-api's own Xero
-- search (source ops_api_xero_lookup, bills_found 0, the pressing approver,
-- made in the last five minutes, after the lapse). A check from anywhere else,
-- or one that found a bill, releases nothing. The released row's words say it
-- went back to the office for review and a queried invoice stays queried.
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts on.
\ir ../../../migrations/20261118999902_trade_pay_run_release_server_xero.sql
\ir ../../../migrations/20261118999902_trade_pay_run_release_server_xero.sql

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
  WHERE oid = 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'::regprocedure) = '62293ef4dd638c21ab9a25c86669d9f4',
  'own body installed after two runs');
SELECT pg_temp.zz_assert(has_function_privilege('service_role', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE'),
  'service role only');
SELECT pg_temp.zz_assert((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1'),
  'switch stays off');

-- Rule 15: another body is never replaced by a re-apply or by the rollback.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.release_trade_pay_run_invoice(p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_reason text, p_xero_check jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../migrations/20261118999902_trade_pay_run_release_server_xero.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply_error \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.release_trade_pay_run_invoice(p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_reason text, p_xero_check jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118999902_trade_pay_run_release_server_xero_down.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_apply_error' LIKE '%Rule 15, another body is installed%',
  'a re-apply must refuse another body: ' || :'collide_apply_error');
SELECT pg_temp.zz_assert(:'collide_down_error' LIKE '%rollback: another body is installed%',
  'the rollback must refuse another body: ' || :'collide_down_error');
-- The rollback stands 20261118170500's body back up; a re-apply comes back.
SAVEPOINT zz_round;
\ir ../../../rollbacks/20261118999902_trade_pay_run_release_server_xero_down.sql
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'::regprocedure) = '152edcbbc1ddff5f29d91e8f8af71860',
  'the rollback restores the earlier body');
\ir ../../../migrations/20261118999902_trade_pay_run_release_server_xero.sql
RELEASE SAVEPOINT zz_round;
\echo 'PASS: cl-payrun-xero-lookup body, grants, switch off, Rule 15 guard and rollback round trip.'

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
  ('0a180000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'admin'),
  ('0a180000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'admin'),
  ('0a180000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'admin');
INSERT INTO public.users (id, org_id, role)
  SELECT ('0a180000-0000-4000-8000-0000000000' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001', 'crew'
  FROM generate_series(1, 2) n;
-- Two approvers (the presser and a second); 0...003 is no approver.
UPDATE public.trade_pay_settings SET inclusive_super_from = '2026-11-23',
  pay_run_approver_user_ids = ARRAY['0a180000-0000-4000-8000-000000000001'::uuid,
                                    '0a180000-0000-4000-8000-000000000002'::uuid] WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, type, status)
  SELECT ('0a180000-0000-4000-8000-0000000001' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    'ZZTEST-XL-' || n, 'fencing', 'accepted' FROM generate_series(1, 2) n;
INSERT INTO public.work_orders (id, org_id, job_id, kind, status, agreed_labour_ex)
  SELECT ('0a180000-0000-4000-8000-0000000002' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a180000-0000-4000-8000-0000000001' || (10 + n))::uuid, 'job', 'approved', 1000 FROM generate_series(1, 2) n;
INSERT INTO public.trade_invoices (id, org_id, user_id, invoice_number, week_start, status, invoice_kind,
    submitted_at, subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay, super_basis)
  SELECT ('0a180000-0000-4000-8000-0000000003' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a180000-0000-4000-8000-0000000000' || (10 + n))::uuid, 'ZZTEST-XL-INV-' || n, '2026-11-16',
    CASE WHEN n = 2 THEN 'queried' ELSE 'pending_ops_review' END, 'standard',
    '2026-11-20 01:00Z'::timestamptz + n * interval '1 minute', n * 112, n * 112, 0, n * 112, false, .12,
    n * 12, n * 100, 'inclusive_12_112_v1' FROM generate_series(1, 2) n;
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, job_work_order_id, line_type, line_total_ex, description)
  SELECT ('0a180000-0000-4000-8000-0000000003' || (10 + n))::uuid, ('0a180000-0000-4000-8000-0000000001' || (10 + n))::uuid,
    'ZZTEST-XL-' || n, ('0a180000-0000-4000-8000-0000000002' || (10 + n))::uuid, 'labour', n * 112, 'ZZTEST labour'
  FROM generate_series(1, 2) n;
SET LOCAL session_replication_role = origin;

SELECT coalesce(pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-000000000001', '2026-11-16', '0a180000-0000-4000-8000-000000000001',
  (SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_agg(jsonb_build_object(
    'invoice_id', i.id, 'verdict', 'clean', 'stops', '[]'::jsonb,
    'pays', i.net_pay, 'super_amount', i.super_amount) ORDER BY i.invoice_number))
   FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-XL-INV-%'))), '') AS zz_approve \gset
SELECT pg_temp.zz_assert(:'zz_approve' = '', 'the run must be approved: ' || :'zz_approve');
SELECT id AS zz_run FROM public.trade_pay_runs WHERE week_start = '2026-11-16' \gset
\set inv1 '0a180000-0000-4000-8000-000000000311'
\set inv2 '0a180000-0000-4000-8000-000000000312'
\set approver '0a180000-0000-4000-8000-000000000001'
\set approver2 '0a180000-0000-4000-8000-000000000002'
\set outsider '0a180000-0000-4000-8000-000000000003'
CREATE FUNCTION pg_temp.zz_release(p_inv uuid, p_actor uuid, p_check jsonb DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.zz_error(format('SELECT public.release_trade_pay_run_invoice(%L, %L, %L, %L, %L)',
    (SELECT id FROM public.trade_pay_runs WHERE week_start = '2026-11-16'), p_inv, p_actor,
    'ZZTEST the deduction changed', p_check))
$$;

-- A lapsed claim on invoice 1: claimed 30 minutes ago, so it lapsed 20 minutes ago.
SELECT public.claim_trade_pay_run_push(:'zz_run', :'inv1', :'approver') AS zz_claim \gset
UPDATE public.trade_pay_run_invoices SET push_claimed_at = clock_timestamp() - interval '30 minutes'
 WHERE run_id = :'zz_run' AND invoice_id = :'inv1';
-- What ops-api sends after its own search found no bill.
SELECT jsonb_build_object('in_xero', false, 'checked_by', :'approver', 'checked_at', clock_timestamp(),
    'source', 'ops_api_xero_lookup', 'searched_number', 'ZZTEST-XL-INV-1', 'bills_found', 0)::text AS zz_server \gset
CREATE TEMP TABLE zz_inv_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) AS h FROM public.trade_invoices i
  WHERE i.invoice_number LIKE 'ZZTEST-XL-INV-%';

SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver') LIKE '%pay_run_push_claim_lapsed%',
  'no check: refused');
-- The check as a request body used to carry it (1646): form only, no search.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver',
    jsonb_build_object('in_xero', false, 'checked_by', :'approver', 'checked_at', clock_timestamp()))
  LIKE '%pay_run_xero_check_not_server%', 'a check that is not the server''s search is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver',
    (:'zz_server'::jsonb) || '{"source": "request_body"}') LIKE '%pay_run_xero_check_not_server%'
  AND pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) - 'searched_number') LIKE '%pay_run_xero_check_not_server%'
  AND pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) || '{"searched_number": "  "}') LIKE '%pay_run_xero_check_not_server%'
  AND pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) - 'bills_found') LIKE '%pay_run_xero_check_not_server%',
  'a check with no server source, no searched number or no count is refused');
-- Found in Xero: by the count or by the flag, never released.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) || '{"bills_found": 1}')
    LIKE '%pay_run_xero_check_found_in_xero%'
  AND pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) || '{"in_xero": true}')
    LIKE '%pay_run_xero_check_found_in_xero%',
  'a search that found a bill is refused');
-- Unnamed, an outsider, or another approver than the one pressing.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) - 'checked_by')
    LIKE '%pay_run_xero_check_unnamed%', 'an unnamed check is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) || jsonb_build_object('checked_by', :'outsider'))
    LIKE '%pay_run_xero_check_not_approver%', 'a check by someone off the approver list is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver', (:'zz_server'::jsonb) || jsonb_build_object('checked_by', :'approver2'))
    LIKE '%pay_run_xero_check_not_server%', 'a check by another approver than the one pressing is refused');
-- Stale: before the lapse. Old: after the lapse but not made at this press.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver',
    (:'zz_server'::jsonb) || jsonb_build_object('checked_at', clock_timestamp() - interval '25 minutes'))
    LIKE '%pay_run_xero_check_stale%', 'a check from before the lapse is refused');
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver',
    (:'zz_server'::jsonb) || jsonb_build_object('checked_at', clock_timestamp() - interval '10 minutes'))
    LIKE '%pay_run_xero_check_not_server%', 'a check older than five minutes is refused');
SELECT pg_temp.zz_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id)::text, '')) FROM public.trade_invoices i
  WHERE i.invoice_number LIKE 'ZZTEST-XL-INV-%') = (SELECT h FROM zz_inv_before), 'a refusal changed an invoice');
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.trade_pay_run_invoices WHERE run_id = :'zz_run' AND released_at IS NOT NULL),
  'a refusal recorded a release');
\echo 'PASS: cl-payrun-xero-lookup refusals: no check, not the server''s search, found in Xero, unnamed, outsider, another approver, stale, older than five minutes; nothing written.'

-- The pass: the server's search, made now, found nothing.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv1', :'approver', :'zz_server'::jsonb) IS NULL, 'the release');
SELECT pg_temp.zz_assert((SELECT i.status = 'pending_ops_review' AND i.pay_run_id IS NULL
    FROM public.trade_invoices i WHERE i.id = :'inv1'), 'back to review');
SELECT pg_temp.zz_assert((SELECT r.release_xero_check->>'source' = 'ops_api_xero_lookup'
    AND r.release_xero_check->>'searched_number' = 'ZZTEST-XL-INV-1'
    AND r.release_xero_check->'bills_found' = '0'::jsonb
    AND r.release_xero_check->'in_xero' = 'false'::jsonb
    AND (r.release_xero_check->>'checked_by')::uuid = :'approver'::uuid
    AND r.push_claimed_at IS NULL
    AND r.stops @> '[{"code":"released_from_run","status_at_release":"pending_ops_review","xero_check":{"source":"ops_api_xero_lookup","bills_found":0}}]'
    FROM public.trade_pay_run_invoices r WHERE r.run_id = :'zz_run' AND r.invoice_id = :'inv1'),
  'what the search found is kept on the run row');
\echo 'PASS: cl-payrun-xero-lookup release on the server''s search, with what it searched and found kept.'

-- (b) A queried invoice released from the run: no claim, so no search; it
-- stays queried, and its row says it went back to the office for review.
SELECT pg_temp.zz_assert(pg_temp.zz_release(:'inv2', :'approver') IS NULL, 'the queried release');
SELECT pg_temp.zz_assert((SELECT i.status = 'queried' AND i.pay_run_id IS NULL FROM public.trade_invoices i WHERE i.id = :'inv2'),
  'a queried invoice stays queried');
SELECT pg_temp.zz_assert((SELECT r.release_xero_check IS NULL
    AND r.stops @> '[{"code":"released_from_run","status_at_release":"queried"}]'
    AND r.stops::text LIKE '%went back to the office for review (a queried invoice stays queried)%'
    FROM public.trade_pay_run_invoices r WHERE r.run_id = :'zz_run' AND r.invoice_id = :'inv2'),
  'the queried row says it went back to review and stays queried');
\echo 'PASS: cl-payrun-xero-lookup a queried invoice released from the run goes back to review, still queried.'
ROLLBACK;
