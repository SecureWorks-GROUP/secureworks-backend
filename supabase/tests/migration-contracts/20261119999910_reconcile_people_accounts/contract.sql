BEGIN;
SET LOCAL statement_timeout = '90s';

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', label; END IF;
END $$;

-- Seeded at creation only: a re-apply never puts back a row the owner removed.
DELETE FROM public.people_account_codes WHERE account_code = '475';
\ir ../../../migrations/20261119999910_reconcile_people_accounts.sql
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT array_agg(account_code ORDER BY account_code) FROM public.people_account_codes)
    = ARRAY['301','306'], 're-apply does not reseed a removed row');
END $$;
INSERT INTO public.people_account_codes (account_code, note) VALUES ('475', 'Admin (Internal Subcontractors)');
\ir ../../../migrations/20261119999910_reconcile_people_accounts.sql

DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT array_agg(account_code ORDER BY account_code) FROM public.people_account_codes)
    = ARRAY['301','306','475'], 'the set is 301, 306, 475');
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure)
    = '6cb7df0b5a2f7cd7d6ebcb4c2568e895', 'page body is this migration''s');
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_counts(uuid)'::regprocedure)
    = '1657ff4926ebae986c2cea784c20cdd4', 'counts body is this migration''s');
  PERFORM pg_temp.assert_ok(obj_description('public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure, 'pg_proc') LIKE 'Reconcile list (P2-03.6)%'
    AND obj_description('public.reconcile_list_counts(uuid)'::regprocedure, 'pg_proc') LIKE 'Reconcile list (P2-03.6)%',
    'comment prefix kept, so 20261118195200 still re-applies');
  PERFORM pg_temp.assert_ok(
    has_function_privilege('service_role', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.reconcile_list_counts(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.reconcile_list_counts(uuid)', 'EXECUTE'), 'function grants kept');
  PERFORM pg_temp.assert_ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.people_account_codes'::regclass)
    AND has_table_privilege('service_role', 'public.people_account_codes', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.people_account_codes', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.people_account_codes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.people_account_codes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
    'table: RLS on, service_role reads only, no browser role');
END $$;

-- A code with spaces or an empty code is refused.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.people_account_codes (account_code, note) VALUES (' 999', 'x');
    RAISE EXCEPTION 'ZZTEST a padded code was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.people_account_codes (account_code, note) VALUES ('', 'x');
    RAISE EXCEPTION 'ZZTEST an empty code was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Made-up rows, org a. Z475: a bill whose only line is a supplier line on 475.
-- ZMX: a supplier line on 300 beside one on '475 ' (stored with a space).
-- ZS: a plain bill on 300. ZC1 follows Z475 by document; ZC2 carries its own
-- line on 475; ZC3 follows ZS. Org b holds a 475 line on a document of ZS's id.
-- Every item was raised before the rule, as the two live ones were.
INSERT INTO public.job_cost_lines(id, org_id, kind, document_kind, document_id, line_key, lane, amount_ex, account_code,
  state, needs_reason, not_counted_reason, follows_line_id, follows_document_kind, follows_document_id, source_hash) VALUES
 ('d1000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','Z475','1','other',900,'475','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d1000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','ZMX','1','materials',100,'300','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d1000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','ZMX','2','other',300,'475 ','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d1000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','ZS','1','materials',50,'300','needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d1000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZC1','1','other',-30,'300','needs_person','new',NULL,NULL,'xero_bill','Z475','h'),
 ('d1000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZC2','unallocated','other',-40,'475','needs_person','credit_not_allocated',NULL,NULL,NULL,NULL,'h'),
 ('d1000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZC3','1','materials',-5,'300','needs_person','new',NULL,NULL,'xero_bill','ZS','h'),
 ('d1000000-0000-4000-8000-000000000008','b0000000-0000-4000-8000-00000000000b','supplier_bill','xero_bill','ZS','1','other',700,'475','needs_person','new',NULL,NULL,NULL,NULL,'h');
INSERT INTO public.reconcile_items(id, org_id, kind, subject_table, subject_id, reason, amount_ex,
  evidence_hash, raised_by, raised_at) VALUES
 ('c1000000-0000-4000-8000-0000000000f1','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:Z475','no_clue',900,'h1','ZZTEST','2026-11-01 00:00+00'),
 ('c1000000-0000-4000-8000-0000000000f2','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZMX','no_clue',400,'h2','ZZTEST','2026-11-01 00:00+00'),
 ('c1000000-0000-4000-8000-0000000000f3','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZS','no_clue',50,'h3','ZZTEST','2026-11-01 00:00+00'),
 ('c1000000-0000-4000-8000-0000000000f4','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZC1','no_clue',-30,'h4','ZZTEST','2026-11-01 00:00+00'),
 ('c1000000-0000-4000-8000-0000000000f5','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZC2','credit_not_allocated',-40,'h5','ZZTEST','2026-11-01 00:00+00'),
 ('c1000000-0000-4000-8000-0000000000f6','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZC3','no_clue',-5,'h6','ZZTEST','2026-11-01 00:00+00');

CREATE TEMP TABLE zz_before AS SELECT id, md5(t::text) AS row_hash FROM public.reconcile_items t;
GRANT SELECT ON zz_before TO service_role;

CREATE FUNCTION pg_temp.listed() RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(right(id::text, 2) ORDER BY right(id::text, 2)), '{}')
  FROM public.reconcile_list_page('a0000000-0000-4000-8000-00000000000a', ARRAY['bill','credit'], 100, NULL)
$$;
CREATE FUNCTION pg_temp.counted() RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(kind, open), '{}') FROM public.reconcile_list_counts('a0000000-0000-4000-8000-00000000000a')
$$;
GRANT EXECUTE ON FUNCTION pg_temp.listed(), pg_temp.counted() TO service_role;

SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = ARRAY['f3','f6'],
    'a 475 bill, a mixed bill with a padded 475 line, a credit that follows a 475 bill and a credit on 475 are hidden; org b''s 475 line is not org a''s: ' || pg_temp.listed()::text);
  PERFORM pg_temp.assert_ok(pg_temp.counted() = '{"bill":1,"credit":1}'::jsonb, 'counts leave out the same items: ' || pg_temp.counted()::text);
END $$;
RESET ROLE;

-- The owner's answer changes one row, no code: without 475 the four come back.
DELETE FROM public.people_account_codes WHERE account_code = '475';
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = ARRAY['f1','f2','f3','f4','f5','f6'], 'without 475 every item lists: ' || pg_temp.listed()::text);
  PERFORM pg_temp.assert_ok(pg_temp.counted() = '{"bill":3,"credit":3}'::jsonb, 'and counts: ' || pg_temp.counted()::text);
