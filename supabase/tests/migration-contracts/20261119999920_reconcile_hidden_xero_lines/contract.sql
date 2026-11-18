BEGIN;
SET LOCAL statement_timeout = '90s';

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', label; END IF;
END $$;
CREATE FUNCTION pg_temp.md5_of(sig text) RETURNS text LANGUAGE sql AS $$
  SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(sig)
$$;

-- Applies twice: the guard accepts this migration's own bodies.
\ir ../../../migrations/20261119999920_reconcile_hidden_xero_lines.sql
\ir ../../../migrations/20261119999920_reconcile_hidden_xero_lines.sql
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.md5_of('public.reconcile_list_page(uuid,text[],integer,jsonb)') = '8ed89b415795afccc6125069d17fc8d4'
    AND pg_temp.md5_of('public.reconcile_list_counts(uuid)') = 'f2f7862006108b3134140ee7fb1cf872'
    AND pg_temp.md5_of('public.reconcile_item_xero_hidden(uuid,text,text)') = '8a3f20c59289e3692815728b2baeb1fa',
    'own bodies after a re-apply');
  PERFORM pg_temp.assert_ok(obj_description('public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure, 'pg_proc') LIKE 'Reconcile list (P2-03.6)%'
    AND obj_description('public.reconcile_list_counts(uuid)'::regprocedure, 'pg_proc') LIKE 'Reconcile list (P2-03.6)%',
    'comment prefix kept, so 20261118195200 still re-applies');
  PERFORM pg_temp.assert_ok(
    has_function_privilege('service_role', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.reconcile_list_counts(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.reconcile_list_counts(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.reconcile_item_xero_hidden(uuid,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.reconcile_item_xero_hidden(uuid,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.reconcile_item_xero_hidden(uuid,text,text)', 'EXECUTE'),
    'list grants kept; the helper is called only by the list functions');
  PERFORM pg_temp.assert_ok((SELECT proconfig IS NULL AND NOT prosecdef AND provolatile = 's' FROM pg_proc
    WHERE oid = 'public.reconcile_item_xero_hidden(uuid,text,text)'::regprocedure), 'helper: stable, invoker, no SET clause');
END $$;

-- Made-up rows, org a. Every bill's and credit's cost lines are on 485 (not
-- hidden); only Xero's own records differ. XB1: Xero has a zero line on 475.
-- XB2: Xero on 485 only. XB3: Xero has a zero line on ' 475 ' (padded). XB4: no
-- Xero lines read. XB5: Xero has a zero line on 306. XC1: its own Xero record
-- has a line on 475. XC2 follows XB3 by document, on a line not counted.
-- XC3 follows XB3 on a removed line. XC4 follows XB2. XC5 follows XB3's line.
-- Org b holds a Xero bill XB2 with a 475 line, which is not org a's.
INSERT INTO public.job_cost_lines(id, org_id, kind, document_kind, document_id, line_key, lane, amount_ex, account_code,
  state, needs_reason, not_counted_reason, follows_line_id, follows_document_kind, follows_document_id, source_hash) VALUES
 ('d9300000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','XB1','1','materials',100,'485','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d9300000-0000-4000-8000-000000000002','a9300000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','XB2','1','materials',100,'485','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d9300000-0000-4000-8000-000000000003','a9300000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','XB3','1','materials',100,'485','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d9300000-0000-4000-8000-000000000004','a9300000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','XB4','1','materials',100,'485','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d9300000-0000-4000-8000-000000000005','a9300000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','XB5','1','materials',100,'485','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d9300000-0000-4000-8000-000000000006','a9300000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','XC1','unallocated','materials',-10,NULL,'needs_person','credit_not_allocated',NULL,NULL,NULL,NULL,'h'),
 ('d9300000-0000-4000-8000-000000000007','a9300000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','XC2','unallocated','materials',-10,NULL,'needs_person','credit_not_allocated',NULL,NULL,NULL,NULL,'h'),
 ('d9300000-0000-4000-8000-000000000008','a9300000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','XC2','alloc:1','materials',-5,NULL,NULL,NULL,'duplicate_document',NULL,'xero_bill','XB3','h'),
 ('d9300000-0000-4000-8000-000000000009','a9300000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','XC3','alloc:1','materials',-5,NULL,NULL,NULL,'line_removed',NULL,'xero_bill','XB3','h'),
 ('d9300000-0000-4000-8000-000000000010','a9300000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','XC4','alloc:1','materials',-5,NULL,'needs_person','new',NULL,NULL,'xero_bill','XB2','h'),
 ('d9300000-0000-4000-8000-000000000011','a9300000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','XC5','1','materials',-5,NULL,'needs_person','new',NULL,'d9300000-0000-4000-8000-000000000003',NULL,NULL,'h');
-- Xero's own records (made up). The organisation rows these reference do not
-- exist here: insert without firing foreign-key triggers.
SET LOCAL session_replication_role = replica;
INSERT INTO public.xero_invoices(org_id, xero_invoice_id, invoice_type, line_items) VALUES
 ('a9300000-0000-4000-8000-00000000000a', 'XB1', 'ACCPAY', '[{"AccountCode":"485","LineAmount":100},{"AccountCode":"475","LineAmount":0}]'),
 ('a9300000-0000-4000-8000-00000000000a', 'XB2', 'ACCPAY', '[{"AccountCode":"485","LineAmount":100}]'),
 ('a9300000-0000-4000-8000-00000000000a', 'XB3', 'ACCPAY', '[{"AccountCode":"485","LineAmount":100},{"AccountCode":" 475 ","LineAmount":0}]'),
 ('a9300000-0000-4000-8000-00000000000a', 'XB4', 'ACCPAY', NULL),
 ('a9300000-0000-4000-8000-00000000000a', 'XB5', 'ACCPAY', '[{"AccountCode":"485","LineAmount":100},{"AccountCode":"306","LineAmount":0}]'),
 ('b9300000-0000-4000-8000-00000000000b', 'XB2', 'ACCPAY', '[{"AccountCode":"475","LineAmount":0}]');
INSERT INTO public.xero_supplier_credit_notes(org_id, xero_credit_note_id, credit_note_type, allocations_returned, raw_json) VALUES
 ('a9300000-0000-4000-8000-00000000000a', 'XC1', 'ACCPAYCREDIT', true, '{"LineItems":[{"AccountCode":"485","LineAmount":10},{"AccountCode":"475","LineAmount":0}]}'),
 ('a9300000-0000-4000-8000-00000000000a', 'XC2', 'ACCPAYCREDIT', true, '{"LineItems":[{"AccountCode":"485","LineAmount":15}]}'),
 ('a9300000-0000-4000-8000-00000000000a', 'XC3', 'ACCPAYCREDIT', true, '{"LineItems":[{"AccountCode":"485","LineAmount":5}]}'),
 ('a9300000-0000-4000-8000-00000000000a', 'XC4', 'ACCPAYCREDIT', true, '{"LineItems":"not a list"}');
SET LOCAL session_replication_role = origin;
INSERT INTO public.reconcile_items(id, org_id, kind, subject_table, subject_id, reason, amount_ex,
  evidence_hash, raised_by, raised_at)
SELECT ('c9300000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'a9300000-0000-4000-8000-00000000000a',
  CASE WHEN s LIKE 'xero_bill:%' THEN 'bill' ELSE 'credit' END, 'cost_document', s, 'no_clue', 100 - n,
  'h' || n, 'ZZTEST', '2026-11-01 00:00+00'
FROM unnest(ARRAY['xero_bill:XB1','xero_bill:XB2','xero_bill:XB3','xero_bill:XB4','xero_bill:XB5',
  'xero_credit_note:XC1','xero_credit_note:XC2','xero_credit_note:XC3','xero_credit_note:XC4','xero_credit_note:XC5'])
  WITH ORDINALITY u(s, n);

CREATE TEMP TABLE zz_before AS SELECT id, md5(t::text) AS row_hash FROM public.reconcile_items t;
CREATE FUNCTION pg_temp.listed() RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(subject_id ORDER BY subject_id), '{}')
  FROM public.reconcile_list_page('a9300000-0000-4000-8000-00000000000a', ARRAY['bill','credit'], 100, NULL)
$$;
CREATE FUNCTION pg_temp.counted() RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(kind, open), '{}') FROM public.reconcile_list_counts('a9300000-0000-4000-8000-00000000000a')
$$;
GRANT EXECUTE ON FUNCTION pg_temp.listed(), pg_temp.counted() TO service_role;
GRANT SELECT ON zz_before TO service_role;

-- Before: 20261118195700's bodies read our cost lines only, so all ten list.
\ir ../../../rollbacks/20261119999920_reconcile_hidden_xero_lines_down.sql
CREATE TEMP TABLE zz_old AS SELECT pg_temp.listed() AS listed, pg_temp.counted() AS counted;
GRANT SELECT ON zz_old TO service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT cardinality(listed) FROM zz_old) = 10, 'before: every item listed: ' || (SELECT listed::text FROM zz_old));
  PERFORM pg_temp.assert_ok(to_regprocedure('public.reconcile_item_xero_hidden(uuid,text,text)') IS NULL, 'rollback drops the helper');
END $$;
\ir ../../../migrations/20261119999920_reconcile_hidden_xero_lines.sql

SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = ARRAY['xero_bill:XB2','xero_bill:XB4','xero_credit_note:XC3','xero_credit_note:XC4'],
    'hidden: a zero Xero line on 475 (padded too) or 306, a credit''s own Xero line on 475, and a credit following such a bill by document or by line; org b''s Xero bill is not org a''s: '
    || pg_temp.listed()::text);
  PERFORM pg_temp.assert_ok(pg_temp.counted() = '{"bill":2,"credit":2}'::jsonb, 'counts leave out the same items: ' || pg_temp.counted()::text);
  -- MUST NOT CHANGE: every item still listed is listed exactly as before, and
  -- nothing left out was on no hidden account.
  PERFORM pg_temp.assert_ok(pg_temp.listed() <@ (SELECT listed FROM zz_old), 'nothing new listed');
  PERFORM pg_temp.assert_ok(NOT EXISTS (SELECT FROM public.reconcile_items t JOIN zz_before b ON b.id = t.id
    WHERE md5(t::text) <> b.row_hash), 'no item closed or written');
END $$;
RESET ROLE;

-- The hidden flag is data: 475 un-hidden brings back every item it hid; 306
-- (labour) stays hidden.
UPDATE public.people_account_codes SET hidden_from_reconcile = false WHERE account_code = '475';
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = ARRAY['xero_bill:XB1','xero_bill:XB2','xero_bill:XB3','xero_bill:XB4',
    'xero_credit_note:XC1','xero_credit_note:XC2','xero_credit_note:XC3','xero_credit_note:XC4','xero_credit_note:XC5'],
    '475 not hidden: only the 306 bill stays out: ' || pg_temp.listed()::text);
END $$;
UPDATE public.people_account_codes SET hidden_from_reconcile = true WHERE account_code = '475';

-- Rollback, re-run of the rollback, apply again.
\ir ../../../rollbacks/20261119999920_reconcile_hidden_xero_lines_down.sql
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.md5_of('public.reconcile_list_page(uuid,text[],integer,jsonb)') = '21429cddb4dcbda92d5f36083fdf453a'
    AND pg_temp.md5_of('public.reconcile_list_counts(uuid)') = '40f09ca674d5313c3500100114400280'
    AND obj_description('public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure, 'pg_proc')
      NOT LIKE '%Xero''s own record%', 'rollback returns 20261118195700''s bodies and comment');
END $$;
\ir ../../../rollbacks/20261119999920_reconcile_hidden_xero_lines_down.sql
\ir ../../../migrations/20261119999920_reconcile_hidden_xero_lines.sql
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.md5_of('public.reconcile_list_page(uuid,text[],integer,jsonb)') = '8ed89b415795afccc6125069d17fc8d4'
    AND has_function_privilege('service_role', 'public.reconcile_list_counts(uuid)', 'EXECUTE'), 'apply again after a rollback');
END $$;

SELECT 'PASS reconcile hidden Xero lines: a zero line on a hidden account on Xero''s own record, or on a bill a credit follows, is left out of the list and counts; everything else listed as before; no item written; the flag is data; rollback, re-run and re-apply hold' AS result;
ROLLBACK;
