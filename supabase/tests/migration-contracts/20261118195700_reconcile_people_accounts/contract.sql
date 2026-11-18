BEGIN;
SET LOCAL statement_timeout = '90s';

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', label; END IF;
END $$;

-- Seeded at creation only: a re-apply never puts back a row the owner removed.
DELETE FROM public.people_account_codes WHERE account_code = '475';
\ir ../../../migrations/20261118195700_reconcile_people_accounts.sql
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT array_agg(account_code ORDER BY account_code) FROM public.people_account_codes)
    = ARRAY['301','306'], 're-apply does not reseed a removed row');
END $$;
INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES ('475', false, true, 'Admin (Internal Subcontractors)');
\ir ../../../migrations/20261118195700_reconcile_people_accounts.sql

DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT array_agg(account_code || ':' || labour || ':' || hidden_from_reconcile ORDER BY account_code) FROM public.people_account_codes)
    = ARRAY['301:true:true','306:true:true','475:false:true'], 'labour 301 and 306; hidden 301, 306 and 475');
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure)
    = '21429cddb4dcbda92d5f36083fdf453a', 'page body is this migration''s');
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_counts(uuid)'::regprocedure)
    = '40f09ca674d5313c3500100114400280', 'counts body is this migration''s');
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

-- A code with spaces or an empty code is refused; a labour account is always hidden; no flag is null.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES ('998', true, false, 'x');
    RAISE EXCEPTION 'ZZTEST a labour account not hidden was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES ('997', NULL, true, 'x');
    RAISE EXCEPTION 'ZZTEST a null flag was stored';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES (' 999', false, true, 'x');
    RAISE EXCEPTION 'ZZTEST a padded code was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES ('', false, true, 'x');
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

-- The labour hold (director 03:57): labour is exactly 301 and 306. Another code
-- made labour, 301 or 306 made not labour, removed or renamed, or the table
-- emptied: each is refused.
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(EXISTS (SELECT FROM pg_constraint WHERE conrelid = 'public.people_account_codes'::regclass
      AND conname = 'people_account_codes_labour_is_301_306')
    AND EXISTS (SELECT FROM pg_trigger WHERE tgrelid = 'public.people_account_codes'::regclass
      AND tgname = 'people_account_codes_labour_exact' AND NOT tgisinternal)
    AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.people_account_codes_labour_exact()'::regprocedure) = '4bfc2a86430bb41e17769a71cc91d591'
    AND NOT has_function_privilege('service_role', 'public.people_account_codes_labour_exact()', 'EXECUTE'),
    'labour hold: CHECK, trigger and its own function body');
  BEGIN
    UPDATE public.people_account_codes SET labour = true WHERE account_code = '475';
    RAISE EXCEPTION 'ZZTEST 475 was made labour';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES ('300', true, true, 'x');
    RAISE EXCEPTION 'ZZTEST a new labour code was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.people_account_codes SET labour = false WHERE account_code = '301';
    RAISE EXCEPTION 'ZZTEST 301 was made not labour';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.people_account_codes SET account_code = '302' WHERE account_code = '306';
    RAISE EXCEPTION 'ZZTEST 306 was renamed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.people_account_codes WHERE account_code = '306';
    RAISE EXCEPTION 'ZZTEST 306 was removed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'people_account_codes_labour_fixed' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE public.people_account_codes;
    RAISE EXCEPTION 'ZZTEST the table was emptied';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'people_account_codes_labour_fixed' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.assert_ok((SELECT array_agg(account_code || ':' || labour || ':' || hidden_from_reconcile ORDER BY account_code) FROM public.people_account_codes)
    = ARRAY['301:true:true','306:true:true','475:false:true'], 'nothing changed by the refused writes');
END $$;

-- The owner's answer changes one flag, no code: 475 not hidden and the four come back.
UPDATE public.people_account_codes SET hidden_from_reconcile = false WHERE account_code = '475';
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = ARRAY['f1','f2','f3','f4','f5','f6'], 'without 475 every item lists: ' || pg_temp.listed()::text);
  PERFORM pg_temp.assert_ok(pg_temp.counted() = '{"bill":3,"credit":3}'::jsonb, 'and counts: ' || pg_temp.counted()::text);
END $$;
RESET ROLE;
-- A new people account takes effect the same way: with 300 in and 475 out, every
-- document with a 300 line is hidden and the two 475-only documents list.
INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES ('300', false, true, 'ZZTEST');
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = ARRAY['f1','f5'], 'with 300 only the 475-only bill and credit list: ' || pg_temp.listed()::text);
  PERFORM pg_temp.assert_ok(pg_temp.counted() = '{"bill":1,"credit":1}'::jsonb, 'counts with 300: ' || pg_temp.counted()::text);
END $$;
RESET ROLE;
-- Fail closed (director 03:57): with no hidden row at all (reachable only past
-- the labour hold, so the hold is lifted here inside this rolled-back test), a
-- page lists nothing and counts give no kind, as the edge reader refuses.
ALTER TABLE public.people_account_codes DISABLE TRIGGER people_account_codes_labour_exact;
DELETE FROM public.people_account_codes;
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = '{}'::text[], 'no hidden row: nothing listed: ' || pg_temp.listed()::text);
  PERFORM pg_temp.assert_ok(pg_temp.counted() = '{}'::jsonb, 'no hidden row: no count: ' || pg_temp.counted()::text);
END $$;
RESET ROLE;
-- Rows present but none hidden: the same.
INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES ('475', false, false, 'ZZTEST');
SET LOCAL ROLE service_role;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(pg_temp.listed() = '{}'::text[] AND pg_temp.counted() = '{}'::jsonb, 'rows but none hidden: nothing listed or counted');
END $$;
RESET ROLE;
ALTER TABLE public.people_account_codes ENABLE TRIGGER people_account_codes_labour_exact;

-- Hidden, never closed: no item was written.
DO $$ BEGIN
  PERFORM pg_temp.assert_ok(NOT EXISTS (
    SELECT FROM public.reconcile_items t FULL JOIN zz_before b USING (id)
    WHERE t.id IS NULL OR b.id IS NULL OR md5(t::text) IS DISTINCT FROM b.row_hash),
    'no item closed or changed');
END $$;

-- The cost-line twin is not touched: main's body (20261118195100), IMMUTABLE,
-- 301 and 306 written in it. It changes in a later PR, with the labour flag.
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)'::regprocedure)
    = '534760eeda42dd472aa643ac27e90368'
    AND (SELECT provolatile FROM pg_proc WHERE oid = 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)'::regprocedure) = 'i',
    'the twin is main''s, untouched');
END $$;

ROLLBACK;
SELECT 'Reconcile people accounts contract passed' AS result;
