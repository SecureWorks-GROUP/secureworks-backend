BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Rule 17: restore earlier prerequisite objects if an earlier contract dropped them.
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL AS p3023_restore_recon_raise \gset
\if :p3023_restore_recon_raise
\ir ../20261118073218_reconcile_item_raise/setup.sql
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif

SELECT to_regclass('public.supplier_credit_drafts') IS NULL AS p3023_restore_credit_drafts \gset
\if :p3023_restore_credit_drafts
\ir ../../../migrations/20261118114119_supplier_credit_drafts.sql
\endif

DO $privs$
DECLARE
  f_cand regprocedure := to_regprocedure('public.supplier_credit_candidate_attachments(uuid,timestamptz,integer,uuid[])');
  f_bill regprocedure := to_regprocedure('public.supplier_credit_matching_bills(uuid,text)');
  f_rec  regprocedure := to_regprocedure('public.supplier_credit_record_proposal(uuid,uuid,text,text,text,text,text,date,numeric,numeric,text,text,uuid,jsonb,jsonb,jsonb)');
/* block */ BEGIN
  IF f_cand IS NULL OR f_bill IS NULL OR f_rec IS NULL THEN
    RAISE EXCEPTION 'supplier_credit_propose_functions_missing';
  END IF;

  IF has_function_privilege('anon', f_cand, 'EXECUTE')
     OR has_function_privilege('authenticated', f_cand, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f_cand, 'EXECUTE')
     OR has_function_privilege('anon', f_bill, 'EXECUTE')
     OR has_function_privilege('authenticated', f_bill, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f_bill, 'EXECUTE')
     OR has_function_privilege('anon', f_rec, 'EXECUTE')
     OR has_function_privilege('authenticated', f_rec, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f_rec, 'EXECUTE') THEN
    RAISE EXCEPTION 'supplier_credit_propose_privileges_incorrect';
  END IF;
END $privs$;

SAVEPOINT p3023_behaviour;
SET LOCAL session_replication_role = replica;

DO $behaviour$
DECLARE
  v_org uuid := '32023100-0000-4000-8000-000000000001';
  v_other_org uuid := '32023100-0000-4000-8000-000000000002';
  v_job uuid := '32023100-0000-4000-8000-000000000010';
  v_foreign_job uuid := '32023100-0000-4000-8000-000000000011';
  v_att_old uuid := '32023100-0000-4000-8000-0000000000a0';
  v_att_1 uuid := '32023100-0000-4000-8000-0000000000a1';
  v_att_2 uuid := '32023100-0000-4000-8000-0000000000a2';
  v_att_dup uuid := '32023100-0000-4000-8000-0000000000a3';
  v_cand_ids uuid[];
  v_bill_count int;
  v_matched_job uuid;
  v_res jsonb;
  v_draft_id uuid;
