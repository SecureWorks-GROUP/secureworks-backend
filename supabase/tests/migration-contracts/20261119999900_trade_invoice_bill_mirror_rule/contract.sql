-- The one trade-invoice mirror rule. Everything below is rolled back.
BEGIN;
-- The repository declares trade_invoices.org_id NOT NULL with a default; the
-- rule still answers a row with none (a live row may have one). Rolled back.
ALTER TABLE public.trade_invoices ALTER COLUMN org_id DROP NOT NULL;
INSERT INTO public.trade_invoices (org_id, xero_bill_id, status, subtotal_ex, gst, total_inc, gst_on, super_rate,
  super_amount, gross_earned, net_pay, super_basis)
SELECT o::uuid, b, 'pushed_to_xero', 500, 0, 500, false, 0.12, 60, 500, 500, 'employer_12_v2'
FROM (VALUES
  ('00000000-0000-0000-0000-000000000001', 'ZZMIR-1'),     -- this org, exact
  ('00000000-0000-0000-0000-000000000001', '  zzmir-2 '),  -- this org, other case and spaces
  (NULL, 'ZZMIR-3'),                                       -- no org only
  ('00000000-0000-0000-0000-0000000000b2', 'ZZMIR-4'),     -- another org only
  ('00000000-0000-0000-0000-000000000001', 'ZZMIR-5'),     -- this org and no org
  (NULL, 'zzmir-5')) v(o, b);

-- 1. The verdicts: one row per input, in order, the id echoed as given.
DO $$
DECLARE org uuid := '00000000-0000-0000-0000-000000000001'; got text;
BEGIN
  SELECT string_agg(coalesce(bill_id, '<null>') || '=' || verdict, ',') INTO got
    FROM public.trade_invoice_bill_mirror_verdicts(org,
      ARRAY['ZZMIR-1', 'ZZMIR-2', ' Zzmir-3', 'ZZMIR-4', 'ZZMIR-5', 'ZZMIR-6', '', NULL, 'ZZMIR-1']);
  IF got IS DISTINCT FROM
     'ZZMIR-1=mirror,ZZMIR-2=mirror, Zzmir-3=stop,ZZMIR-4=none,ZZMIR-5=mirror,ZZMIR-6=none,=stop,<null>=stop,ZZMIR-1=mirror' THEN
    RAISE EXCEPTION 'mirror rule: verdicts wrong: %', got; END IF;
  -- No organisation asked: every bill is a stop.
  IF EXISTS (SELECT 1 FROM public.trade_invoice_bill_mirror_verdicts(NULL, ARRAY['ZZMIR-1', 'ZZMIR-6'])
             WHERE verdict <> 'stop') THEN
    RAISE EXCEPTION 'mirror rule: a null organisation was not a stop'; END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_bill_mirror_verdicts(org, ARRAY[]::text[])) THEN
    RAISE EXCEPTION 'mirror rule: no ids answered rows'; END IF;
END;
$$;

-- 2. Who may call it; how it is declared; its index.
DO $$
DECLARE f regprocedure := 'public.trade_invoice_bill_mirror_verdicts(uuid,text[])'::regprocedure;
BEGIN
  IF NOT has_function_privilege('service_role', f, 'EXECUTE')
     OR has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'mirror rule: execute grant wrong'; END IF;
  IF (SELECT prosecdef OR provolatile <> 's' OR NOT ('search_path=""' = ANY (proconfig)))
       FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'mirror rule: must be stable, invoker, with an empty search_path'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'trade_invoices'
      AND indexname = 'trade_invoices_xero_bill_key_idx'
      AND indexdef LIKE '%lower(btrim(xero_bill_id))%' AND indexdef LIKE '%WHERE (xero_bill_id IS NOT NULL)%') THEN
    RAISE EXCEPTION 'mirror rule: the bill key index is missing'; END IF;
END;
$$;

-- 3. The twin reads the rule: a case-different mirror is skipped, a bill held
--    only by a trade invoice with no organisation is stopped and not written,
--    and the rest of the page is still written.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_cost_lines_sync_v1';
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status,
  xero_contact_id, contact_name, sub_total, invoice_date, line_items, raw_json)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, id, id, 'ACCPAY', 'AUTHORISED', 'ZZMIR-crew', 'ZZMIR Crew',
  100, d::date, jsonb_build_array(jsonb_build_object('LineItemID', id || '-li', 'AccountCode', '300',
    'LineAmount', 100, 'TaxAmount', 10)), '{}'
FROM (VALUES ('ZZMIR-2', '2026-12-04'), ('ZZMIR-3', '2026-12-03'), ('ZZMIR-6', '2026-12-02')) v(id, d);
DO $$
DECLARE org uuid := '00000000-0000-0000-0000-000000000001'; r jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_cost_lines_sync_v1' AND enabled) THEN
    RAISE EXCEPTION 'mirror rule: the switch row is missing from the stack'; END IF;
  IF (SELECT count(*) FROM public.xero_invoices WHERE org_id = org AND invoice_type = 'ACCPAY'
      AND invoice_date BETWEEN '2026-12-02' AND '2026-12-04') <> 3 THEN
    RAISE EXCEPTION 'mirror rule: the stack holds other bills in the test window'; END IF;
  r := public.job_cost_lines_backfill_bills(org, '2026-12-02', '2026-12-04');
  IF r->>'ran' <> 'true' OR (r->>'bills_read')::int <> 3 OR (r->>'mirrors_skipped')::int <> 1
     OR (r->>'mirrors_stopped')::int <> 1 OR (r->>'documents')::int <> 1 OR NOT (r->>'done')::boolean THEN
    RAISE EXCEPTION 'mirror rule: twin page wrong: %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_kind = 'xero_bill'
             AND document_id IN ('ZZMIR-2', 'ZZMIR-3'))
     OR NOT EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_kind = 'xero_bill'
             AND document_id = 'ZZMIR-6') THEN
    RAISE EXCEPTION 'mirror rule: the twin wrote a mirrored or stopped bill, or skipped a plain one'; END IF;
  -- The replacement kept the twin's settings.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE oid = 'public.job_cost_lines_backfill_bills(uuid,date,date,integer,date,text)'::regprocedure
        AND 'lock_timeout=5s' = ANY (proconfig) AND 'search_path=""' = ANY (proconfig)) THEN
    RAISE EXCEPTION 'mirror rule: the twin lost its settings'; END IF;
  IF has_function_privilege('service_role',
       'public.job_cost_lines_backfill_bills(uuid,date,date,integer,date,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'mirror rule: the twin is no longer owner only'; END IF;
END;
$$;
ROLLBACK;