END $$;
RESET ROLE;
-- A new people account takes effect the same way: with 300 in and 475 out, every
-- document with a 300 line is hidden and the two 475-only documents list.
INSERT INTO public.people_account_codes (account_code, note) VALUES ('300', 'ZZTEST');
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = ARRAY['f1','f5'], 'with 300 only the 475-only bill and credit list: ' || pg_temp.listed()::text);
  PERFORM pg_temp.assert_ok(pg_temp.counted() = '{"bill":1,"credit":1}'::jsonb, 'counts with 300: ' || pg_temp.counted()::text);
END $$;
RESET ROLE;
-- Hidden, never closed: no item was written.
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(NOT EXISTS (
    SELECT FROM public.reconcile_items t FULL JOIN zz_before b USING (id)
    WHERE t.id IS NULL OR b.id IS NULL OR md5(t::text) IS DISTINCT FROM b.row_hash),
    'no item closed or changed');
END $$;

-- The cost-line twin reads the same set: a 475 line is an installer line in the
-- labour lane, 301 and 306 as before, and the set decides (300 is in it now).
DO $$
DECLARE d jsonb;
BEGIN
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)'::regprocedure)
    = '357e86405fe1820f9446e49b43dfd55b', 'twin body is this migration''s');
  PERFORM pg_temp.assert_ok((SELECT provolatile FROM pg_proc WHERE oid = 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)'::regprocedure) = 's'
    AND NOT has_function_privilege('service_role', 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)', 'EXECUTE'),
    'twin is STABLE and still owner only');
  INSERT INTO public.people_account_codes (account_code, note) VALUES ('475', 'Admin (Internal Subcontractors)');
  d := public.job_cost_lines_bill_document('00000000-0000-0000-0000-000000000001', jsonb_build_object(
    'invoice_type', 'ACCPAY', 'xero_invoice_id', 'ZZTEST-PA-1', 'status', 'AUTHORISED',
    'line_items', jsonb_build_array(
      jsonb_build_object('LineItemID', 'zz-a', 'AccountCode', ' 475', 'LineAmount', 90, 'TaxAmount', 0),
      jsonb_build_object('LineItemID', 'zz-b', 'AccountCode', '306', 'LineAmount', 10, 'TaxAmount', 0),
      jsonb_build_object('LineItemID', 'zz-c', 'AccountCode', '305', 'LineAmount', 5, 'TaxAmount', 0),
      jsonb_build_object('LineItemID', 'zz-d', 'AccountCode', '300', 'LineAmount', 5, 'TaxAmount', 0))), false);
  PERFORM pg_temp.assert_ok((SELECT array_agg((l->>'kind') || '/' || (l->>'lane') ORDER BY (l->>'line_no')::int)
      FROM jsonb_array_elements(d->'lines') l)
    = ARRAY['installer_bill/labour','installer_bill/labour','supplier_bill/materials','installer_bill/labour'],
    'twin lanes: ' || (d->'lines')::text);
  DELETE FROM public.people_account_codes;
  BEGIN
    PERFORM public.job_cost_lines_bill_document('00000000-0000-0000-0000-000000000001', '{"invoice_type":"ACCPAY"}', false);
    RAISE EXCEPTION 'ZZTEST the twin costed a bill with no people accounts';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'people_accounts_empty' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;
SELECT 'Reconcile people accounts contract passed' AS result;
