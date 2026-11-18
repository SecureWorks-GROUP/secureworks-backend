-- Follow-up 66, director 00:00: the bills backfill's database twin.
-- PLACEHOLDER version: the keeper stamps the real number when the PR opens.
--
-- xero-sync's cost_lines_backfill (kind bills) is an edge action that needs the
-- service key, so the director cannot run it. This does the same from our synced
-- xero_invoices: supplier bills (ACCPAY) only, trade-mirrored bills skipped, every
-- write through job_cost_lines_upsert_documents, the one cost-line writer.
--
--   public.job_cost_lines_backfill_bills(org, from, to, limit<=200, before_date, before_id)
--     newest first inside the date window, keyset cursor (invoice_date, xero_invoice_id),
--     idempotent (an unchanged line is skipped by its source hash). Returns counts and
--     the next cursor. Reads job_cost_lines_sync_v1 and job_cost_employer_super_v1 as the
--     edge action does; turns no switch.
--   public.job_cost_lines_bill_document(org, bill, employer_super)
--     the SQL port of xero-sync cost_lines.ts billCostDocument. Arithmetic is in
--     double precision and numbers leave through float8's shortest text, as in the
--     edge code, so a line written by either side has the same source hash and a
--     second write is skipped. One fixture is checked on both sides
--     (job_cost_lines_bill_backfill_fixture.json).
--
-- Executable ONLY by the database owner: revoked from PUBLIC, anon, authenticated and
-- service_role. No timer, no trigger, no scan on a schedule. Locks no existing table
-- beyond what job_cost_lines_upsert_documents takes when called. Only function DDL.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- JavaScript Number(x ?? 0): SQL NULL and JSON null are 0, a blank string is 0,
-- a string that is not a number is NaN.
CREATE OR REPLACE FUNCTION public.job_cost_bill_number(p jsonb)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) = 'null' THEN 0::float8
    WHEN jsonb_typeof(p) = 'number' THEN (p #>> '{}')::float8
    WHEN jsonb_typeof(p) = 'boolean' THEN CASE WHEN (p #>> '{}')::boolean THEN 1::float8 ELSE 0::float8 END
    WHEN jsonb_typeof(p) = 'string' THEN CASE
      WHEN btrim(p #>> '{}', E' \t\n\r\f\v') = '' THEN 0::float8
      WHEN btrim(p #>> '{}', E' \t\n\r\f\v') ~ '^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$'
        THEN btrim(p #>> '{}', E' \t\n\r\f\v')::float8
      ELSE 'NaN'::float8 END
    ELSE 'NaN'::float8
  END
$$;

-- JSON.stringify of a number: shortest round-trip text; NaN and infinities are null.
CREATE OR REPLACE FUNCTION public.job_cost_bill_json(p double precision)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
SET extra_float_digits = 1
AS $$
  SELECT CASE WHEN p IS NULL OR p = 'NaN'::float8 OR p = 'Infinity'::float8 OR p = '-Infinity'::float8
    THEN 'null'::jsonb ELSE to_jsonb(p) END
$$;

CREATE OR REPLACE FUNCTION public.job_cost_lines_bill_document(
  p_org_id uuid, p_bill jsonb, p_employer_super boolean)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
SET extra_float_digits = 1
AS $$
DECLARE
  bill_id text := p_bill->>'xero_invoice_id';
  bill_status text := p_bill->>'status';
  stored jsonb; raw_lines jsonb; l jsonb; i int; parent jsonb;
  inclusive boolean; company_super float8 := 0; base_ex float8 := 0;
  amount float8; gst float8; account text; description text; installer boolean;
  lane text; line_key text; tracking jsonb; stated numeric;
  lines jsonb := '[]'; parents jsonb; a float8; y float8; f float8;
BEGIN
  -- billCostDocument returns null for anything but a supplier bill.
  IF p_bill->>'invoice_type' IS DISTINCT FROM 'ACCPAY' THEN RETURN NULL; END IF;
  stored := CASE WHEN jsonb_typeof(p_bill->'line_items') = 'array' THEN p_bill->'line_items' ELSE '[]'::jsonb END;
  raw_lines := CASE WHEN jsonb_array_length(stored) > 0 THEN stored ELSE jsonb_build_array(
    jsonb_build_object('_header_ex', coalesce(p_bill->'sub_total', 'null'::jsonb),
      'Description', 'Bill total (no lines stored)')) END;
  inclusive := (p_bill->'raw_json'->>'LineAmountTypes') IS NOT DISTINCT FROM 'Inclusive';
  -- The crew bill's withheld super line and the company contribution it states.
  FOR l IN SELECT value FROM jsonb_array_elements(stored) LOOP
    IF public.job_cost_super_withheld_line(l) THEN
      stated := public.job_cost_super_company_contribution(l);
      IF stated IS NOT NULL THEN company_super := company_super + stated::float8; END IF;
    ELSE
      base_ex := base_ex + (public.job_cost_bill_number(l->'LineAmount')
        - CASE WHEN inclusive THEN public.job_cost_bill_number(l->'TaxAmount') ELSE 0::float8 END);
    END IF;
  END LOOP;
  -- Numbering counts every stored line, the skipped ones too (n:<i>, line_no).
  FOR l, i IN SELECT value, ordinality::int FROM jsonb_array_elements(raw_lines) WITH ORDINALITY LOOP
    IF public.job_cost_super_withheld_line(l) THEN CONTINUE; END IF;
    gst := public.job_cost_bill_number(l->'TaxAmount');
    IF l ? '_header_ex' THEN
      amount := CASE WHEN jsonb_typeof(l->'_header_ex') = 'null' THEN NULL
        ELSE public.job_cost_bill_number(l->'_header_ex') END;
    ELSE
      amount := public.job_cost_bill_number(l->'LineAmount')
        - CASE WHEN inclusive THEN public.job_cost_bill_number(l->'TaxAmount') ELSE 0::float8 END;
    END IF;
    IF amount = 0::float8 THEN CONTINUE; END IF;
    account := CASE WHEN jsonb_typeof(l->'AccountCode') IN ('string','number','boolean') THEN l->>'AccountCode' END;
    description := CASE WHEN jsonb_typeof(l->'Description') IN ('string','number','boolean') THEN l->>'Description' END;
    installer := coalesce(account, '') IN ('306', '301');
    lane := CASE WHEN coalesce(description, '') ~* 'commission' THEN 'commission'
      WHEN installer THEN 'labour'
      WHEN coalesce(account, '') ~ '^3[0-9]{2}$' THEN 'materials'
      ELSE 'other' END;
    tracking := CASE WHEN jsonb_typeof(l->'Tracking') = 'array'
      THEN coalesce(l->'Tracking'->0->'Option', 'null'::jsonb) ELSE 'null'::jsonb END;
    line_key := CASE
      WHEN jsonb_typeof(l->'LineItemID') = 'string' AND l->>'LineItemID' <> '' THEN l->>'LineItemID'
      WHEN jsonb_typeof(l->'LineItemID') = 'number' AND (l->>'LineItemID')::numeric <> 0 THEN l->>'LineItemID'
      ELSE 'n:' || i END;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'line_key', line_key, 'line_no', i,
      'kind', CASE WHEN installer THEN 'installer_bill' ELSE 'supplier_bill' END,
      'description', description, 'account_code', account, 'xero_tracking_option', tracking,
      'lane', lane, 'event_lane_detail', lane,
      'amount_ex', public.job_cost_bill_json(amount), 'gst', public.job_cost_bill_json(gst),
      'is_actual', true, 'paid', coalesce(bill_status, '') = 'PAID',
      'paid_on', coalesce(p_bill->'fully_paid_on', 'null'::jsonb),
      'event_source', 'supplier_bill', 'event_source_id', coalesce(bill_id, 'null') || ':' || i));
  END LOOP;
  -- The company's share of crew super, spread over the bill's lines (roundSix).
  IF p_employer_super AND company_super > 0.005::float8 AND base_ex > 0::float8
     AND coalesce(bill_status, '') IN ('AUTHORISED', 'PAID') THEN
    parents := lines;
    FOR parent IN SELECT value FROM jsonb_array_elements(parents) LOOP
      IF jsonb_typeof(parent->'amount_ex') IS DISTINCT FROM 'number' THEN CONTINUE; END IF;
      a := (parent->>'amount_ex')::float8 * company_super / base_ex;
      y := (abs(a) + 2.220446049250313e-16::float8) * 1e6::float8;
      f := floor(y);
      IF y - f >= 0.5::float8 THEN f := f + 1::float8; END IF;
      lines := lines || jsonb_build_array(parent || jsonb_build_object(
        'kind', 'employer_super',
        'line_key', (parent->>'line_key') || ':employer_super',
        'follows_line_key', parent->>'line_key',
        'amount_ex', public.job_cost_bill_json(sign(a) * f / 1e6::float8),
        'gst', 0, 'paid', false, 'paid_on', NULL::jsonb,
        'event_source', 'bill_employer_super',
        'event_source_id', (parent->>'event_source_id') || ':employer_super',
        'event_lane_detail', 'employer_super',
        'description', 'Employer super on: ' || coalesce(parent->>'description', '')));
    END LOOP;
  END IF;
  RETURN jsonb_build_object(
    'org_id', p_org_id, 'document_kind', 'xero_bill', 'document_id', bill_id,
    'document_number', coalesce(p_bill->'invoice_number', 'null'::jsonb),
    'document_date', CASE WHEN jsonb_typeof(p_bill->'invoice_date') = 'string'
      THEN to_jsonb(left(p_bill->>'invoice_date', 10)) ELSE 'null'::jsonb END,
    'document_status', coalesce(p_bill->'status', 'null'::jsonb),
    'live', coalesce(bill_status, '') IN ('AUTHORISED', 'PAID'),
    'party_kind', 'supplier',
    'party_id', coalesce(p_bill->'xero_contact_id', 'null'::jsonb),
    'party_name', coalesce(p_bill->'contact_name', 'null'::jsonb),
    'lines', lines);
END;
$$;

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

REVOKE ALL ON FUNCTION public.job_cost_bill_number(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.job_cost_bill_json(double precision) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.job_cost_lines_bill_document(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.job_cost_lines_backfill_bills(uuid, date, date, integer, date, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.job_cost_lines_backfill_bills(uuid, date, date, integer, date, text) IS
  'Follow-up 66: the database twin of xero-sync cost_lines_backfill (bills). Supplier bills from xero_invoices, trade-mirrored skipped, newest first in a date window, at most 200 a call, through job_cost_lines_upsert_documents. Database owner only.';
COMMENT ON FUNCTION public.job_cost_lines_bill_document(uuid, jsonb, boolean) IS
  'SQL port of xero-sync cost_lines.ts billCostDocument, same numbers and source hash. Database owner only.';
