-- People accounts (director ruling, 19 Nov 2026 03:07): a cost document with
-- ANY line on a people account is a person's pay and is treated like labour
-- everywhere the Reconcile list and the matcher look. Two live bills sit on
-- account 475 (internal subcontractors): labour billed outside the Trade App on
-- an account that is not 301 or 306, so the list would have shown them.
-- PLACEHOLDER version: the keeper stamps the real one when the PR is marked ready.
--
-- 1. public.people_account_codes: the ONE set of people accounts (301, 306,
--    475), one row per Xero account code. Seeded only when this migration
--    creates the table, so a re-apply never puts back a row the owner removed.
--    The owner's answer changes one row; no code change. Read by the two list
--    functions and the cost-line twin below, and through
--    _shared/people_accounts.ts by every edge reader that held 301 and 306 in
--    code: xero-sync's cost lines, materials ingest, bill prematch, matcher and
--    credit step, and ops-api's manual landing lane and Reconcile list. RLS on
--    with no policy, revoked from everyone but SELECT to service_role; the list
--    functions read it as their owner (SECURITY DEFINER).
-- 2. reconcile_list_page and reconcile_list_counts (20261118195400): a
--    document with a line on a people account is left out exactly as a
--    document with a line of kind installer_bill is, and so is a credit that
--    follows such a bill. An open item already raised for such a document is
--    hidden by the same rule; no item is closed or written.
-- 3. job_cost_lines_bill_document (20261118195100), the database twin of
--    xero-sync's billCostDocument: a line on a people account is an installer
--    line in the labour lane, as the edge now reads it. STABLE now (it reads
--    the table); an empty set raises rather than costing pay as supplies.
--
-- No index: the account set is a few rows; a document's lines are found
-- through job_cost_lines_document_idx as before. No switch, no data write
-- beyond the seed, no schedule. Same signatures, grants and comment prefix
-- (20261118195200 re-applies on that prefix).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE f record;
BEGIN
  IF to_regprocedure('public.reconcile_list_page(uuid,text[],integer,jsonb)') IS NULL
     OR to_regprocedure('public.reconcile_list_counts(uuid)') IS NULL
     OR to_regprocedure('public.job_cost_lines_bill_document(uuid,jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'reconcile_people_accounts: reconcile_list (20261118195200) or the cost-line twin (20261118195100) is missing';
  END IF;
  -- Pre-image: each body is 20261118195400's (live), or this migration's own (re-apply).
  FOR f IN SELECT p.oid::regprocedure::text sig, md5(p.prosrc) body FROM pg_proc p
    WHERE p.oid IN ('public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure,
                    'public.reconcile_list_counts(uuid)'::regprocedure)
  LOOP
    IF (f.sig, f.body) NOT IN (
      ('reconcile_list_page(uuid,text[],integer,jsonb)', '8c9e154df84031b3ae8620953c67c841'),
      ('reconcile_list_page(uuid,text[],integer,jsonb)', '6cb7df0b5a2f7cd7d6ebcb4c2568e895'),
      ('reconcile_list_counts(uuid)', '377ee4c6d4f4d5ae66b070dc31748f44'),
      ('reconcile_list_counts(uuid)', '1657ff4926ebae986c2cea784c20cdd4')) THEN
      RAISE EXCEPTION 'reconcile_people_accounts: % body changed', f.sig;
    END IF;
  END LOOP;
  -- The cost-line twin (job_cost_lines_bill_document) is 20261118195100's body
  -- (main) or this migration's own (re-apply).
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)'::regprocedure)
       NOT IN ('534760eeda42dd472aa643ac27e90368', '357e86405fe1820f9446e49b43dfd55b') THEN
    RAISE EXCEPTION 'reconcile_people_accounts: job_cost_lines_bill_document(uuid,jsonb,boolean) body changed';
  END IF;
  -- A table of this name that is not this one refuses rather than being read as the set.
  IF to_regclass('public.people_account_codes') IS NOT NULL AND (
       SELECT array_agg(attname::text ORDER BY attname::text) FROM pg_attribute
       WHERE attrelid = to_regclass('public.people_account_codes') AND attnum > 0 AND NOT attisdropped)
     IS DISTINCT FROM ARRAY['account_code','added_at','note'] THEN
    RAISE EXCEPTION 'reconcile_people_accounts: people_account_codes is not this migration''s table';
  END IF;
