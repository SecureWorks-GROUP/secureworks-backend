-- Contract for 20261027140000_context_cost_check_person_splits (CFO-18 release, 27 Oct 2026).
-- A bill a person split across two jobs in Bills to place (manual_split rows) is a share on each
-- job, never a cost defect on either job's story; the cost check still lists the bill on each job.
-- Every fixture write is rolled back.
\set ON_ERROR_STOP 1

BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, created_at) VALUES
  ('7f000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'SWF-98201', '2026-09-01'),
  ('7f000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'SWF-98202', '2026-09-01');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, job_id, contact_name,
                                  invoice_date, sub_total, total, amount_due, line_items, raw_json, created_at, synced_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'cfsplit-bill-1', 'BILL-98201', 'ACCPAY', 'AUTHORISED',
        NULL, 'Installer', '2026-10-08', 900, 990, 990,
        '[{"Description":"Installs SWF-98201 SWF-98202","LineAmount":900,"TaxAmount":90,"AccountCode":"306"}]',
        '{"LineAmountTypes":"Exclusive"}', '2026-10-09 01:00Z', '2026-10-09 01:00Z');
INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status)
VALUES ('cfsplit-bill-1', 'BILL-98201', 'Installer', 900, 990, '2026-10-08', 'open');

DO $$
DECLARE
  a uuid := '7f000000-0000-0000-0000-00000000000a'; b uuid := '7f000000-0000-0000-0000-00000000000b';
  t timestamptz := '2026-10-20 05:00Z'; ma jsonb; mb jsonb; v jsonb;
BEGIN
  v := public.allocate_bill_split('cfsplit-bill-1',
         jsonb_build_array(jsonb_build_object('job_id', a, 'amount_ex', 600, 'lane', 'labour'),
                           jsonb_build_object('job_id', b, 'amount_ex', 300, 'lane', 'labour')),
         0, NULL, 'person@example.test');
  IF NOT (v ->> 'ok')::boolean THEN RAISE EXCEPTION 'split cost check contract: split failed %', v; END IF;
  -- The job cost read counts a share on each job.
  IF (SELECT sum(e.amount_ex) FROM public.v_job_cost_events e WHERE e.document_id = 'cfsplit-bill-1' AND e.is_actual AND e.job_id = a) IS DISTINCT FROM 600
     OR (SELECT sum(e.amount_ex) FROM public.v_job_cost_events e WHERE e.document_id = 'cfsplit-bill-1' AND e.is_actual AND e.job_id = b) IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'split cost check contract: the shares are not 600 and 300';
  END IF;
  ma := public.context_job_story_meta(a, t); mb := public.context_job_story_meta(b, t);
  IF (ma -> 'cost_check' ->> 'counted_elsewhere')::int <> 0 OR (mb -> 'cost_check' ->> 'counted_elsewhere')::int <> 0
     OR jsonb_array_length(ma -> 'cost_check' -> 'items') <> 0 OR jsonb_array_length(mb -> 'cost_check' -> 'items') <> 0 THEN
    RAISE EXCEPTION 'split cost check contract: a person''s split reads as a defect: % / %', ma -> 'cost_check', mb -> 'cost_check';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_function_privilege('authenticated', 'public.context_job_story_meta(uuid, timestamptz)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_job_story_meta(uuid, timestamptz)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'split cost check contract: a browser role holds a grant';
  END IF;
END $$;
ROLLBACK;