/* block */ BEGIN
  INSERT INTO public.organisations (id) VALUES (v_org), (v_other_org) ON CONFLICT DO NOTHING;
  INSERT INTO public.jobs (id, org_id, job_number) VALUES
    (v_job, v_org, 'ZZTEST-SWF-260002'),
    (v_foreign_job, v_other_org, 'ZZTEST-SWF-999999')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.context_email_attachments (
    id, provider_message_id, attachment_key, file_name, content_type, sha256, storage_bucket, storage_path, status, created_at
  ) VALUES
    (v_att_old, 'email:zz-p3023-0', repeat('0', 64), 'credit_old.pdf', 'application/pdf', repeat('a', 64), 'context-email-attachments', 'zz/old.pdf', 'stored', '2026-09-15T00:00:00Z'),
    (v_att_1, 'email:zz-p3023-1', repeat('1', 64), 'Credit_Note_CN-1001.pdf', 'application/pdf', repeat('b', 64), 'context-email-attachments', 'zz/cn1.pdf', 'stored', '2026-10-03T08:00:00Z'),
    (v_att_2, 'email:zz-p3023-2', repeat('2', 64), 'ADJUST_CN-1002.pdf', 'application/pdf', repeat('c', 64), 'context-email-attachments', 'zz/cn2.pdf', 'stored', '2026-10-04T08:00:00Z'),
    (v_att_dup, 'email:zz-p3023-3', repeat('3', 64), 'cn_existing.pdf', 'application/pdf', repeat('d', 64), 'context-email-attachments', 'zz/cndup.pdf', 'stored', '2026-10-05T08:00:00Z');

  INSERT INTO public.xero_invoices (
    org_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, job_id
  ) VALUES
    (v_org, 'zz-xinv-5001', 'zz-contact-1', 'ZZTEST Supplies', 'inv-5001', 'ACCPAY', 'AUTHORISED', v_job),
    (v_org, 'zz-xinv-accrec', 'zz-contact-c', 'ZZTEST Customer', 'INV-5001', 'ACCREC', 'AUTHORISED', v_job),
    (v_org, 'zz-xinv-dup-a', 'zz-contact-a', 'ZZTEST A', 'INV-8888', 'ACCPAY', 'AUTHORISED', v_job),
    (v_org, 'zz-xinv-dup-b', 'zz-contact-b', 'ZZTEST B', 'inv-8888', 'ACCPAY', 'AUTHORISED', NULL),
    (v_org, 'zz-xinv-foreign-job', 'zz-contact-1', 'ZZTEST Supplies', 'INV-9999', 'ACCPAY', 'AUTHORISED', v_foreign_job);

  INSERT INTO public.xero_supplier_credit_notes (
    org_id, xero_credit_note_id, credit_note_type, credit_note_number, xero_contact_id, contact_name, allocations_returned, raw_json
  ) VALUES (
    v_org, 'zz-xcn-9001', 'ACCPAYCREDIT', 'cn-9001', 'zz-contact-1', 'ZZTEST Supplies', false, '{}'::jsonb
  );

  SELECT array_agg(c.id ORDER BY c.created_at ASC, c.id ASC) INTO v_cand_ids
  FROM public.supplier_credit_candidate_attachments(v_org, '2026-09-26T00:00:00Z'::timestamptz, 10, '{}') c;

  IF v_cand_ids IS DISTINCT FROM ARRAY[v_att_1, v_att_2, v_att_dup] THEN
    RAISE EXCEPTION 'supplier_credit_candidates_unexpected: %', v_cand_ids;
  END IF;

  -- Single ACCPAY match ignores ACCREC twin and case difference.
  SELECT count(*), max(b.job_id::text)::uuid INTO v_bill_count, v_matched_job
  FROM public.supplier_credit_matching_bills(v_org, 'INV-5001') b;
  IF v_bill_count <> 1 OR v_matched_job IS DISTINCT FROM v_job THEN
    RAISE EXCEPTION 'supplier_credit_bill_match_unexpected: % %', v_bill_count, v_matched_job;
  END IF;

  -- Ambiguous ACCPAY bills return 2 rows.
  SELECT count(*) INTO v_bill_count
  FROM public.supplier_credit_matching_bills(v_org, 'INV-8888') b;
  IF v_bill_count <> 2 THEN
    RAISE EXCEPTION 'supplier_credit_ambiguous_bills_expected_2: %', v_bill_count;
  END IF;

  -- Foreign-org job_id on xero_invoices is stripped to NULL.
  SELECT b.job_id INTO v_matched_job
  FROM public.supplier_credit_matching_bills(v_org, 'INV-9999') b;
  IF v_matched_job IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_credit_foreign_job_leaked: %', v_matched_job;
  END IF;

  -- Record proposed credit and raise one reconcile item atomically.
  v_res := public.supplier_credit_record_proposal(
    v_org,
    v_att_1,
    'context-email-attachments',
    'zz/cn1.pdf',
    'zz-contact-1',
    'ZZTEST Supplies',
    'CN-1001',
    '2026-10-03'::date,
    200.00,
    220.00,
    'INV-5001',
    'zz-xinv-5001',
    v_job,
    '[{"code":"credit_names_bill","value":"inv-5001"}]'::jsonb,
    jsonb_build_object('outcome', 'job', 'job_id', v_job),
    jsonb_build_object(
      'reason', 'credit_document_read',
      'amount_ex', 200,
      'document_date', '2026-10-03',
      'summary', jsonb_build_object(
        'words', 'Credit CN-1001 from ZZTEST Supplies for bill INV-5001',
        'credit_number', 'CN-1001',
        'supplier_name', 'ZZTEST Supplies',
        'names_bill_number', 'INV-5001',
        'amount_inc', 220
      )
    )
  );
  IF v_res ->> 'outcome' <> 'proposed' THEN
    RAISE EXCEPTION 'supplier_credit_expected_proposed: %', v_res;
  END IF;
  v_draft_id := (v_res ->> 'draft_id')::uuid;

  IF (SELECT count(*) FROM public.reconcile_items
      WHERE kind = 'credit_note_proposed'
        AND subject_table = 'supplier_credit_drafts'
        AND subject_id = v_draft_id::text
        AND status = 'open'
        AND raised_by = 'phase3:books') <> 1 THEN
    RAISE EXCEPTION 'supplier_credit_reconcile_item_missing';
  END IF;

  -- Second candidate read excludes v_att_1.
  SELECT array_agg(c.id ORDER BY c.created_at ASC, c.id ASC) INTO v_cand_ids
  FROM public.supplier_credit_candidate_attachments(v_org, '2026-09-26T00:00:00Z'::timestamptz, 10, '{}') c;
  IF v_cand_ids IS DISTINCT FROM ARRAY[v_att_2, v_att_dup] THEN
    RAISE EXCEPTION 'supplier_credit_second_candidates_unexpected: %', v_cand_ids;
  END IF;

  -- Unique conflict (same supplier different case + credit_number) skips without raising again.
  v_res := public.supplier_credit_record_proposal(
    v_org,
    v_att_2,
    'context-email-attachments',
    'zz/cn2.pdf',
    'zz-contact-1',
    'zztest supplies',
    'CN-1001',
    '2026-10-03'::date,
    200.00,
    220.00,
    'INV-5001',
    'zz-xinv-5001',
    v_job,
    '[]'::jsonb,
    NULL,
    jsonb_build_object('reason', 'credit_document_read', 'summary', '{}'::jsonb)
  );
  IF v_res ->> 'outcome' <> 'already_exists' THEN
    RAISE EXCEPTION 'supplier_credit_expected_already_exists: %', v_res;
  END IF;

  -- Duplicate in xero_supplier_credit_notes inserts state='duplicate' and raises nothing.
  v_res := public.supplier_credit_record_proposal(
    v_org,
    v_att_dup,
    'context-email-attachments',
    'zz/cndup.pdf',
    'zz-contact-1',
    'ZZTEST Supplies',
    'CN-9001',
    '2026-10-05'::date,
    100.00,
    110.00,
    'INV-5001',
    'zz-xinv-5001',
    v_job,
    '[]'::jsonb,
    NULL,
    jsonb_build_object('reason', 'credit_document_read', 'summary', '{}'::jsonb)
  );
  IF v_res ->> 'outcome' <> 'duplicate' THEN
    RAISE EXCEPTION 'supplier_credit_expected_duplicate: %', v_res;
  END IF;
  IF (SELECT count(*) FROM public.reconcile_items
      WHERE subject_table = 'supplier_credit_drafts'
        AND subject_id = (v_res ->> 'draft_id')) <> 0 THEN
    RAISE EXCEPTION 'supplier_credit_duplicate_must_not_raise';
  END IF;

  -- Atomicity: a failed reconcile_item_raise rolls back supplier_credit_drafts insert.
  BEGIN
    PERFORM public.supplier_credit_record_proposal(
      v_org,
      v_att_2,
      'context-email-attachments',
      'zz/cn2.pdf',
      'zz-contact-1',
      'ZZTEST Supplies',
      'CN-FAIL-RAISE',
      '2026-10-04'::date,
      100.00,
      110.00,
      NULL,
      NULL,
      NULL,
      '[]'::jsonb,
      NULL,
      '{}'::jsonb
    );
    RAISE EXCEPTION 'supplier_credit_expected_raise_failure';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'supplier_credit_expected_raise_failure' THEN
      RAISE;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.supplier_credit_drafts
    WHERE org_id = v_org AND credit_number = 'CN-FAIL-RAISE'
  ) THEN
    RAISE EXCEPTION 'supplier_credit_orphaned_row_after_failed_raise';
  END IF;
