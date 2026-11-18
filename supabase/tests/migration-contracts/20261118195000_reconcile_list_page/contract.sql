BEGIN;
SET LOCAL statement_timeout = '90s';
-- Applies twice: the guards accept this migration's own index and bodies.
\ir ../../../migrations/20261118195000_reconcile_list_page.sql
\ir ../../../migrations/20261118195000_reconcile_list_page.sql

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
    AND NOT has_function_privilege('anon', 'public.reconcile_list_counts(uuid)', 'EXECUTE'), 'grants');
  PERFORM pg_temp.assert_ok((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'reconcile_list_v1'),
    'switch row seeded off');
  PERFORM pg_temp.assert_ok(to_regclass('public.reconcile_items_open_page_idx') IS NULL, 'no new index (design read)');
END $$;

-- Made-up rows: two orgs, cost kinds, one snoozed, one with no amount, a tie.
INSERT INTO public.reconcile_items(id, org_id, kind, subject_table, subject_id, reason, amount_ex,
  evidence_hash, raised_by, raised_at, snooze_until) VALUES
 ('c0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZ1','no_clue',500,'h1','ZZTEST','2026-11-01 00:00+00',NULL),
 ('c0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZ2','no_clue',200,'h2','ZZTEST','2026-11-02 00:00+00',NULL),
 ('c0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-00000000000a','credit','cost_document','xero_credit_note:ZZ3','no_clue',-50,'h3','ZZTEST','2026-11-02 00:00+00',NULL),
 ('c0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZ4','no_clue',200,'h4','ZZTEST','2026-11-03 00:00+00',NULL),
 ('c0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZ5','amount_unknown',NULL,'h5','ZZTEST','2026-11-01 00:00+00',NULL),
 ('c0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZ6','no_clue',900,'h6','ZZTEST','2026-11-01 00:00+00','2999-01-01 00:00+00'),
 ('c0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-00000000000a','receipt','cost_document','expense_receipt:ZZ7','no_clue',70,'h7','ZZTEST','2026-11-01 00:00+00',NULL),
 ('c0000000-0000-4000-8000-000000000008','b0000000-0000-4000-8000-00000000000b','bill','cost_document','xero_bill:ZZ8','no_clue',1000,'h8','ZZTEST','2026-11-01 00:00+00',NULL),
 -- Labour billed outside the Trade App: a person's pay, never listed or counted.
 ('c0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZA','installer_bill_outside_app',5000,'hA','ZZTEST','2026-11-01 00:00+00',NULL);
INSERT INTO public.reconcile_items(id, org_id, kind, subject_table, subject_id, reason, amount_ex,
  evidence_hash, raised_by, raised_at, status, closed_at) VALUES
 ('c0000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-00000000000a','bill','cost_document','xero_bill:ZZ9','no_clue',800,'h9','ZZTEST','2026-11-01 00:00+00','decided',now());

SET LOCAL ROLE service_role;
DO $$
DECLARE kinds text[] := ARRAY['bill','credit']; walk text[] := '{}'; after jsonb; r record; got int; pages int := 0;
BEGIN
  -- Walk the bills tab two at a time: not snoozed first, dollars down, no amount
  -- last, ties by raised_at then id, the snoozed bill last of all.
  LOOP
    got := 0; pages := pages + 1;
    FOR r IN SELECT * FROM public.reconcile_list_page('a0000000-0000-4000-8000-00000000000a', kinds, 2, after) LOOP
      got := got + 1;
      EXIT WHEN got > 2;
      walk := walk || right(r.id::text, 1);
      after := jsonb_build_object('snoozed', r.snoozed, 'amount_ex', r.amount_ex, 'raised_at', r.raised_at, 'id', r.id);
    END LOOP;
    EXIT WHEN got <= 2 OR pages > 10;
  END LOOP;
  PERFORM pg_temp.assert_ok(walk = ARRAY['1','2','4','3','5','6'], 'page walk order: ' || array_to_string(walk, ','));
  PERFORM pg_temp.assert_ok(pages = 3, 'three pages of two: ' || pages);
  -- A limit over 100 reads 101 rows at most; under 1 reads 2.
  PERFORM pg_temp.assert_ok((SELECT count(*) FROM public.reconcile_list_page('a0000000-0000-4000-8000-00000000000a', kinds, 0, NULL)) = 2, 'limit floor');
  -- Another org's rows and closed rows never show.
  PERFORM pg_temp.assert_ok(NOT EXISTS (SELECT 1 FROM public.reconcile_list_page('a0000000-0000-4000-8000-00000000000a', ARRAY['bill','credit','receipt'], 100, NULL)
    WHERE id IN ('c0000000-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000009')), 'org and status');
  -- Labour billed outside the Trade App never shows, on any kind or page size.
  PERFORM pg_temp.assert_ok(NOT EXISTS (SELECT 1 FROM public.reconcile_list_page('a0000000-0000-4000-8000-00000000000a', ARRAY['bill','credit','receipt'], 100, NULL)
    WHERE id = 'c0000000-0000-4000-8000-00000000000a' OR reason = 'installer_bill_outside_app'), 'installer bill never listed');
  -- Counts: same org and status, by kind. Labour billed outside the Trade App is not counted.
  PERFORM pg_temp.assert_ok((SELECT jsonb_object_agg(kind, open) FROM public.reconcile_list_counts('a0000000-0000-4000-8000-00000000000a'))
    = '{"bill":5,"credit":1,"receipt":1}'::jsonb, 'counts by kind');
END $$;
RESET ROLE;

ROLLBACK;
SELECT 'P2-03.6 reconcile list page contract passed' AS result;
