BEGIN;
SET LOCAL statement_timeout = '90s';
-- A later body (people accounts) is live on the full stack: stand this one back up first.
\ir ../../../rollbacks/20261119999910_reconcile_people_accounts_down.sql
-- Applies twice: the guard accepts this migration's own bodies.
\ir ../../../migrations/20261118195400_reconcile_list_page_labour_docs.sql
\ir ../../../migrations/20261118195400_reconcile_list_page_labour_docs.sql

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', label; END IF;
END $$;

DO $$ BEGIN
  PERFORM pg_temp.assert_ok(
    has_function_privilege('service_role', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.reconcile_list_counts(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.reconcile_list_counts(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.reconcile_list_counts(uuid)', 'EXECUTE'), 'grants kept');
  PERFORM pg_temp.assert_ok(obj_description('public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure, 'pg_proc') LIKE 'Reconcile list (P2-03.6)%'
    AND obj_description('public.reconcile_list_counts(uuid)'::regprocedure, 'pg_proc') LIKE 'Reconcile list (P2-03.6)%',
    'comment prefix kept, so 20261118195200 still re-applies');
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure)
    = '8c9e154df84031b3ae8620953c67c841', 'page body is this migration''s');
  PERFORM pg_temp.assert_ok((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_counts(uuid)'::regprocedure)
    = '377ee4c6d4f4d5ae66b070dc31748f44', 'counts body is this migration''s');
END $$;

-- Made-up rows, org a: a mixed bill (a supplier line and a person's labour
-- line), a plain bill, credits that follow the mixed bill by document and by
-- line, a credit whose only line following the mixed bill was removed, a
-- credit that follows the plain bill, and a receipt. Org b holds a labour line
-- on a document of the same id as org a's plain bill.
INSERT INTO public.job_cost_lines(id, org_id, kind, document_kind, document_id, line_key, lane, amount_ex,
  state, needs_reason, not_counted_reason, follows_line_id, follows_document_kind, follows_document_id, source_hash) VALUES
 ('d0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','ZZM','1','materials',100,'needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-00000000000a','installer_bill','xero_bill','ZZM','2','labour',400,'needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-00000000000a','supplier_bill','xero_bill','ZZS','1','materials',50,'needs_person','new',NULL,NULL,NULL,NULL,'h'),
 ('d0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZZC1','1','materials',-20,'needs_person','new',NULL,NULL,'xero_bill','ZZM','h'),
 ('d0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZZC2','1','materials',-10,'needs_person','new',NULL,'d0000000-0000-4000-8000-000000000001',NULL,NULL,'h'),
 ('d0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZZC3','1','materials',0,NULL,NULL,'line_removed',NULL,'xero_bill','ZZM','h'),
 ('d0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZZC3','2','materials',-5,'needs_person','new',NULL,NULL,'xero_bill','ZZS','h'),
 ('d0000000-0000-4000-8000-000000000008','a0000000-0000-4000-8000-00000000000a','supplier_credit','xero_credit_note','ZZC4','1','materials',-5,'needs_person','new',NULL,NULL,'xero_bill','ZZS','h'),
 ('d0000000-0000-4000-8000-000000000009','b0000000-0000-4000-8000-00000000000b','installer_bill','xero_bill','ZZS','1','labour',700,'needs_person','new',NULL,NULL,NULL,NULL,'h');
INSERT INTO public.reconcile_items(id, org_id, kind, subject_table, subject_id, reason, amount_ex,
  evidence_hash, raised_by, raised_at) VALUES
 ('c0000000-0000-4000-8000-0000000000e1','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZM','no_clue',500,'h1','ZZTEST','2026-11-01 00:00+00'),
 ('c0000000-0000-4000-8000-0000000000e2','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZS','no_clue',50,'h2','ZZTEST','2026-11-01 00:00+00'),
 ('c0000000-0000-4000-8000-0000000000e3','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZZC1','no_clue',-20,'h3','ZZTEST','2026-11-01 00:00+00'),
 ('c0000000-0000-4000-8000-0000000000e4','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZZC2','no_clue',-10,'h4','ZZTEST','2026-11-01 00:00+00'),
 ('c0000000-0000-4000-8000-0000000000e5','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZZC3','no_clue',-5,'h5','ZZTEST','2026-11-01 00:00+00'),
 ('c0000000-0000-4000-8000-0000000000e6','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZZC4','no_clue',-5,'h6','ZZTEST','2026-11-02 00:00+00'),
 ('c0000000-0000-4000-8000-0000000000e7','a0000000-0000-4000-8000-00000000000a','receipt','cost_document','expense_receipt:ZZR','no_clue',70,'h7','ZZTEST','2026-11-01 00:00+00');

SET LOCAL ROLE service_role;
DO $$
DECLARE kinds text[] := ARRAY['bill','credit','receipt']; walk text[] := '{}'; after jsonb; r record; got int; pages int := 0;
BEGIN
  PERFORM pg_temp.assert_ok((SELECT array_agg(right(id::text, 2) ORDER BY right(id::text, 2))
    FROM public.reconcile_list_page('a0000000-0000-4000-8000-00000000000a', kinds, 100, NULL)) = ARRAY['e2','e5','e6','e7'],
    'mixed bill and the credits that follow it are not listed; a removed line follows nothing; org b''s labour line is not org a''s');
  PERFORM pg_temp.assert_ok((SELECT jsonb_object_agg(kind, open) FROM public.reconcile_list_counts('a0000000-0000-4000-8000-00000000000a'))
    = '{"bill":1,"credit":2,"receipt":1}'::jsonb, 'counts leave out the same items');
  -- One at a time: every page holds one listed item, and the walk ends with them.
  LOOP
    got := 0; pages := pages + 1;
    FOR r IN SELECT * FROM public.reconcile_list_page('a0000000-0000-4000-8000-00000000000a', kinds, 1, after) LOOP
      got := got + 1;
      EXIT WHEN got > 1;
      walk := walk || right(r.id::text, 2);
      after := jsonb_build_object('snoozed', r.snoozed, 'amount_ex', r.amount_ex, 'raised_at', r.raised_at, 'id', r.id);
    END LOOP;
    EXIT WHEN got <= 1 OR pages > 10;
  END LOOP;
  PERFORM pg_temp.assert_ok(walk = ARRAY['e7','e2','e5','e6'] AND pages = 4, 'walk: ' || array_to_string(walk, ',') || ' in ' || pages);
END $$;
RESET ROLE;

ROLLBACK;
SELECT 'Reconcile list labour documents contract passed' AS result;