END $behaviour$;

ROLLBACK TO SAVEPOINT p3023_behaviour;

-- Rule 16: prove index-bound plans (no Seq Scan, bounded rows) on populated tables.
SAVEPOINT p3023_plans;
SET LOCAL session_replication_role = replica;

INSERT INTO public.context_email_attachments (
  id, provider_message_id, attachment_key, file_name, content_type, sha256, storage_bucket, storage_path, status, created_at
)
SELECT
  ('32023200-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  'email:zz-plan-' || g,
  lpad(to_hex(g), 64, '0'),
  CASE WHEN g >= 11995 THEN 'credit_note_' || g || '.pdf' ELSE 'statement_' || g || '.pdf' END,
  'application/pdf',
  lpad(to_hex(g), 64, 'a'),
  'context-email-attachments',
  'zz/plan-' || g || '.pdf',
  'stored',
  '2026-06-01T00:00:00Z'::timestamptz + (g || ' minutes')::interval
FROM generate_series(1, 12000) g;

INSERT INTO public.supplier_credit_drafts (
  id, org_id, source_attachment_id, supplier_name, credit_number
)
SELECT
  ('32023300-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  '32023100-0000-4000-8000-000000000001'::uuid,
  ('32023200-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  'ZZTEST Bulk Supplier',
  'CN-BULK-' || g
FROM generate_series(1, 4000) g;

INSERT INTO public.xero_invoices (
  id, org_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status
)
SELECT
  ('32023400-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
  '32023100-0000-4000-8000-000000000001'::uuid,
  'zz-bulk-inv-' || g,
  'zz-contact-' || (g % 200),
  'ZZTEST Supplier ' || (g % 200),
  'INV-BULK-' || g,
  CASE WHEN g % 4 = 0 THEN 'ACCREC' ELSE 'ACCPAY' END,
  'AUTHORISED'
FROM generate_series(1, 12000) g;

INSERT INTO public.xero_supplier_credit_notes (
  org_id, xero_credit_note_id, credit_note_type, credit_note_number, xero_contact_id, contact_name, allocations_returned, raw_json
)
SELECT
  '32023100-0000-4000-8000-000000000001'::uuid,
  'zz-bulk-cn-' || g,
  'ACCPAYCREDIT',
  'CN-XERO-' || g,
  'zz-contact-' || (g % 200),
  'ZZTEST Supplier ' || (g % 200),
  false,
  '{}'::jsonb
FROM generate_series(1, 4000) g;

ANALYZE public.context_email_attachments;
ANALYZE public.supplier_credit_drafts;
ANALYZE public.xero_invoices;
ANALYZE public.xero_supplier_credit_notes;

DO $plans$
DECLARE
  v_plan jsonb;
  v_cutoff timestamptz := '2026-06-01T00:00:00Z'::timestamptz + interval '11980 minutes';
/* block */ BEGIN
  -- 1. Candidate attachments anti-join plan: no Seq Scan, index scan on both tables.
  EXECUTE format(
    $q$EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
       SELECT a.id
       FROM public.context_email_attachments a
       WHERE a.status = 'stored'
         AND a.content_type = 'application/pdf'
         AND a.created_at >= %L::timestamptz
         AND (a.file_name ILIKE '%%credit%%' OR a.file_name ILIKE '%%adjust%%' OR a.file_name ILIKE '%%cn%%')
         AND NOT EXISTS (
           SELECT 1 FROM public.supplier_credit_drafts d
           WHERE d.org_id = '32023100-0000-4000-8000-000000000001'::uuid
             AND d.source_attachment_id IS NOT NULL
             AND d.source_attachment_id = a.id
         )
       ORDER BY a.created_at ASC, a.id ASC
       LIMIT 10$q$,
    v_cutoff
  ) INTO v_plan;

  IF jsonb_path_exists(v_plan, '$.** ? (@."Node Type" == "Seq Scan")') THEN
    RAISE EXCEPTION 'candidate_plan_seq_scan: %', v_plan;
  END IF;
  IF NOT jsonb_path_exists(v_plan,
      '$.** ? (@."Relation Name" == "context_email_attachments" && (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Heap Scan"))')
     OR NOT jsonb_path_exists(v_plan,
      '$.** ? (@."Relation Name" == "supplier_credit_drafts" && (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Heap Scan"))') THEN
    RAISE EXCEPTION 'candidate_plan_missing_index_access: %', v_plan;
  END IF;

  -- 2. ACCPAY bill lookup by lower(invoice_number): no Seq Scan, bounded index scan.
  EXECUTE $q$EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
    SELECT x.xero_invoice_id, x.invoice_number, x.xero_contact_id, x.contact_name, x.job_id
    FROM public.xero_invoices x
    WHERE x.org_id = '32023100-0000-4000-8000-000000000001'::uuid
      AND x.invoice_type = 'ACCPAY'
      AND x.invoice_number IS NOT NULL
      AND lower(x.invoice_number) = lower('inv-bulk-9999')
    ORDER BY x.xero_invoice_id ASC
    LIMIT 2$q$ INTO v_plan;

  IF jsonb_path_exists(v_plan, '$.** ? (@."Node Type" == "Seq Scan")')
     OR NOT jsonb_path_exists(v_plan,
       '$.** ? (@."Relation Name" == "xero_invoices" && (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Heap Scan"))') THEN
    RAISE EXCEPTION 'bill_lookup_plan_not_index_bound: %', v_plan;
  END IF;

  -- 3. Supplier credit duplicate check: no Seq Scan, index scan on xero_supplier_credit_notes.
  EXECUTE $q$EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
    SELECT 1
    FROM public.xero_supplier_credit_notes c
    WHERE c.org_id = '32023100-0000-4000-8000-000000000001'::uuid
      AND c.xero_contact_id = 'zz-contact-42'
      AND c.credit_note_number IS NOT NULL
      AND lower(c.credit_note_number) = lower('cn-xero-242')
    LIMIT 1$q$ INTO v_plan;

  IF jsonb_path_exists(v_plan, '$.** ? (@."Node Type" == "Seq Scan")')
     OR NOT jsonb_path_exists(v_plan,
       '$.** ? (@."Relation Name" == "xero_supplier_credit_notes" && (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Heap Scan"))') THEN
    RAISE EXCEPTION 'credit_duplicate_plan_not_index_bound: %', v_plan;
  END IF;
END $plans$;

ROLLBACK TO SAVEPOINT p3023_plans;

-- Re-apply proves idempotence and guard post-image acceptance.
\ir ../../../migrations/20261118135507_supplier_credit_propose.sql

SELECT 'PASS P3-02.3: candidate filter, bill match, duplicate skip, atomic reconcile raise, service_role privileges, and index-bound plans';
ROLLBACK;
