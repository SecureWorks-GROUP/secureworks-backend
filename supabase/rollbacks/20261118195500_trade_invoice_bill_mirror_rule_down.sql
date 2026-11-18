-- Rollback of the mirror rule. Goes with the application code from before it:
-- the sync and the edge bills backfill call the verdict function.
-- Restores the 20261118195100 twin body exactly, then drops the rule and its index.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Put the 20261118195100 body back only over a body we know: this
-- migration's (md5 f621ae0baea131618a8e94d842bd210e) or the restored one
-- (046d042bb6851f1b950f8372992c591e, a re-run). Any other body, or no twin,
-- refuses before anything is changed.
DO $guard$
DECLARE h text;
BEGIN
  SELECT md5(p.prosrc) INTO h FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.job_cost_lines_backfill_bills(uuid,date,date,integer,date,text)');
  IF h IS NULL OR h NOT IN ('f621ae0baea131618a8e94d842bd210e', '046d042bb6851f1b950f8372992c591e') THEN
    RAISE EXCEPTION 'job_cost_lines_backfill_bills_body_changed';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.job_cost_lines_backfill_bills(
  p_org_id uuid, p_from date, p_to date, p_limit integer DEFAULT 200,
  p_before_date date DEFAULT NULL, p_before_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
-- A row-lock wait inside the writer (a sync writing the same bill) ends after
-- 5 s as lock_not_available, caught below as a clean busy stop.
SET lock_timeout = '5s'
AS $$
DECLARE
  super_on boolean; b record; doc jsonb; result jsonb;
  bills_read int := 0; mirrors int := 0; documents int := 0; lines_written int := 0;
  docs_changed int := 0; busy boolean := false;
  next_date date := p_before_date; next_id text := p_before_id;
BEGIN
  IF p_org_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from > p_to
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 200
     OR (p_before_date IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'bill_backfill_invalid_arguments: org, a from/to window, limit 1..200, and both cursor parts or neither';
  END IF;
  -- The edge action's two switches, read the same way. Nothing is turned on here.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
      WHERE flag_name = 'job_cost_lines_sync_v1' AND enabled) THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'switch_off');
  END IF;
  super_on := EXISTS (SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'job_cost_employer_super_v1' AND enabled);
  FOR b IN
    SELECT x.xero_invoice_id, x.invoice_date,
      EXISTS (SELECT 1 FROM public.trade_invoices t
        WHERE t.org_id = p_org_id AND t.xero_bill_id = x.xero_invoice_id) AS mirrored,
      jsonb_build_object('invoice_type', x.invoice_type, 'xero_invoice_id', x.xero_invoice_id,
        'status', x.status, 'invoice_number', x.invoice_number, 'invoice_date', x.invoice_date,
        'xero_contact_id', x.xero_contact_id, 'contact_name', x.contact_name,
        'fully_paid_on', x.fully_paid_on, 'line_items', x.line_items, 'sub_total', x.sub_total,
        'raw_json', jsonb_build_object('LineAmountTypes', x.raw_json->'LineAmountTypes')) AS bill
    FROM public.xero_invoices x
    WHERE x.org_id = p_org_id AND x.invoice_type = 'ACCPAY'
      AND x.invoice_date BETWEEN p_from AND p_to
      AND (p_before_date IS NULL OR (x.invoice_date, x.xero_invoice_id) < (p_before_date, p_before_id))
    ORDER BY x.invoice_date DESC, x.xero_invoice_id DESC
    LIMIT p_limit
  LOOP
    IF b.mirrored THEN
      mirrors := mirrors + 1;
    ELSE
      doc := public.job_cost_lines_bill_document(p_org_id, b.bill, super_on);
      BEGIN
        result := public.job_cost_lines_upsert_documents(jsonb_build_array(doc));
      EXCEPTION WHEN lock_not_available THEN
        -- The sync is writing this bill now: the writer's try-lock refused
        -- (cost_line_shadow_busy) or a row lock waited past lock_timeout. Stop
        -- here; the cursor stays before this bill so the next call starts with it.
        busy := true;
        EXIT;
      END;
      documents := documents + 1;
      lines_written := lines_written + coalesce((result->>'lines_written')::int, 0);
      docs_changed := docs_changed + coalesce(jsonb_array_length(result->'changed'), 0);
    END IF;
    bills_read := bills_read + 1;
    next_date := b.invoice_date; next_id := b.xero_invoice_id;
  END LOOP;
  RETURN jsonb_build_object('ran', true,
    'bills_read', bills_read, 'mirrors_skipped', mirrors, 'documents', documents,
    'lines_written', lines_written, 'documents_changed', docs_changed,
    'stopped', CASE WHEN busy THEN 'busy' END,
    -- done only on a short page that was not stopped. Otherwise call again with
    -- next_before (null next_before and done false means: from the window's top).
    'done', NOT busy AND bills_read < p_limit,
    'next_before', CASE WHEN NOT busy AND bills_read < p_limit THEN NULL
      WHEN next_date IS NULL THEN NULL
      ELSE jsonb_build_object('invoice_date', next_date, 'xero_invoice_id', next_id) END);
END;
$$;

REVOKE ALL ON FUNCTION public.job_cost_lines_backfill_bills(uuid, date, date, integer, date, text) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.trade_invoice_bill_mirror_verdicts(uuid, text[]);
DROP INDEX IF EXISTS public.trade_invoices_xero_bill_key_idx;