END
$guard$;

DO $table$
BEGIN
  IF to_regclass('public.people_account_codes') IS NULL THEN
    CREATE TABLE public.people_account_codes (
      account_code text PRIMARY KEY
        CHECK (account_code = btrim(account_code) AND account_code <> ''),
      note text NOT NULL CHECK (btrim(note) <> ''),
      added_at timestamptz NOT NULL DEFAULT now()
    );
    -- Seeded only here, at creation: a re-apply never restores a removed row.
    INSERT INTO public.people_account_codes (account_code, note) VALUES
      ('301', 'Installer labour'),
      ('306', 'Installer labour'),
      ('475', 'Admin (Internal Subcontractors)');
  END IF;
END
$table$;

ALTER TABLE public.people_account_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.people_account_codes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.people_account_codes TO service_role;
COMMENT ON TABLE public.people_account_codes IS
  'People accounts: a cost document with any line on one of these Xero account codes is a person''s pay. The Reconcile list leaves it out and the matcher and credit step skip it. One row per code; the owner''s answer changes a row, not code.';

CREATE OR REPLACE FUNCTION public.reconcile_list_page(
  p_org uuid, p_kinds text[], p_limit integer, p_after jsonb DEFAULT NULL)
RETURNS TABLE (
  id uuid, kind text, subject_table text, subject_id text, job_ids uuid[],
  reason text, amount_ex numeric, document_date date, summary jsonb,
  suggestion jsonb, evidence jsonb, evidence_hash text, raised_at timestamptz,
  snooze_until timestamptz, snoozed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  WITH cur AS (
    SELECT p_after IS NOT NULL AS has,
      coalesce((p_after->>'snoozed')::boolean, false) AS s,
      (p_after->>'amount_ex')::numeric AS a,
      (p_after->>'raised_at')::timestamptz AS r,
      (p_after->>'id')::uuid AS i,
      least(greatest(coalesce(p_limit, 50), 1), 100) + 1 AS n
  ), awake AS (
    SELECT t.id, t.kind, t.subject_table, t.subject_id, t.job_ids, t.reason,
      t.amount_ex, t.document_date, t.summary, t.suggestion, t.evidence,
      t.evidence_hash, t.raised_at, t.snooze_until, false AS snoozed
    FROM public.reconcile_items t, cur
    WHERE t.org_id = p_org AND t.status = 'open' AND t.kind = ANY(p_kinds)
      AND t.reason <> 'installer_bill_outside_app'
      AND NOT EXISTS (SELECT FROM public.job_cost_lines l
        WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
          AND l.document_kind = split_part(t.subject_id, ':', 1)
          AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND (l.kind = 'installer_bill' OR btrim(l.account_code) IN (SELECT a.account_code FROM public.people_account_codes a)))
      AND NOT EXISTS (SELECT FROM public.job_cost_lines c
        LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
        JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND (p.kind = 'installer_bill' OR btrim(p.account_code) IN (SELECT a.account_code FROM public.people_account_codes a))
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
        WHERE t.subject_table = 'cost_document'
          AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
          AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
          AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
      AND (t.snooze_until IS NULL OR t.snooze_until <= now())
      AND NOT cur.s
      AND (NOT cur.has OR CASE WHEN cur.a IS NULL
        THEN t.amount_ex IS NULL AND (t.raised_at, t.id) > (cur.r, cur.i)
        ELSE t.amount_ex < cur.a OR t.amount_ex IS NULL
          OR (t.amount_ex = cur.a AND (t.raised_at, t.id) > (cur.r, cur.i)) END)
    ORDER BY t.amount_ex DESC NULLS LAST, t.raised_at, t.id
    LIMIT (SELECT n FROM cur)
  ), asleep AS (
    SELECT t.id, t.kind, t.subject_table, t.subject_id, t.job_ids, t.reason,
      t.amount_ex, t.document_date, t.summary, t.suggestion, t.evidence,
      t.evidence_hash, t.raised_at, t.snooze_until, true AS snoozed
    FROM public.reconcile_items t, cur
    WHERE t.org_id = p_org AND t.status = 'open' AND t.kind = ANY(p_kinds)
      AND t.reason <> 'installer_bill_outside_app'
      AND NOT EXISTS (SELECT FROM public.job_cost_lines l
        WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
          AND l.document_kind = split_part(t.subject_id, ':', 1)
          AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND (l.kind = 'installer_bill' OR btrim(l.account_code) IN (SELECT a.account_code FROM public.people_account_codes a)))
      AND NOT EXISTS (SELECT FROM public.job_cost_lines c
        LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
        JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND (p.kind = 'installer_bill' OR btrim(p.account_code) IN (SELECT a.account_code FROM public.people_account_codes a))
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
        WHERE t.subject_table = 'cost_document'
          AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
          AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
          AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
      AND t.snooze_until > now()
      AND (NOT cur.s OR CASE WHEN cur.a IS NULL
        THEN t.amount_ex IS NULL AND (t.raised_at, t.id) > (cur.r, cur.i)
        ELSE t.amount_ex < cur.a OR t.amount_ex IS NULL
          OR (t.amount_ex = cur.a AND (t.raised_at, t.id) > (cur.r, cur.i)) END)
    ORDER BY t.amount_ex DESC NULLS LAST, t.raised_at, t.id
    LIMIT (SELECT n FROM cur)
  )
  SELECT * FROM (SELECT * FROM awake UNION ALL SELECT * FROM asleep) x
  ORDER BY x.snoozed, x.amount_ex DESC NULLS LAST, x.raised_at, x.id
  LIMIT (SELECT n FROM cur)
$fn$;

COMMENT ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb) IS
  'Reconcile list (P2-03.6): one page of an org''s open items, not snoozed first; a document with a person''s labour line or a line on a people account (people_account_codes), and a credit that follows one, left out. Read only.';

-- Open items per kind for one org: the tab counts. Same WHERE as a page
-- without the kind and cursor filters, so a count never promises an item the
-- list withholds (labour billed outside the Trade App, a document with a
-- labour line or a line on a people account, a credit that follows one).
CREATE OR REPLACE FUNCTION public.reconcile_list_counts(p_org uuid)
RETURNS TABLE (kind text, open bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT t.kind, count(*) FROM public.reconcile_items t
  WHERE t.org_id = p_org AND t.status = 'open'
    AND t.reason <> 'installer_bill_outside_app'
    AND NOT EXISTS (SELECT FROM public.job_cost_lines l
      WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
        AND l.document_kind = split_part(t.subject_id, ':', 1)
        AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
        AND (l.kind = 'installer_bill' OR btrim(l.account_code) IN (SELECT a.account_code FROM public.people_account_codes a)))
    AND NOT EXISTS (SELECT FROM public.job_cost_lines c
      LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
      JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND (p.kind = 'installer_bill' OR btrim(p.account_code) IN (SELECT a.account_code FROM public.people_account_codes a))
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
      WHERE t.subject_table = 'cost_document'
        AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
        AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
        AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
        AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
  GROUP BY t.kind ORDER BY t.kind COLLATE "C"
$fn$;

COMMENT ON FUNCTION public.reconcile_list_counts(uuid) IS
  'Reconcile list (P2-03.6): open items per kind for one org, with the same items left out as a page. Read only.';

REVOKE ALL ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) TO service_role;

-- 3. The cost-line twin (20261118195100): a line on a people account is an
--    installer line, as xero-sync cost_lines.ts now reads it. STABLE, since it
--    reads the table; grants are unchanged (owner only).
CREATE OR REPLACE FUNCTION public.job_cost_lines_bill_document(
  p_org_id uuid, p_bill jsonb, p_employer_super boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
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
  -- The one set of people accounts (people_account_codes), as the edge reads it:
  -- an empty set refuses, never "nobody is a person".
  IF NOT EXISTS (SELECT FROM public.people_account_codes) THEN
    RAISE EXCEPTION 'people_accounts_empty';
  END IF;
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
    installer := btrim(coalesce(account, '')) IN (SELECT pa.account_code FROM public.people_account_codes pa);
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
