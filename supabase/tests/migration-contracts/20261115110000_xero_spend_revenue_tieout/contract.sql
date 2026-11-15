-- Contract for 20261115110000_xero_spend_revenue_tieout: card and bank spend by Xero account, and customer invoices
-- against Job Profit, by month.
--
-- Synthetic rows only, no customer data, dated 2035 so no other case's fixtures fall in the months read. Everything
-- rolls back. The read is called with a fixed as_of (2035-10-15, seven months: April to October), never the clock.
--
-- Org 1 is ours; org 2 is another org, never read by an org-1 call.
-- Chart (org 1): 305 direct cost; 302 fuel (expense); 800 loan (liability); 710 equipment (asset); 200 sales
--   (revenue); 312 twice: an archived expense account and an active direct cost account.
-- Spend money, June 2035 (org 1), ex GST:
--   SP-1  100.00  one line, GST inclusive 110.00 less 10.00, account 305 by id, tracking SW - FENCING   direct cost
--   SP-2  250.00  GST exclusive: 50.00 code 302 (overhead) and 200.00 account 800 by id (not a cost)
--   SP-3   30.00  no tax, code 200                                                                        income account
--   SP-4   50.00  GST inclusive 55.00 less 5.00, code 999: not in the chart                               account unknown
--   SP-5   75.25  no lines row                                                                             no line detail
--   SP-6   20.00  a lines row holding an empty list                                                        no line detail
--   SP-7   50.01  GST inclusive: 33.00 less 3.00 code 312 (the active account wins: direct cost), and
--                 22.00 less 2.00 on the archived 312 by id (overhead); the subtotal is a cent more      lines differ 0.01
--   Not spend: SP-DEL (deleted), SP-RECV (money received), SP-XFER (a transfer).
--   June: 7 transactions, 575.26 = direct 130.00 + overhead 70.00 + not a cost 200.00 + income account 30.00
--         + account unknown 50.00 + no line detail 95.25 + lines differ 0.01. Status partial.
-- July: SP-NULL, no subtotal in the copy, one 10.00 line: partial, amount unknown 1, does not add up.
-- August: SP-A1 40.00 on the equipment account: read, adds up, not a cost 40.00.
-- September: nothing: read, zero.
-- October: SP-O1 60.00 with no lines: not_yet_read (amounts null, the raw total still shown).
-- April and May: before the copy's first transaction: not_in_copy.
-- Org 2, June: SP2-1 70.00 on its own account 305, which org 2's chart calls an expense: overhead in org 2.
--
-- Customer invoices, June 2035 (org 1), ex GST. RJ1 is a real job, RJH the holding job.
--   RI-1  1000.00  AUTHORISED on RJ1, one GST inclusive line                         on a job 1000.00
--   RI-2   500.00  PAID, on no job                                                    not on a job 500.00
--   RI-3   300.00  AUTHORISED on the holding job, no lines stored                    holding job 300.00
--   RI-4   200.00  PAID on RJ1, lines add to 250.00                                   on a job 250.00, over counted 50.00
--   RI-5   400.00  AUTHORISED on RJ1, lines add to 350.00                             on a job 350.00, not on a job 50.00
--   Not counted: RI-D (DRAFT 999.00), RI-S (SUBMITTED 111.00). Nowhere: RI-V (VOIDED), RI-BILL (a supplier bill).
--   June: 5 invoices, 2400.00 = on a job 1600.00 + holding 300.00 + not on a job 550.00 - over counted 50.00.
--   Share not on a job 0.3542. Org 2: RI2-1 800.00 on org 2's job.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.organisations (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Synthetic org'),
  ('00000000-0000-0000-0000-000000000002', 'Synthetic org 2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
  ('ba000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'SWT-98001', '{}', '{}', '2035-01-01'),
  ('ba000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'SWT-98009', '{"do_not_schedule": "true"}', '{}', '2035-01-01'),
  ('ba000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000002', 'in_progress', 'fencing', 'SWT-98002', '{}', '{}', '2035-01-01');

INSERT INTO public.xero_accounts (org_id, xero_account_id, code, name, type, class, status, synced_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'A-305', '305', 'Direct Material Cost', 'DIRECTCOSTS', 'EXPENSE', 'ACTIVE', '2035-10-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'A-302', '302', 'Fuel', 'EXPENSE', 'EXPENSE', 'ACTIVE', '2035-10-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'A-800', '800', 'Vehicle loan', 'TERMLIAB', 'LIABILITY', 'ACTIVE', '2035-10-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'A-710', '710', 'Equipment', 'FIXED', 'ASSET', 'ACTIVE', '2035-10-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'A-200', '200', 'Sales', 'REVENUE', 'REVENUE', 'ACTIVE', '2035-10-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'A-312-ARCH', '312', 'Tools (old)', 'EXPENSE', 'EXPENSE', 'ARCHIVED', '2035-10-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'A-312', '312', 'Materials stock', 'DIRECTCOSTS', 'EXPENSE', 'ACTIVE', '2035-10-02T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'A2-305', '305', 'Sundry', 'EXPENSE', 'EXPENSE', 'ACTIVE', '2035-10-01T00:00:00Z');

INSERT INTO public.xero_bank_transactions (org_id, xero_txn_id, account_id, txn_date, txn_type, contact_name, amount, sub_total, total_tax, status, synced_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'SP-1', 'BANK-1', '2035-06-02', 'SPEND', 'Synthetic Hardware', 110.00, 100.00, 10.00, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-2', 'BANK-1', '2035-06-03', 'SPEND', 'Synthetic Fuel', 255.00, 250.00, 5.00, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-3', 'BANK-1', '2035-06-04', 'SPEND', 'Synthetic Refund', 30.00, 30.00, 0, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-4', 'BANK-1', '2035-06-05', 'SPEND', 'Synthetic Unknown', 55.00, 50.00, 5.00, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-5', 'BANK-1', '2035-06-06', 'SPEND', 'Synthetic Old', 82.78, 75.25, 7.53, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-6', 'BANK-1', '2035-06-07', 'SPEND', 'Synthetic Empty', 22.00, 20.00, 2.00, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-7', 'BANK-1', '2035-06-08', 'SPEND', 'Synthetic Tools', 55.01, 50.01, 5.00, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-DEL', 'BANK-1', '2035-06-09', 'SPEND', 'Synthetic Deleted', 500.00, 500.00, 0, 'DELETED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-RECV', 'BANK-1', '2035-06-10', 'RECEIVE', 'Synthetic Customer', 900.00, 900.00, 0, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-XFER', 'BANK-1', '2035-06-11', 'TRANSFER', NULL, 400.00, 400.00, 0, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-NULL', 'BANK-1', '2035-07-02', 'SPEND', 'Synthetic Fuel', 11.00, NULL, NULL, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-A1', 'BANK-1', '2035-08-02', 'SPEND', 'Synthetic Plant', 44.00, 40.00, 4.00, 'AUTHORISED', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-O1', 'BANK-1', '2035-10-02', 'SPEND', 'Synthetic New', 66.00, 60.00, 6.00, 'AUTHORISED', '2035-10-11T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'SP2-1', 'BANK-2', '2035-06-02', 'SPEND', 'Synthetic Other', 77.00, 70.00, 7.00, 'AUTHORISED', '2035-10-10T00:00:00Z');

INSERT INTO public.xero_bank_transaction_lines (org_id, xero_txn_id, line_amount_types, line_items, synced_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'SP-1', 'Inclusive',
   '[{"Description": "Posts", "LineAmount": 110.00, "TaxAmount": 10.00, "AccountID": "A-305", "AccountCode": "305", "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-2', 'Exclusive',
   '[{"Description": "Diesel", "LineAmount": 50.00, "TaxAmount": 5.00, "AccountCode": "302"}, {"Description": "Loan", "LineAmount": 200.00, "TaxAmount": 0, "AccountID": "A-800"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-3', 'NoTax',
   '[{"Description": "Refund paid", "LineAmount": 30.00, "TaxAmount": 0, "AccountCode": "200"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-4', 'Inclusive',
   '[{"Description": "Mystery", "LineAmount": 55.00, "TaxAmount": 5.00, "AccountCode": "999"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-6', 'Inclusive', '[]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-7', 'Inclusive',
   '[{"Description": "Screws", "LineAmount": 33.00, "TaxAmount": 3.00, "AccountCode": "312"}, {"Description": "Drill", "LineAmount": 22.00, "TaxAmount": 2.00, "AccountID": "A-312-ARCH", "AccountCode": "312"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-DEL', 'Exclusive',
   '[{"Description": "Deleted", "LineAmount": 500.00, "AccountCode": "305"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-RECV', 'Exclusive',
   '[{"Description": "Received", "LineAmount": 900.00, "AccountCode": "305"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-NULL', 'Exclusive',
   '[{"Description": "Diesel", "LineAmount": 10.00, "TaxAmount": 1.00, "AccountCode": "302"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'SP-A1', 'Exclusive',
   '[{"Description": "Mixer", "LineAmount": 40.00, "TaxAmount": 4.00, "AccountID": "A-710"}]', '2035-10-10T00:00:00Z'),
  -- The same Xero id in another org is another transaction: org 1's SP-5 has no lines of its own.
  ('00000000-0000-0000-0000-000000000002', 'SP-5', 'Exclusive',
   '[{"Description": "Other org", "LineAmount": 75.25, "AccountCode": "305"}]', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'SP2-1', 'Exclusive',
   '[{"Description": "Other org", "LineAmount": 70.00, "TaxAmount": 7.00, "AccountCode": "305"}]', '2035-10-10T00:00:00Z');

INSERT INTO public.xero_sync_state (key, cursor_at, note) VALUES
  ('bank_transactions_full:00000000-0000-0000-0000-000000000001:synthetic-tenant', '2035-10-10T01:00:00Z', 'contract'),
  ('bank_transactions:00000000-0000-0000-0000-000000000001:synthetic-tenant', '2035-10-12T01:00:00Z', 'contract');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, synced_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'RI-1', 'RIN-1', 'ACCREC', 'AUTHORISED', 'Synthetic Client', 1000.00, 1100.00, '2035-06-02',
   '[{"Description": "Fence", "LineAmount": 1100.00, "TaxAmount": 100.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Inclusive"}', 'ba000000-0000-4000-8000-000000000001', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-2', 'RIN-2', 'ACCREC', 'PAID', 'Synthetic Client', 500.00, 550.00, '2035-06-03',
   '[{"Description": "Gate", "LineAmount": 500.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-3', 'RIN-3', 'ACCREC', 'AUTHORISED', 'Synthetic Client', 300.00, 330.00, '2035-06-04',
   NULL, '{"LineAmountTypes": "Exclusive"}', 'ba000000-0000-4000-8000-000000000009', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-4', 'RIN-4', 'ACCREC', 'PAID', 'Synthetic Client', 200.00, 220.00, '2035-06-05',
   '[{"Description": "Panels", "LineAmount": 150.00, "AccountCode": "200"}, {"Description": "Posts", "LineAmount": 100.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Exclusive"}', 'ba000000-0000-4000-8000-000000000001', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-5', 'RIN-5', 'ACCREC', 'AUTHORISED', 'Synthetic Client', 400.00, 440.00, '2035-06-06',
   '[{"Description": "Rails", "LineAmount": 350.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Exclusive"}', 'ba000000-0000-4000-8000-000000000001', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-D', 'RIN-6', 'ACCREC', 'DRAFT', 'Synthetic Client', 999.00, 1098.90, '2035-06-07',
   '[{"Description": "Draft", "LineAmount": 999.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Exclusive"}', 'ba000000-0000-4000-8000-000000000001', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-S', 'RIN-7', 'ACCREC', 'SUBMITTED', 'Synthetic Client', 111.00, 122.10, '2035-06-08',
   '[{"Description": "Submitted", "LineAmount": 111.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-V', 'RIN-8', 'ACCREC', 'VOIDED', 'Synthetic Client', 5000.00, 5500.00, '2035-06-09',
   '[{"Description": "Voided", "LineAmount": 5000.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Exclusive"}', 'ba000000-0000-4000-8000-000000000001', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'RI-BILL', 'RIN-9', 'ACCPAY', 'AUTHORISED', 'Synthetic Supplier', 700.00, 770.00, '2035-06-10',
   '[{"Description": "Steel", "LineAmount": 700.00, "AccountCode": "305"}]', '{"LineAmountTypes": "Exclusive"}', 'ba000000-0000-4000-8000-000000000001', '2035-10-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'RI2-1', 'RIN-10', 'ACCREC', 'AUTHORISED', 'Synthetic Other', 800.00, 880.00, '2035-06-11',
   '[{"Description": "Other org", "LineAmount": 800.00, "AccountCode": "200"}]', '{"LineAmountTypes": "Exclusive"}', 'ba000000-0000-4000-8000-000000000002', '2035-10-10T00:00:00Z');

CREATE FUNCTION pg_temp.srt_is(label text, got anyelement, want anyelement) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'xero spend revenue: %: %', label, COALESCE(got::text, 'null');
  END IF;
END $$;

DO $$
DECLARE
  o1 constant uuid := '00000000-0000-0000-0000-000000000001';
  o2 constant uuid := '00000000-0000-0000-0000-000000000002';
  d jsonb := public.xero_spend_revenue_monthly('2035-10-15', 7, o1);
  jun jsonb; jul jsonb; aug jsonb; sep jsonb; oct jsonb; may jsonb; s jsonb; r jsonb;
  fn regprocedure := 'public.xero_spend_revenue_monthly(date,integer,uuid)'::regprocedure;
BEGIN
  SELECT m INTO oct FROM jsonb_array_elements(d -> 'months') m WHERE m ->> 'month' = '2035-10';
  SELECT m INTO sep FROM jsonb_array_elements(d -> 'months') m WHERE m ->> 'month' = '2035-09';
  SELECT m INTO aug FROM jsonb_array_elements(d -> 'months') m WHERE m ->> 'month' = '2035-08';
  SELECT m INTO jul FROM jsonb_array_elements(d -> 'months') m WHERE m ->> 'month' = '2035-07';
  SELECT m INTO jun FROM jsonb_array_elements(d -> 'months') m WHERE m ->> 'month' = '2035-06';
  SELECT m INTO may FROM jsonb_array_elements(d -> 'months') m WHERE m ->> 'month' = '2035-05';

  PERFORM pg_temp.srt_is('months shown', jsonb_array_length(d -> 'months'), 7);
  PERFORM pg_temp.srt_is('newest month first', d -> 'months' -> 0 ->> 'month', '2035-10');
  PERFORM pg_temp.srt_is('from month', d ->> 'from_month', '2035-04-01');

  -- June spend: every dollar sorted once, by the account each line was coded to.
  s := jun -> 'spend';
  PERFORM pg_temp.srt_is('June spend status', s ->> 'status', 'partial');
  PERFORM pg_temp.srt_is('June spend transactions', (s ->> 'transactions')::int, 7);
  PERFORM pg_temp.srt_is('June spend with line detail', (s ->> 'with_line_detail')::int, 5);
  PERFORM pg_temp.srt_is('June spend total', (s ->> 'total_ex')::numeric, 575.26);
  PERFORM pg_temp.srt_is('June spend amount', (s ->> 'amount_ex')::numeric, 575.26);
  PERFORM pg_temp.srt_is('June direct cost', (s -> 'direct_cost' ->> 'ex')::numeric, 130.00);
  PERFORM pg_temp.srt_is('June overhead', (s ->> 'overhead_ex')::numeric, 70.00);
  PERFORM pg_temp.srt_is('June not a cost', (s ->> 'not_a_cost_ex')::numeric, 200.00);
  PERFORM pg_temp.srt_is('June income account', (s ->> 'income_account_ex')::numeric, 30.00);
  PERFORM pg_temp.srt_is('June account unknown', (s ->> 'account_unknown_ex')::numeric, 50.00);
  PERFORM pg_temp.srt_is('June account unknown lines', (s ->> 'account_unknown_lines')::int, 1);
  PERFORM pg_temp.srt_is('June no line detail', (s ->> 'no_line_detail_ex')::numeric, 95.25);
  PERFORM pg_temp.srt_is('June lines differ', (s ->> 'lines_differ_ex')::numeric, 0.01);
  PERFORM pg_temp.srt_is('June spend adds up', (s ->> 'parts_add_up')::boolean, true);
  PERFORM pg_temp.srt_is('June spend counted', (s ->> 'counted')::boolean, false);
  -- Direct cost spend is on no job, and says so: null with the reason, never 0.
  PERFORM pg_temp.srt_is('June direct cost on job is null', jsonb_typeof(s -> 'direct_cost' -> 'on_job_ex'), 'null');
  PERFORM pg_temp.srt_is('June direct cost on job reason', s -> 'direct_cost' ->> 'on_job', 'no_route_yet');
  PERFORM pg_temp.srt_is('June direct cost by tracking', s -> 'direct_cost' -> 'by_tracking',
    '[{"tracking": "SW - FENCING", "lines": 1, "ex": 100.00}, {"tracking": null, "lines": 1, "ex": 30.00}]'::jsonb);
  PERFORM pg_temp.srt_is('June by account', s -> 'by_account',
    '[{"code": "800", "name": "Vehicle loan", "kind": "not_a_cost", "lines": 1, "ex": 200.00},
      {"code": "305", "name": "Direct Material Cost", "kind": "direct_cost", "lines": 1, "ex": 100.00},
      {"code": "302", "name": "Fuel", "kind": "overhead", "lines": 1, "ex": 50.00},
      {"code": "999", "name": null, "kind": "account_unknown", "lines": 1, "ex": 50.00},
      {"code": "200", "name": "Sales", "kind": "income_account", "lines": 1, "ex": 30.00},
      {"code": "312", "name": "Materials stock", "kind": "direct_cost", "lines": 1, "ex": 30.00},
      {"code": "312", "name": "Tools (old)", "kind": "overhead", "lines": 1, "ex": 20.00}]'::jsonb);

  -- July: a transaction with no subtotal in the copy is counted as unknown, never as 0 that adds up.
  s := jul -> 'spend';
  PERFORM pg_temp.srt_is('July spend status', s ->> 'status', 'partial');
  PERFORM pg_temp.srt_is('July amount unknown', (s ->> 'amount_unknown_count')::int, 1);
  PERFORM pg_temp.srt_is('July overhead', (s ->> 'overhead_ex')::numeric, 10.00);
  PERFORM pg_temp.srt_is('July spend adds up', (s ->> 'parts_add_up')::boolean, false);

  -- August: fully read.
  s := aug -> 'spend';
  PERFORM pg_temp.srt_is('August spend status', s ->> 'status', 'read');
  PERFORM pg_temp.srt_is('August not a cost', (s ->> 'not_a_cost_ex')::numeric, 40.00);
  PERFORM pg_temp.srt_is('August direct cost', (s -> 'direct_cost' ->> 'ex')::numeric, 0::numeric);
  PERFORM pg_temp.srt_is('August spend adds up', (s ->> 'parts_add_up')::boolean, true);

  -- September: inside the copy, nothing spent.
  s := sep -> 'spend';
  PERFORM pg_temp.srt_is('September spend status', s ->> 'status', 'read');
  PERFORM pg_temp.srt_is('September spend amount', (s ->> 'amount_ex')::numeric, 0::numeric);
  PERFORM pg_temp.srt_is('September transactions', (s ->> 'transactions')::int, 0);

  -- October: transactions with no lines at all are not yet read: no sorted figure, the raw total still shown.
  s := oct -> 'spend';
  PERFORM pg_temp.srt_is('October spend status', s ->> 'status', 'not_yet_read');
  PERFORM pg_temp.srt_is('October spend amount is null', jsonb_typeof(s -> 'amount_ex'), 'null');
  PERFORM pg_temp.srt_is('October direct cost is null', jsonb_typeof(s -> 'direct_cost'), 'null');
  PERFORM pg_temp.srt_is('October overhead is null', jsonb_typeof(s -> 'overhead_ex'), 'null');
  PERFORM pg_temp.srt_is('October adds up is null', jsonb_typeof(s -> 'parts_add_up'), 'null');
  PERFORM pg_temp.srt_is('October raw total', (s ->> 'total_ex')::numeric, 60.00);
  PERFORM pg_temp.srt_is('October no line detail', (s ->> 'no_line_detail_ex')::numeric, 60.00);

  -- May: before the copy's first transaction. Unknown, never 0.
  s := may -> 'spend';
  PERFORM pg_temp.srt_is('May spend status', s ->> 'status', 'not_in_copy');
  PERFORM pg_temp.srt_is('May spend amount is null', jsonb_typeof(s -> 'amount_ex'), 'null');
  PERFORM pg_temp.srt_is('May raw total is null', jsonb_typeof(s -> 'total_ex'), 'null');
  PERFORM pg_temp.srt_is('May no line detail is null', jsonb_typeof(s -> 'no_line_detail_ex'), 'null');

  -- The copy's own facts.
  PERFORM pg_temp.srt_is('first transaction date', d -> 'spend_copy' ->> 'first_transaction_date', '2035-06-02');
  PERFORM pg_temp.srt_is('chart accounts', (d -> 'spend_copy' ->> 'chart_accounts')::int, 7);
  PERFORM pg_temp.srt_is('lines read at', (d -> 'spend_copy' ->> 'lines_read_at')::timestamptz, '2035-10-10T01:00:00Z'::timestamptz);
  PERFORM pg_temp.srt_is('copy synced at', (d -> 'spend_copy' ->> 'synced_at')::timestamptz, '2035-10-11T00:00:00Z'::timestamptz);

  -- June customer invoices against Job Profit's own rows.
  r := jun -> 'revenue';
  PERFORM pg_temp.srt_is('June invoices', (r ->> 'invoices')::int, 5);
  PERFORM pg_temp.srt_is('June revenue total', (r ->> 'total_ex')::numeric, 2400.00);
  PERFORM pg_temp.srt_is('June revenue on job', (r ->> 'on_job_ex')::numeric, 1600.00);
  PERFORM pg_temp.srt_is('June revenue holding job', (r ->> 'holding_job_ex')::numeric, 300.00);
  PERFORM pg_temp.srt_is('June revenue not on job', (r ->> 'not_on_job_ex')::numeric, 550.00);
  PERFORM pg_temp.srt_is('June revenue not on job invoices', (r ->> 'not_on_job_invoices')::int, 2);
  PERFORM pg_temp.srt_is('June revenue not on job share', (r ->> 'not_on_job_share')::numeric, 0.3542);
  PERFORM pg_temp.srt_is('June revenue over counted', (r -> 'over_counted' ->> 'ex')::numeric, 50.00);
  PERFORM pg_temp.srt_is('June revenue over counted invoices', (r -> 'over_counted' ->> 'invoices')::int, 1);
  PERFORM pg_temp.srt_is('June revenue drafts', (r -> 'not_counted' ->> 'draft_or_submitted_invoices')::int, 2);
  PERFORM pg_temp.srt_is('June revenue drafts ex', (r -> 'not_counted' ->> 'draft_or_submitted_ex')::numeric, 1110.00);
  PERFORM pg_temp.srt_is('June revenue adds up', (r ->> 'parts_add_up')::boolean, true);
  -- The same figure read straight from Job Profit's view, so the two cannot drift apart.
  PERFORM pg_temp.srt_is('June revenue on job against Job Profit',
    (r ->> 'on_job_ex')::numeric + (r ->> 'holding_job_ex')::numeric,
    (SELECT sum(e.amount_ex) FROM public.v_job_revenue_events e JOIN public.jobs j ON j.id = e.job_id
      WHERE e.kind = 'invoice_line' AND e.counts_as_invoiced AND j.org_id = o1
        AND e.invoice_date >= '2035-06-01' AND e.invoice_date < '2035-07-01'));
  -- A month with no invoices is zero and adds up.
  PERFORM pg_temp.srt_is('August revenue total', (aug -> 'revenue' ->> 'total_ex')::numeric, 0::numeric);
  PERFORM pg_temp.srt_is('August revenue share is null', jsonb_typeof(aug -> 'revenue' -> 'not_on_job_share'), 'null');
  PERFORM pg_temp.srt_is('August revenue adds up', (aug -> 'revenue' ->> 'parts_add_up')::boolean, true);

  -- Last six months (May to October): spend is summed over the months that were read, and says how many.
  PERFORM pg_temp.srt_is('six months from', d -> 'last_6_months' ->> 'from', '2035-05');
  PERFORM pg_temp.srt_is('six months revenue', (d -> 'last_6_months' ->> 'revenue_total_ex')::numeric, 2400.00);
  PERFORM pg_temp.srt_is('six months revenue not on job', (d -> 'last_6_months' ->> 'revenue_not_on_job_ex')::numeric, 850.00);
  PERFORM pg_temp.srt_is('six months revenue on job share', (d -> 'last_6_months' ->> 'revenue_on_job_share')::numeric, 0.6458);
  PERFORM pg_temp.srt_is('six months spend months read', (d -> 'last_6_months' ->> 'spend_months_read')::int, 4);
  PERFORM pg_temp.srt_is('six months spend', (d -> 'last_6_months' ->> 'spend_total_ex')::numeric, 615.26);
  PERFORM pg_temp.srt_is('six months direct cost', (d -> 'last_6_months' ->> 'spend_direct_cost_ex')::numeric, 130.00);

  -- Org 2 reads only its own rows, by its own chart: its account 305 is an expense there.
  d := public.xero_spend_revenue_monthly('2035-06-15', 1, o2);
  s := d -> 'months' -> 0 -> 'spend';
  PERFORM pg_temp.srt_is('org 2 June spend status', s ->> 'status', 'read');
  PERFORM pg_temp.srt_is('org 2 June overhead', (s ->> 'overhead_ex')::numeric, 70.00);
  PERFORM pg_temp.srt_is('org 2 June direct cost', (s -> 'direct_cost' ->> 'ex')::numeric, 0::numeric);
  PERFORM pg_temp.srt_is('org 2 June revenue on job', (d -> 'months' -> 0 -> 'revenue' ->> 'on_job_ex')::numeric, 800.00);
  PERFORM pg_temp.srt_is('org 2 lines read at is null', jsonb_typeof(d -> 'spend_copy' -> 'lines_read_at'), 'null');
  -- Every org together.
  d := public.xero_spend_revenue_monthly('2035-06-15', 1, NULL);
  PERFORM pg_temp.srt_is('all orgs June spend total', (d -> 'months' -> 0 -> 'spend' ->> 'total_ex')::numeric, 645.26);
  PERFORM pg_temp.srt_is('all orgs June overhead', (d -> 'months' -> 0 -> 'spend' ->> 'overhead_ex')::numeric, 140.00);
  PERFORM pg_temp.srt_is('all orgs June revenue', (d -> 'months' -> 0 -> 'revenue' ->> 'total_ex')::numeric, 3200.00);

  -- Who may use what: the service role only, for the function and both tables.
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'xero spend revenue: the function is not the service role''s only';
  END IF;
  IF has_table_privilege('anon', 'public.xero_bank_transaction_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.xero_bank_transaction_lines', 'SELECT')
     OR has_table_privilege('anon', 'public.xero_accounts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.xero_accounts', 'SELECT')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['public.xero_bank_transaction_lines', 'public.xero_accounts']) t(rel),
                               unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p(priv)
                 WHERE NOT has_table_privilege('service_role', t.rel, p.priv))
     OR has_table_privilege('service_role', 'public.xero_bank_transaction_lines', 'DELETE, TRUNCATE')
     OR has_table_privilege('service_role', 'public.xero_accounts', 'DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'xero spend revenue: the table grants are not select, insert and update for the service role only';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.xero_bank_transaction_lines'::regclass)
     OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.xero_accounts'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
                 AND p.tablename IN ('xero_bank_transaction_lines', 'xero_accounts')) THEN
    RAISE EXCEPTION 'xero spend revenue: row security is off or a policy opens one of the two tables';
  END IF;
  -- The lines never sit in the table browser roles can read.
  IF EXISTS (SELECT 1 FROM public.xero_bank_transactions t
              WHERE t.xero_txn_id LIKE 'SP%' AND t.line_items IS NOT NULL AND t.line_items <> '[]'::jsonb) THEN
    RAISE EXCEPTION 'xero spend revenue: a fixture put lines in xero_bank_transactions';
  END IF;
  BEGIN
    INSERT INTO public.xero_bank_transaction_lines (org_id, xero_txn_id, line_items) VALUES (o1, 'SP-BAD', '{"a": 1}');
    RAISE EXCEPTION 'xero spend revenue: a lines row that is not a list was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- With no chart of accounts, nothing can be sorted: every month in the copy is not yet read, with no sorted figure.
SAVEPOINT no_chart;
DELETE FROM public.xero_accounts;
DO $$
DECLARE d jsonb := public.xero_spend_revenue_monthly('2035-08-15', 3, '00000000-0000-0000-0000-000000000001');
  m jsonb;
BEGIN
  FOR m IN SELECT x FROM jsonb_array_elements(d -> 'months') x LOOP
    PERFORM pg_temp.srt_is('no chart: ' || (m ->> 'month') || ' status', m -> 'spend' ->> 'status', 'not_yet_read');
    PERFORM pg_temp.srt_is('no chart: ' || (m ->> 'month') || ' amount is null', jsonb_typeof(m -> 'spend' -> 'amount_ex'), 'null');
  END LOOP;
  PERFORM pg_temp.srt_is('no chart: six months spend is null', jsonb_typeof(d -> 'last_6_months' -> 'spend_total_ex'), 'null');
  PERFORM pg_temp.srt_is('no chart: revenue still read', (d -> 'months' -> 2 -> 'revenue' ->> 'total_ex')::numeric, 2400.00);
END $$;
ROLLBACK TO SAVEPOINT no_chart;

-- The service role can call it; a signed-in user cannot.
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF public.xero_spend_revenue_monthly('2035-06-15', 1, '00000000-0000-0000-0000-000000000001') -> 'months' -> 0 ->> 'month' <> '2035-06' THEN
    RAISE EXCEPTION 'xero spend revenue: the service role call did not answer';
  END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.xero_spend_revenue_monthly('2035-06-15', 1, NULL);
    RAISE EXCEPTION 'xero spend revenue: a signed-in user could call the function';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.xero_bank_transaction_lines LIMIT 1;
    RAISE EXCEPTION 'xero spend revenue: a signed-in user could read the lines';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

ROLLBACK;
