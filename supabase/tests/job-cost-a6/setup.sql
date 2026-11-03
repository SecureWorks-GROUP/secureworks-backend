-- Job Profit A6 cost rules: the production surface v_job_cost_events reads, as read from production on
-- 3 Nov 2026 (column names and types from pg_attribute; functions and the two views from pg_get_functiondef and
-- pg_get_viewdef). Two views are tables here (v_trade_charge_resolved, v_invoice_line_completeness): the cost
-- view reads only their columns. The cost view is production's 20261103224500 definition with 20261104063000
-- (A4 V8) applied, the definition these migrations are guarded on (md5 33d1c54d5a288fe496b5b863a1ec1d4c).
\set ON_ERROR_STOP on
SET client_min_messages = warning;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE public.organisations (
  id uuid,
  name text,
  abn text,
  phone text,
  email text,
  logo_url text,
  settings_json jsonb,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  PRIMARY KEY (id)
);
CREATE TABLE public.jobs (
  id uuid,
  org_id uuid,
  created_by uuid,
  status text,
  type text,
  client_name text,
  client_phone text,
  client_email text,
  site_address text,
  site_suburb text,
  site_lat double precision,
  site_lng double precision,
  scope_json jsonb,
  pricing_json jsonb,
  notes text,
  ghl_contact_id text,
  quoted_at timestamp with time zone,
  accepted_at timestamp with time zone,
  scheduled_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  ghl_opportunity_id text,
  job_number text,
  xero_contact_id text,
  xero_quote_id text,
  deposit_invoice_id text,
  deposit_amount numeric(12,2),
  legacy boolean,
  satisfaction_rating integer,
  scope_version integer,
  scope_updated_at timestamp with time zone,
  callback_parent_id uuid,
  is_callback boolean,
  cross_sell_flags jsonb,
  cross_sell_source_job_id uuid,
  approvals_at timestamp with time zone,
  deposit_at timestamp with time zone,
  processing_at timestamp with time zone,
  archived boolean,
  payment_terms text,
  council_required boolean,
  metadata jsonb,
  expected_costs jsonb,
  expected_frozen_at timestamp with time zone,
  quoted_value numeric,
  ses_money_sealed_at timestamp with time zone,
  ses_money_seal_source text,
  ses_money_seal_version integer,
  send_runs_claimed_at timestamp with time zone,
  xero_contact_address_checked_at timestamp with time zone,
  work_order_id uuid,
  review_opt_out boolean,
  review_opt_out_at timestamp with time zone,
  review_opt_out_by text
);
CREATE TABLE public.users (
  id uuid,
  org_id uuid,
  name text,
  email text,
  phone text,
  role text,
  avatar_url text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  xero_contact_id text,
  abn text,
  telegram_id bigint,
  hourly_rate numeric(8,2),
  telegram_username text,
  invoice_type text,
  trade_tier integer,
  default_hourly_rate numeric(8,2),
  payment_terms_days integer,
  trade_details jsonb,
  makesafe_manager boolean,
  managed_verticals text[],
  trade_sees_all_jobs boolean,
  PRIMARY KEY (id)
);
CREATE TABLE public.feature_flags (
  id uuid,
  flag_name text,
  enabled boolean,
  description text,
  updated_at timestamp with time zone,
  UNIQUE (flag_name)
);
CREATE TABLE public.xero_invoices (
  id uuid,
  org_id uuid,
  xero_invoice_id text,
  xero_contact_id text,
  contact_name text,
  invoice_number text,
  invoice_type text,
  status text,
  reference text,
  currency_code text,
  sub_total numeric(12,2),
  total_tax numeric(12,2),
  total numeric(12,2),
  amount_due numeric(12,2),
  amount_paid numeric(12,2),
  invoice_date date,
  due_date date,
  fully_paid_on date,
  line_items jsonb,
  job_id uuid,
  raw_json jsonb,
  synced_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  quote_document_ids uuid[],
  run_label text,
  debt_classification text,
  debt_classification_reason text,
  debt_classified_by text,
  debt_classified_at timestamp with time zone,
  spine_event_id uuid,
  job_number text,
  customer_name text,
  suburb text,
  division text,
  account_code text,
  tracking_option text,
  xero_project_manual_status text,
  quote_revision_id uuid,
  scope_revision_id uuid,
  job_contact_id uuid,
  reference_suffix text,
  invoice_obligation_revision_id uuid,
  ses_external_token text,
  reference_normalized text,
  reconcile_attempted_at timestamp with time zone,
  reconcile_last_error text,
  debt_type text,
  debt_blocker text,
  debt_owner text,
  debt_next_action text,
  debt_next_action_at date,
  debt_void_proposed boolean,
  debt_void_decision text,
  debt_void_decided_at timestamp with time zone,
  debt_handoff_ref text,
  debt_handoff_at date,
  debt_source text,
  debt_as_of timestamp with time zone,
  debt_brief jsonb,
  debt_proposal_kind text,
  debt_proposal_text text,
  debt_proposal_to text,
  debt_proposal_at timestamp with time zone,
  debt_proposal_status text,
  debt_proposal_approved_by text,
  debt_proposal_approved_at timestamp with time zone,
  debt_proposal_sent_ref text,
  job_linked_at timestamp with time zone
);
CREATE TABLE public.trade_invoices (
  id uuid,
  org_id uuid,
  user_id uuid,
  week_start date,
  week_end date,
  total_hours numeric(6,2),
  total_breaks_minutes integer,
  subtotal_ex numeric(10,2),
  gst numeric(10,2),
  total_inc numeric(10,2),
  status text,
  has_manual_overrides boolean,
  override_details jsonb,
  xero_bill_id text,
  xero_pushed_at timestamp with time zone,
  submitted_at timestamp with time zone,
  acknowledged_at timestamp with time zone,
  acknowledged_by uuid,
  queried_at timestamp with time zone,
  query_note text,
  created_at timestamp with time zone,
  notes text,
  invoice_number text,
  work_order_id uuid,
  invoice_source text,
  gst_on boolean,
  super_rate numeric(7,6),
  super_amount numeric(12,2),
  gross_earned numeric(12,2),
  net_pay numeric(12,2),
  job_grand_total_ex numeric(12,2),
  final_deductions_total_ex numeric(12,2),
  to_be_paid_ex numeric(12,2),
  paid_at date,
  amount_paid numeric(12,2),
  xero_bill_status text,
  pdf_backfill_attempts integer,
  pdf_backfill_last_error text,
  recurring_deduction_id uuid,
  recurring_deduction_label text,
  recurring_deduction_amount numeric(12,2),
  recurring_deduction_note text,
  draft_builder jsonb,
  draft_origin text,
  created_by_agent boolean,
  agent_label text,
  dismissed_source_keys text[],
  draft_pay_unconfirmed boolean,
  super_basis text,
  xero_bill_total numeric(12,2),
  xero_adjustments_ex numeric(12,2),
  xero_adjustment_lines jsonb
);
CREATE TABLE public.v_trade_charge_resolved (
  line_id uuid,
  resolved_job_id uuid,
  attributed_direct boolean,
  trade_invoice_id uuid,
  user_id uuid,
  week_start date,
  invoice_status text,
  xero_bill_id text,
  line_type text,
  description text,
  total_hours numeric(6,2),
  hourly_rate numeric(8,2),
  line_total_ex numeric(10,2),
  line_date date,
  division text,
  cost_lane text,
  match_method text,
  is_probable_test_line boolean,
  exclusion_reason text,
  flag_type text,
  baseline_hours numeric,
  baseline_source text,
  hours_justification text,
  flagged_at timestamp with time zone,
  is_hours_flagged boolean
);
CREATE TABLE public.v_invoice_line_completeness (
  trade_invoice_id uuid,
  user_id uuid,
  week_start date,
  subtotal_ex numeric(10,2),
  lines_total_ex numeric,
  line_count bigint,
  zero_line boolean,
  mismatch boolean
);
CREATE TABLE public.job_materials_facts (
  id uuid DEFAULT gen_random_uuid(),
  org_id uuid,
  xero_invoice_id text,
  invoice_number text,
  xero_contact_id text,
  contact_name text,
  job_id uuid,
  job_number text,
  lane text,
  kind text,
  amount_ex_gst numeric,
  amount_inc_gst numeric,
  confidence text,
  automation_source text,
  matched_po_id uuid,
  match_reason text,
  fact_date date,
  assigned_by text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
CREATE TABLE public.materials_reconciliation_queue (
  id uuid,
  org_id uuid,
  xero_invoice_id text,
  xero_contact_id text,
  contact_name text,
  invoice_number text,
  sub_total numeric,
  total numeric,
  invoice_date date,
  suggested_job_id uuid,
  suggested_job_number text,
  suggestion_confidence text,
  suggestion_reason text,
  status text,
  assigned_job_id uuid,
  assigned_by text,
  assigned_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  closed_reason text,
  overhead_ex numeric(12,2),
  overhead_note text
);
CREATE TABLE public.purchase_orders (
  id uuid,
  org_id uuid,
  job_id uuid,
  po_number text,
  supplier_name text,
  xero_contact_id text,
  status text,
  line_items jsonb,
  subtotal numeric(12,2),
  tax numeric(12,2),
  total numeric(12,2),
  delivery_date date,
  reference text,
  notes text,
  xero_po_id text,
  synced_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  invoice_received_at timestamp with time zone,
  paid_at timestamp with time zone,
  xero_bill_id text,
  delivery_confirmed_at timestamp with time zone,
  confirmed_delivery_date date,
  po_type text,
  quote_revision_id uuid,
  quote_builder_version_id uuid,
  supplier_id uuid,
  source text,
  created_by_email text,
  pdf_path text,
  pdf_sha256 text,
  pdf_version integer,
  pdf_rendered_at timestamp with time zone,
  last_sent_pdf_version integer,
  last_sent_at timestamp with time zone,
  confirmed_delivery_set_at timestamp with time zone,
  confirmed_delivery_set_by uuid,
  confirmed_delivery_set_by_email text,
  delivery_sighted_at timestamp with time zone,
  delivery_sighted_by uuid,
  delivery_sighted_by_email text
);
CREATE TABLE public.job_order_emails (
  id uuid,
  org_id uuid,
  job_id uuid,
  purchase_order_id uuid,
  supplier_id uuid,
  kind text,
  status text,
  subject text,
  body_text text,
  body_generated_sha text,
  pdf_version integer,
  pdf_path text,
  pdf_sha256 text,
  line_count integer,
  order_lines jsonb,
  to_email_sent text,
  attempt_to_email text,
  attempt_in_reply_to text,
  send_attempt integer,
  last_error text,
  communication_id uuid,
  resend_id text,
  sent_at timestamp with time zone,
  sent_by uuid,
  sent_by_email text,
  sent_via text,
  discarded_at timestamp with time zone,
  discarded_by_email text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  created_by uuid,
  created_by_email text
);
CREATE TABLE public.xero_supplier_credit_notes (
  org_id uuid,
  xero_credit_note_id text,
  credit_note_type text,
  credit_note_number text,
  xero_contact_id text,
  contact_name text,
  reference text,
  credit_note_date date,
  status text,
  line_amount_types text,
  currency_code text,
  sub_total numeric(14,2),
  total_tax numeric(14,2),
  total numeric(14,2),
  remaining_credit numeric(14,2),
  fully_paid_on date,
  allocations_returned boolean,
  xero_updated_at timestamp with time zone,
  raw_json jsonb,
  synced_at timestamp with time zone,
  PRIMARY KEY (org_id, xero_credit_note_id)
);
CREATE TABLE public.xero_supplier_credit_note_allocations (
  org_id uuid,
  xero_credit_note_id text,
  n integer,
  allocation_id text,
  xero_invoice_id text,
  invoice_number text,
  amount numeric(14,2),
  allocation_date date,
  is_deleted boolean DEFAULT false,
  raw_json jsonb
);
CREATE TABLE public.bookkeeping_evidence_revisions (
  revision text,
  stream text,
  revision_no integer,
  schema text,
  producer text,
  emitted_at timestamp with time zone,
  sha256 text,
  supersedes text,
  facts_in_file integer,
  facts_sent integer,
  rows_loaded integer DEFAULT 0,
  status text DEFAULT 'loading'::text,
  rule_version text DEFAULT 'r57-v1'::text,
  opened_at timestamp with time zone DEFAULT now(),
  closed_at timestamp with time zone,
  loaded_by text,
  PRIMARY KEY (revision)
);
CREATE OR REPLACE FUNCTION public.job_profit_num(p jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE jsonb_typeof(p)
           WHEN 'number' THEN (p #>> '{}')::numeric
           WHEN 'string' THEN CASE WHEN btrim(p #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'
                                   THEN btrim(p #>> '{}')::numeric END
         END
$function$;
CREATE OR REPLACE FUNCTION public.job_cost_installer_bill(p_line_items jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_line_items) = 'array' THEN p_line_items ELSE '[]'::jsonb END) li
    WHERE li.value ->> 'AccountCode' IN ('306', '301')
      AND COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 1) <> 0
  )
$function$;
CREATE OR REPLACE FUNCTION public.job_cost_credit_share(p_raw jsonb, p_total numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH applied AS (
    SELECT
      (SELECT sum(public.job_profit_num(c.value -> 'AppliedAmount'))
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw -> 'CreditNotes') = 'array' THEN p_raw -> 'CreditNotes' ELSE '[]'::jsonb END) c
      ) AS credit_notes,
      -- The list decides only when every credit note carries a readable
      -- AppliedAmount; otherwise AmountCredited does, so an unreadable list
      -- never reads as no credit.
      (SELECT count(*) > 0 AND bool_and(public.job_profit_num(c.value -> 'AppliedAmount') IS NOT NULL)
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw -> 'CreditNotes') = 'array' THEN p_raw -> 'CreditNotes' ELSE '[]'::jsonb END) c
      ) AS has_credit_notes,
      (SELECT COALESCE(sum(public.job_profit_num(o.value -> 'AppliedAmount')), 0)
         FROM jsonb_array_elements(
           (CASE WHEN jsonb_typeof(p_raw -> 'Prepayments') = 'array' THEN p_raw -> 'Prepayments' ELSE '[]'::jsonb END)
           || (CASE WHEN jsonb_typeof(p_raw -> 'Overpayments') = 'array' THEN p_raw -> 'Overpayments' ELSE '[]'::jsonb END)) o
      ) AS other_applied
  )
  SELECT CASE
    WHEN COALESCE(p_total, 0) <= 0 OR p_raw IS NULL THEN 0
    WHEN a.has_credit_notes THEN least(greatest(COALESCE(a.credit_notes, 0) / p_total, 0), 1)
    WHEN jsonb_typeof(p_raw -> 'AmountCredited') <> 'number' THEN 0
    ELSE least(greatest(((p_raw ->> 'AmountCredited')::numeric - a.other_applied) / p_total, 0), 1)
  END
  FROM applied a
$function$;
CREATE OR REPLACE FUNCTION public.job_cost_credit_note_part(p_row_ex numeric, p_allocation numeric, p_bill_total numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_bill_total > 0 THEN round(p_row_ex * p_allocation / p_bill_total, 2) END
$function$;
CREATE OR REPLACE FUNCTION public.materials_ai_trade_mirror(p_xero_invoice_id text, p_line_items jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = p_xero_invoice_id)
      OR EXISTS (SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_line_items) = 'array' THEN p_line_items ELSE '[]'::jsonb END) li
                  WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]')
$function$;
CREATE OR REPLACE FUNCTION public.bookkeeping_evidence_classify(f jsonb, OUT allocation text, OUT job_number text, OUT job_id uuid, OUT evidenced boolean, OUT basis text, OUT outcome text, OUT document_ref text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n integer;
  v_jn text := nullif(btrim(coalesce(f ->> 'job_number', f ->> 'j', '')), '');
  v_alloc text := nullif(coalesce(f ->> 'allocation', f ->> 'k'), '');
  v_ev text := nullif(coalesce(f ->> 'evidenced', f ->> 'e'), '');
BEGIN
  job_number := v_jn;
  basis := nullif(coalesce(f ->> 'job_confidence', f ->> 'c', ''), '');
  outcome := nullif(coalesce(f ->> 'outcome', f ->> 'status', f ->> 'o', ''), '');
  document_ref := nullif(coalesce(f ->> 'd', f ->> 'pdf_sha256', f #>> '{documents,0,sha256}', ''), '');
  IF v_jn IS NOT NULL THEN
    SELECT count(*), (array_agg(jb.id))[1] INTO n, job_id
    FROM public.jobs jb WHERE upper(btrim(jb.job_number)) = upper(v_jn);
    IF n <> 1 THEN job_id := NULL; END IF;
  END IF;
  allocation := CASE
    WHEN v_alloc IN ('job', 'overhead', 'not_job_cost', 'unresolved') THEN v_alloc
    WHEN basis = 'not_job_cost_adjustment' THEN 'not_job_cost'
    WHEN job_id IS NOT NULL THEN 'job'
    ELSE 'unresolved'
  END;
  IF allocation = 'job' AND job_id IS NULL THEN allocation := 'unresolved'; END IF;
  evidenced := CASE
    WHEN allocation = 'unresolved' THEN false
    WHEN v_ev IN ('true', 'false') THEN v_ev::boolean
    WHEN document_ref IS NULL THEN false
    WHEN allocation IN ('not_job_cost', 'overhead') THEN true
    WHEN coalesce(basis, '') = 'unknown' THEN false
    WHEN coalesce(outcome, '') LIKE 'no\_%' THEN false
    WHEN coalesce(outcome, '') IN ('order_no_without_job', 'document_no_job_reference', 'several_jobs_same_address',
                                   'reference_not_a_known_job', 'original_invoice_no_valid_job') THEN false
    ELSE true
  END;
END $function$;
CREATE OR REPLACE FUNCTION public.bookkeeping_evidence_open(p_revision text, p_schema text, p_producer text, p_emitted_at timestamp with time zone, p_sha256 text, p_supersedes text, p_facts_in_file integer, p_facts_sent integer, p_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.bookkeeping_evidence_revisions;
BEGIN
  IF p_schema IS DISTINCT FROM 'bookkeeping-financial-evidence/1.0' THEN
    RAISE EXCEPTION 'evidence_schema_unsupported: %', p_schema;
  END IF;
  SELECT * INTO r FROM public.bookkeeping_evidence_revisions WHERE revision = p_revision FOR UPDATE;
  IF FOUND THEN
    IF r.sha256 <> p_sha256 THEN RAISE EXCEPTION 'evidence_revision_sha_mismatch: %', p_revision; END IF;
    IF r.status <> 'loading' THEN
      RETURN jsonb_build_object('revision', p_revision, 'status', r.status, 'already', true);
    END IF;
    DELETE FROM public.bookkeeping_line_evidence WHERE revision = p_revision;
    UPDATE public.bookkeeping_evidence_revisions
       SET rows_loaded = 0, facts_sent = p_facts_sent, facts_in_file = p_facts_in_file, opened_at = now(), loaded_by = p_by
     WHERE revision = p_revision;
    RETURN jsonb_build_object('revision', p_revision, 'status', 'loading', 'restarted', true);
  END IF;
  INSERT INTO public.bookkeeping_evidence_revisions
    (revision, stream, revision_no, schema, producer, emitted_at, sha256, supersedes, facts_in_file, facts_sent, loaded_by)
  VALUES (p_revision, regexp_replace(p_revision, '-r[0-9]+$', ''), substring(p_revision FROM '-r([0-9]+)$')::integer,
          p_schema, p_producer, p_emitted_at, p_sha256, p_supersedes, p_facts_in_file, p_facts_sent, p_by);
  RETURN jsonb_build_object('revision', p_revision, 'status', 'loading');
END $function$;
CREATE OR REPLACE FUNCTION public.bookkeeping_evidence_add(p_revision text, p_facts jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE st text; n integer;
BEGIN
  SELECT status INTO st FROM public.bookkeeping_evidence_revisions WHERE revision = p_revision FOR UPDATE;
  IF st IS NULL THEN RAISE EXCEPTION 'evidence_revision_unknown: %', p_revision; END IF;
  IF st <> 'loading' THEN RAISE EXCEPTION 'evidence_revision_not_loading: % is %', p_revision, st; END IF;
  IF jsonb_typeof(p_facts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'evidence_facts_not_array'; END IF;
  INSERT INTO public.bookkeeping_line_evidence
    (revision, xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced,
     basis, outcome, document_ref, trade_invoice_line_id, fact)
  SELECT p_revision,
         coalesce(f.e ->> 'bill_id', f.e ->> 'b'),
         coalesce(f.e ->> 'line_item_id', f.e ->> 'l'),
         nullif(coalesce(f.e ->> 'amount_ex_gst', f.e ->> 'a'), '')::numeric,
         c.allocation, c.job_number, c.job_id, c.evidenced, c.basis, c.outcome, c.document_ref,
         nullif(coalesce(f.e ->> 'trade_invoice_line_id', f.e ->> 't'), '')::uuid,
         f.e
  FROM jsonb_array_elements(p_facts) AS f(e)
  CROSS JOIN LATERAL public.bookkeeping_evidence_classify(f.e) c
  WHERE coalesce(f.e ->> 'bill_id', f.e ->> 'b') IS NOT NULL
    AND coalesce(f.e ->> 'line_item_id', f.e ->> 'l') IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.bookkeeping_evidence_revisions SET rows_loaded = rows_loaded + n WHERE revision = p_revision;
  RETURN n;
END $function$;
CREATE OR REPLACE FUNCTION public.bookkeeping_evidence_close(p_revision text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.bookkeeping_evidence_revisions; v_newer boolean;
BEGIN
  SELECT * INTO r FROM public.bookkeeping_evidence_revisions WHERE revision = p_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'evidence_revision_unknown: %', p_revision; END IF;
  IF r.status <> 'loading' THEN
    RETURN jsonb_build_object('revision', r.revision, 'status', r.status, 'already', true);
  END IF;
  IF r.rows_loaded <> r.facts_sent THEN
    RAISE EXCEPTION 'evidence_revision_incomplete: % loaded of % sent', r.rows_loaded, r.facts_sent;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.bookkeeping_evidence_revisions o
                  WHERE o.stream = r.stream AND o.status = 'current'
                    AND coalesce(o.revision_no, 0) > coalesce(r.revision_no, 0)) INTO v_newer;
  IF NOT v_newer THEN
    UPDATE public.bookkeeping_evidence_revisions SET status = 'superseded'
     WHERE stream = r.stream AND status = 'current' AND revision <> r.revision;
  END IF;
  UPDATE public.bookkeeping_evidence_revisions
     SET status = CASE WHEN v_newer THEN 'superseded' ELSE 'current' END, closed_at = now()
   WHERE revision = r.revision;
  RETURN (
    SELECT jsonb_build_object(
      'revision', r.revision, 'status', CASE WHEN v_newer THEN 'superseded' ELSE 'current' END,
      'rows', count(*),
      'evidenced', count(*) FILTER (WHERE e.evidenced),
      'evidenced_ex', coalesce(sum(e.amount_ex_gst) FILTER (WHERE e.evidenced), 0),
      'by_allocation', (SELECT jsonb_object_agg(a.allocation, jsonb_build_object('lines', a.n, 'ex', a.ex, 'evidenced', a.ev))
                          FROM (SELECT allocation, count(*) n, coalesce(sum(amount_ex_gst), 0) ex, count(*) FILTER (WHERE evidenced) ev
                                  FROM public.bookkeeping_line_evidence WHERE revision = r.revision GROUP BY allocation) a))
    FROM public.bookkeeping_line_evidence e WHERE e.revision = r.revision);
END $function$;
-- As in the registered stack (20261104070000's setup): a table with production's columns stands in for
-- Bookkeeping's current line-evidence view, so the contracts write evidence rows straight into it.
CREATE TABLE public.v_bookkeeping_line_evidence_current (
  xero_invoice_id text, xero_line_item_id text, amount_ex_gst numeric, allocation text, job_number text, job_id uuid,
  evidenced boolean, basis text, outcome text, document_ref text, trade_invoice_line_id uuid, revision text, stream text,
  emitted_at timestamp with time zone, revision_sha256 text);
CREATE VIEW public.v_supplier_credit_allocations AS
 WITH alloc AS (
         SELECT n.org_id,
            n.xero_credit_note_id,
            n.credit_note_number,
            n.xero_contact_id,
            n.contact_name,
            n.credit_note_date,
            n.status AS credit_note_status,
            COALESCE(n.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]), false) AS note_live,
            a.n AS allocation_n,
            a.allocation_id,
            a.xero_invoice_id,
            a.invoice_number,
            a.amount,
            a.allocation_date,
            a.is_deleted,
            x.xero_invoice_id IS NOT NULL AS bill_in_copy,
            x.status AS bill_status,
            x.total AS bill_total,
            x.line_items AS bill_line_items,
            job_cost_credit_share(x.raw_json, x.total) AS bill_credit_share,
            job_cost_credit_share(x.raw_json - 'AmountCredited'::text, x.total) AS bill_list_share,
            ( SELECT sum(job_profit_num(c_1.value -> 'AppliedAmount'::text)) AS sum
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(x.raw_json -> 'CreditNotes'::text) = 'array'::text THEN x.raw_json -> 'CreditNotes'::text
                            ELSE '[]'::jsonb
                        END) c_1(value)
                  WHERE COALESCE(c_1.value ->> 'CreditNoteID'::text, c_1.value ->> 'ID'::text) = a.xero_credit_note_id) AS bill_side_applied,
            (EXISTS ( SELECT 1
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(x.raw_json -> 'CreditNotes'::text) = 'array'::text THEN x.raw_json -> 'CreditNotes'::text
                            ELSE '[]'::jsonb
                        END) c_1(value)
                  WHERE COALESCE(c_1.value ->> 'CreditNoteID'::text, c_1.value ->> 'ID'::text) = a.xero_credit_note_id)) AS bill_lists_note
           FROM xero_supplier_credit_notes n
             JOIN xero_supplier_credit_note_allocations a ON a.org_id = n.org_id AND a.xero_credit_note_id = n.xero_credit_note_id
             LEFT JOIN xero_invoices x ON x.org_id = a.org_id AND x.xero_invoice_id = a.xero_invoice_id AND x.invoice_type = 'ACCPAY'::text
          WHERE n.allocations_returned
        ), judged AS (
         SELECT a.org_id,
            a.xero_credit_note_id,
            a.credit_note_number,
            a.xero_contact_id,
            a.contact_name,
            a.credit_note_date,
            a.credit_note_status,
            a.note_live,
            a.allocation_n,
            a.allocation_id,
            a.xero_invoice_id,
            a.invoice_number,
            a.amount,
            a.allocation_date,
            a.is_deleted,
            a.bill_in_copy,
            a.bill_status,
            a.bill_total,
            a.bill_line_items,
            a.bill_credit_share,
            a.bill_list_share,
            a.bill_side_applied,
            a.bill_lists_note,
                CASE
                    WHEN NOT a.bill_in_copy THEN NULL::text
                    WHEN COALESCE(a.bill_credit_share, 0::numeric) <= 0::numeric THEN 'none'::text
                    WHEN a.bill_list_share = a.bill_credit_share AND a.bill_lists_note THEN 'counts_it'::text
                    WHEN a.bill_list_share = a.bill_credit_share THEN 'not_this_one'::text
                    ELSE 'amount_credited'::text
                END AS bill_side,
                CASE
                    WHEN NOT a.note_live THEN 'credit_note_not_live'::text
                    WHEN a.is_deleted THEN 'allocation_deleted'::text
                    WHEN a.amount IS NULL THEN 'amount_unknown'::text
                    WHEN a.amount <= 0::numeric THEN 'amount_not_positive'::text
                    WHEN NOT a.bill_in_copy THEN 'bill_not_in_copy'::text
                    WHEN a.bill_status IS NULL OR (a.bill_status <> ALL (ARRAY['AUTHORISED'::text, 'PAID'::text])) THEN 'bill_not_live'::text
                    WHEN a.bill_total IS NULL OR a.bill_total <= 0::numeric THEN 'bill_total_unknown'::text
                    WHEN materials_ai_trade_mirror(a.xero_invoice_id, a.bill_line_items) THEN 'crew_bill'::text
                    ELSE 'bill_live'::text
                END AS state,
            round(COALESCE(a.bill_credit_share, 0::numeric) * a.bill_total, 2) AS bill_credit_inc
           FROM alloc a
        ), candidate AS (
         SELECT j.org_id,
            j.xero_credit_note_id,
            j.credit_note_number,
            j.xero_contact_id,
            j.contact_name,
            j.credit_note_date,
            j.credit_note_status,
            j.note_live,
            j.allocation_n,
            j.allocation_id,
            j.xero_invoice_id,
            j.invoice_number,
            j.amount,
            j.allocation_date,
            j.is_deleted,
            j.bill_in_copy,
            j.bill_status,
            j.bill_total,
            j.bill_line_items,
            j.bill_credit_share,
            j.bill_list_share,
            j.bill_side_applied,
            j.bill_lists_note,
            j.bill_side,
            j.state,
            j.bill_credit_inc,
            j.state = 'bill_live'::text AND (j.bill_side = ANY (ARRAY['none'::text, 'not_this_one'::text])) AS from_note,
            j.bill_credit_inc + COALESCE(sum(j.amount) FILTER (WHERE j.state = 'bill_live'::text AND (j.bill_side = ANY (ARRAY['none'::text, 'not_this_one'::text]))) OVER (PARTITION BY j.org_id, j.xero_invoice_id), 0::numeric) AS credit_on_bill_inc
           FROM judged j
        )
 SELECT org_id,
    xero_credit_note_id,
    credit_note_number,
    xero_contact_id,
    contact_name,
    credit_note_date,
    credit_note_status,
    allocation_n,
    allocation_id,
    xero_invoice_id,
    invoice_number,
    allocation_date,
    amount,
    is_deleted,
    bill_status,
    bill_total,
    bill_side_applied,
    bill_side,
    state,
    bill_credit_inc,
    credit_on_bill_inc,
    COALESCE(from_note AND credit_on_bill_inc > bill_total, false) AS exceeds_bill,
    COALESCE(from_note AND credit_on_bill_inc <= bill_total, false) AS counts_from_credit_note
   FROM candidate c;
-- 20261104063000 (A4 V8): the job a bill line's own text names, as that migration creates it.
CREATE OR REPLACE FUNCTION public.job_cost_bill_line_job_id(p_text text)
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN pg_catalog.count(DISTINCT t.job_number) OPERATOR(pg_catalog.=) 1
               AND pg_catalog.count(DISTINCT j.id) OPERATOR(pg_catalog.=) 1
              THEN (pg_catalog.array_agg(j.id) FILTER (WHERE j.id IS NOT NULL))[1] END
  FROM (SELECT CASE WHEN m[1] IS NULL THEN 'SW' OPERATOR(pg_catalog.||) m[2]
                    ELSE 'SW' OPERATOR(pg_catalog.||) m[1] OPERATOR(pg_catalog.||) '-' OPERATOR(pg_catalog.||) m[2] END AS job_number
          FROM pg_catalog.regexp_matches(pg_catalog.upper(COALESCE(p_text, '')),
                                         '(?<![A-Z0-9])SW(MS|[A-Z])?[ \t]*[-=:]?[ \t]*([0-9]{4,6})(?![0-9])', 'g') AS m) t
  LEFT JOIN public.jobs j
    ON pg_catalog.upper(j.job_number) OPERATOR(pg_catalog.=) t.job_number
   AND pg_catalog.lower(COALESCE(j.metadata OPERATOR(pg_catalog.->>) 'do_not_schedule', '')) OPERATOR(pg_catalog.<>) 'true'
$fn$;
COMMENT ON FUNCTION public.job_cost_bill_line_job_id(text) IS
  'A4 V8 20261104063000: the job a supplier or subcontractor bill line''s own text names (SWF-26177, SWF26177, SWF 26177, SWF -26177, SWMS-261321, SW1346; never inside a longer word or number), when the text names exactly one job number and exactly one job that is not the holding job carries it; else NULL. Used by v_job_cost_events.bill_line.';
REVOKE ALL ON FUNCTION public.job_cost_bill_line_job_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_bill_line_job_id(text) TO service_role;
CREATE VIEW public.v_job_cost_events AS
 WITH trade_mirror_bill AS (
         SELECT x.xero_invoice_id
           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCPAY'::text AND ((EXISTS ( SELECT 1
                   FROM trade_invoices t
                  WHERE t.xero_bill_id = x.xero_invoice_id)) OR (EXISTS ( SELECT 1
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(x.line_items) = 'array'::text THEN x.line_items
                            ELSE '[]'::jsonb
                        END) li(value)
                  WHERE (li.value ->> 'Description'::text) ~ '\| SW - [A-Z]'::text)) AND NOT (EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e
                  WHERE e.xero_invoice_id = x.xero_invoice_id AND e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL)))
        ), trade AS (
         SELECT r.resolved_job_id AS job_id,
            COALESCE(r.line_date, r.week_start) AS event_date,
                CASE
                    WHEN r.cost_lane = 'unclassified'::text THEN 'other'::text
                    ELSE r.cost_lane
                END AS lane,
            r.cost_lane AS lane_detail,
            'trade'::text AS party_kind,
            r.user_id::text AS party_id,
            COALESCE(NULLIF(btrim(u.name), ''::text), 'Unnamed trade'::text) AS party,
            r.line_total_ex AS amount_ex,
            'trade_line'::text AS source,
            r.line_id::text AS source_id,
            ti.id::text AS document_id,
            ti.invoice_number AS document_number,
            ti.status AS document_status,
            ti.status = 'paid'::text OR upper(COALESCE(ti.xero_bill_status, ''::text)) = 'PAID'::text AS paid,
            ti.paid_at AS paid_on,
                CASE r.match_method
                    WHEN 'job_id'::text THEN 'high'::text
                    WHEN 'line_job_number'::text THEN 'medium'::text
                    ELSE 'low'::text
                END AS confidence,
            r.cost_lane <> 'advance'::text AND ti.status <> 'draft'::text AS is_actual,
            r.description,
            r.total_hours AS hours,
            NULL::text AS account_code,
            NULL::text AS business_unit,
            r.match_method,
            COALESCE(c.zero_line OR c.mismatch, false) AS incomplete_invoice
           FROM v_trade_charge_resolved r
             JOIN trade_invoices ti ON ti.id = r.trade_invoice_id
             LEFT JOIN users u ON u.id = r.user_id
             LEFT JOIN v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
          WHERE r.resolved_job_id IS NOT NULL AND NOT r.is_probable_test_line AND ti.status <> 'ops-reject'::text AND (upper(COALESCE(ti.xero_bill_status, ''::text)) <> ALL (ARRAY['DELETED'::text, 'VOIDED'::text]))
        ), trade_employer_super AS (
         SELECT t.job_id,
            t.event_date,
            t.lane,
            'employer_super'::text AS lane_detail,
            t.party_kind,
            t.party_id,
            t.party,
            round(t.amount_ex * s.employer_super_ex / s.subtotal_ex, 6) AS amount_ex,
            'trade_employer_super'::text AS source,
            t.source_id || ':employer_super'::text AS source_id,
            t.document_id,
            t.document_number,
            t.document_status,
            false AS paid,
            NULL::date AS paid_on,
            t.confidence,
            t.is_actual,
            'Employer super on: '::text || COALESCE(t.description, ''::text) AS description,
            NULL::numeric AS hours,
            t.account_code,
            t.business_unit,
            t.match_method,
            t.incomplete_invoice
           FROM trade t
             JOIN ( SELECT ti.id::text AS document_id,
                    ti.subtotal_ex,
                    ti.super_amount - (ti.subtotal_ex - ti.net_pay) AS employer_super_ex
                   FROM trade_invoices ti
                  WHERE ti.super_amount IS NOT NULL AND ti.net_pay IS NOT NULL AND ti.subtotal_ex > 0::numeric) s ON s.document_id = t.document_id
          WHERE s.employer_super_ex > 0.005 AND t.amount_ex <> 0::numeric AND (EXISTS ( SELECT 1
                   FROM feature_flags ff
                  WHERE ff.flag_name = 'job_cost_employer_super_v1'::text AND ff.enabled))
        ), bill_ev AS (
         SELECT e.xero_invoice_id,
            e.xero_line_item_id,
            e.job_id
           FROM v_bookkeeping_line_evidence_current e
          WHERE e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL
        ), ledger_cn AS (
         SELECT e.xero_invoice_id AS xero_credit_note_id,
            e.xero_line_item_id,
            e.job_id,
            e.amount_ex_gst,
            n.credit_note_number,
            n.contact_name,
            n.credit_note_date,
            n.status,
            n.sub_total,
            ( SELECT l.value ->> 'AccountCode'::text
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(n.raw_json -> 'LineItems'::text) = 'array'::text THEN n.raw_json -> 'LineItems'::text
                            ELSE '[]'::jsonb
                        END) l(value)
                  WHERE (l.value ->> 'LineItemID'::text) = e.xero_line_item_id
                 LIMIT 1) AS account_code
           FROM v_bookkeeping_line_evidence_current e
             JOIN xero_supplier_credit_notes n ON n.xero_credit_note_id = e.xero_invoice_id
          WHERE e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL AND (n.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
        ), ledger_cn_note AS (
         SELECT ledger_cn.xero_credit_note_id,
            LEAST(GREATEST((- sum(ledger_cn.amount_ex_gst)) / NULLIF(max(ledger_cn.sub_total), 0::numeric), 0::numeric), 1::numeric) AS share_placed
           FROM ledger_cn
          GROUP BY ledger_cn.xero_credit_note_id
        ), ledger_cn_bill AS (
         SELECT a.xero_invoice_id,
            sum(a.amount * l.share_placed) AS applied_moved
           FROM v_supplier_credit_allocations a
             JOIN ledger_cn_note l ON l.xero_credit_note_id = a.xero_credit_note_id
          WHERE a.state = 'bill_live'::text AND (a.bill_side = ANY (ARRAY['counts_it'::text, 'amount_credited'::text]))
          GROUP BY a.xero_invoice_id
        ), bill_line AS (
         SELECT bl.job_id,
            bl.placed_by,
            bl.invoice_date,
            bl.xero_invoice_id,
            bl.invoice_number,
            bl.contact_name,
            bl.status,
            bl.fully_paid_on,
            bl.n,
            bl.line,
            bl.amount_ex,
            bl.credit_share,
                CASE
                    WHEN NOT job_cost_installer_bill(bl.line_items) THEN 'not_installer'::text
                    WHEN bl.placed_by = 'bookkeeping_evidence'::text THEN 'confirmed'::text
                    WHEN bl.placed_by = 'bill_line_job_number'::text AND (EXISTS ( SELECT 1
                       FROM feature_flags ff
                      WHERE ff.flag_name = 'job_cost_installer_line_job_number_v1'::text AND ff.enabled)) THEN 'confirmed'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM job_materials_facts f
                      WHERE f.xero_invoice_id = bl.xero_invoice_id AND f.job_id = bl.job_id AND (f.automation_source = ANY (ARRAY['manual_queue'::text, 'agent_ai'::text])))) THEN 'confirmed'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM materials_reconciliation_queue q
                      WHERE q.xero_invoice_id = bl.xero_invoice_id AND q.status = 'not_job_related'::text)) THEN 'not_job_related'::text
                    ELSE 'unconfirmed'::text
                END AS installer_state
           FROM ( SELECT
                        CASE
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text)))) THEN ev.job_id
                            WHEN tj.job_id IS NOT NULL THEN tj.job_id
                            ELSE x.job_id
                        END AS job_id,
                        CASE
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text)))) THEN 'bookkeeping_evidence'::text
                            WHEN tj.job_id IS NOT NULL THEN 'bill_line_job_number'::text
                            ELSE 'xero_invoices.job_id'::text
                        END AS placed_by,
                    x.invoice_date,
                    x.xero_invoice_id,
                    x.invoice_number,
                    x.contact_name,
                    x.status,
                    x.fully_paid_on,
                    x.line_items,
                    li.n,
                    li.value AS line,
                        CASE
                            WHEN li.value ? '_header_ex'::text THEN job_profit_num(li.value -> '_header_ex'::text)
                            WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                            ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                        END AS amount_ex,
                    GREATEST(job_cost_credit_share(x.raw_json, x.total) - COALESCE(( SELECT m.applied_moved
                           FROM ledger_cn_bill m
                          WHERE m.xero_invoice_id = x.xero_invoice_id), 0::numeric) / NULLIF(x.total, 0::numeric), 0::numeric) AS credit_share
                   FROM xero_invoices x
                     CROSS JOIN LATERAL jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(x.line_items) = 'array'::text AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
                            ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Bill total (no lines stored)'))
                        END) WITH ORDINALITY li(value, n)
                     LEFT JOIN jobs hj ON hj.id = x.job_id AND lower(COALESCE(hj.metadata ->> 'do_not_schedule'::text, ''::text)) = 'true'::text
                     LEFT JOIN bill_ev ev ON ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text)
                     LEFT JOIN LATERAL ( SELECT job_cost_bill_line_job_id(li.value ->> 'Description'::text) AS job_id
                          WHERE (x.job_id IS NULL OR hj.id IS NOT NULL) AND NOT (EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e
                                  WHERE e.xero_invoice_id = x.xero_invoice_id AND e.xero_line_item_id = (li.value ->> 'LineItemID'::text))) AND NOT (EXISTS ( SELECT 1
                                   FROM materials_reconciliation_queue q
                                  WHERE q.xero_invoice_id = x.xero_invoice_id AND q.status = 'not_job_related'::text))) tn ON true
                     LEFT JOIN LATERAL ( SELECT tn.job_id
                          WHERE tn.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                                   FROM trade t_tn
                                  WHERE t_tn.job_id = tn.job_id AND t_tn.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_tn.party)) || '%'::text))))) tj ON true
                  WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND NOT (EXISTS ( SELECT 1
                           FROM trade_mirror_bill m
                          WHERE m.xero_invoice_id = x.xero_invoice_id)) AND NOT (EXISTS ( SELECT 1
                           FROM job_materials_facts f
                          WHERE f.xero_invoice_id = x.xero_invoice_id AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = 'manual_split'::text) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND (EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e
                                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) AND NOT (EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e2
                                  WHERE e2.xero_invoice_id = f.xero_invoice_id AND e2.evidenced AND e2.job_id = f.job_id))))) AND NOT (EXISTS ( SELECT 1
                           FROM materials_reconciliation_queue q
                          WHERE q.xero_invoice_id = x.xero_invoice_id AND COALESCE(q.overhead_ex, 0::numeric) > 0::numeric))) bl
          WHERE bl.job_id IS NOT NULL
        ), supplier AS (
         SELECT b.job_id,
            b.invoice_date AS event_date,
                CASE
                    WHEN COALESCE(b.line ->> 'Description'::text, ''::text) ~* 'commission'::text THEN 'commission'::text
                    WHEN (b.line ->> 'AccountCode'::text) = ANY (ARRAY['306'::text, '301'::text]) THEN 'labour'::text
                    WHEN (b.line ->> 'AccountCode'::text) ~ '^3[0-9]{2}$'::text THEN 'materials'::text
                    ELSE 'other'::text
                END AS lane,
            COALESCE(b.line ->> 'AccountCode'::text, 'no_account'::text) AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(b.contact_name), ''::text), 'Unnamed supplier'::text) AS party,
            b.amount_ex,
                CASE b.installer_state
                    WHEN 'unconfirmed'::text THEN 'installer_bill_unconfirmed'::text
                    WHEN 'not_job_related'::text THEN 'installer_bill_not_job_related'::text
                    ELSE 'supplier_bill'::text
                END AS source,
            (b.xero_invoice_id || ':'::text) || b.n AS source_id,
            b.xero_invoice_id AS document_id,
            b.invoice_number AS document_number,
            b.status AS document_status,
            b.status = 'PAID'::text AS paid,
            b.fully_paid_on AS paid_on,
                CASE b.installer_state
                    WHEN 'unconfirmed'::text THEN 'awaiting_confirmation'::text
                    WHEN 'not_job_related'::text THEN 'person_marked_not_job_related'::text
                    ELSE 'high'::text
                END AS confidence,
            b.installer_state <> ALL (ARRAY['unconfirmed'::text, 'not_job_related'::text]) AS is_actual,
            b.line ->> 'Description'::text AS description,
            NULL::numeric AS hours,
            b.line ->> 'AccountCode'::text AS account_code,
            ( SELECT t.value ->> 'Option'::text
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(b.line -> 'Tracking'::text) = 'array'::text THEN b.line -> 'Tracking'::text
                            ELSE '[]'::jsonb
                        END) t(value)
                  WHERE (t.value ->> 'Name'::text) = 'Business Unit'::text
                 LIMIT 1) AS business_unit,
            b.placed_by AS match_method,
            false AS incomplete_invoice
           FROM bill_line b
        ), fact_base AS (
         SELECT f.job_id,
            f.fact_date AS event_date,
                CASE
                    WHEN f.lane = ANY (ARRAY['labour'::text, 'materials'::text, 'commission'::text, 'other'::text]) THEN f.lane
                    ELSE 'materials'::text
                END AS lane,
            f.lane AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(f.contact_name), ''::text), 'Unnamed supplier'::text) AS party,
            f.amount_ex_gst AS amount_ex,
            'materials_fact'::text AS source,
            f.id::text AS source_id,
            f.xero_invoice_id AS document_id,
            f.invoice_number AS document_number,
            x.status AS document_status,
            COALESCE(x.status = 'PAID'::text, false) AS paid,
            x.fully_paid_on AS paid_on,
            COALESCE(f.confidence, 'unknown'::text) AS confidence,
            true AS is_actual,
            f.match_reason AS description,
            NULL::numeric AS hours,
            NULL::text AS account_code,
            NULL::text AS business_unit,
            COALESCE(f.automation_source, 'materials_fact'::text) AS match_method,
            false AS incomplete_invoice,
            COALESCE(x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]), false) AS bill_live,
            GREATEST(job_cost_credit_share(x.raw_json, x.total) - COALESCE(( SELECT m.applied_moved
                   FROM ledger_cn_bill m
                  WHERE m.xero_invoice_id = x.xero_invoice_id), 0::numeric) / NULLIF(x.total, 0::numeric), 0::numeric) AS credit_share,
            (COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text, 'agent_ai'::text])) AND (f.lane = 'labour'::text OR job_cost_installer_bill(x.line_items)) AS installer_unconfirmed
           FROM job_materials_facts f
             LEFT JOIN xero_invoices x ON x.xero_invoice_id = f.xero_invoice_id AND x.invoice_type = 'ACCPAY'::text
          WHERE f.kind = 'actual'::text AND f.job_id IS NOT NULL AND f.amount_ex_gst IS NOT NULL AND (COALESCE(x.status, ''::text) <> ALL (ARRAY['VOIDED'::text, 'DELETED'::text])) AND NOT (EXISTS ( SELECT 1
                   FROM trade_mirror_bill m
                  WHERE m.xero_invoice_id = f.xero_invoice_id)) AND NOT (EXISTS ( SELECT 1
                   FROM bill_line b
                  WHERE b.xero_invoice_id = f.xero_invoice_id AND (b.job_id = f.job_id OR b.placed_by <> 'xero_invoices.job_id'::text AND f.job_id = x.job_id))) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND (EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e
                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) AND NOT (EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e2
                  WHERE e2.xero_invoice_id = f.xero_invoice_id AND e2.evidenced AND e2.job_id = f.job_id)))
        ), fact AS (
         SELECT fact_base.job_id,
            fact_base.event_date,
            fact_base.lane,
            fact_base.lane_detail,
            fact_base.party_kind,
            fact_base.party_id,
            fact_base.party,
            fact_base.amount_ex,
                CASE
                    WHEN fact_base.installer_unconfirmed THEN 'installer_bill_unconfirmed'::text
                    ELSE fact_base.source
                END AS source,
            fact_base.source_id,
            fact_base.document_id,
            fact_base.document_number,
            fact_base.document_status,
            fact_base.paid,
            fact_base.paid_on,
                CASE
                    WHEN fact_base.installer_unconfirmed THEN 'awaiting_confirmation'::text
                    ELSE fact_base.confidence
                END AS confidence,
            NOT fact_base.installer_unconfirmed AS is_actual,
            fact_base.description,
            fact_base.hours,
            fact_base.account_code,
            fact_base.business_unit,
            fact_base.match_method,
            fact_base.incomplete_invoice
           FROM fact_base
        ), supplier_credit AS (
         SELECT b.job_id,
            b.invoice_date AS event_date,
            s.lane,
            s.lane_detail,
            s.party_kind,
            s.party_id,
            s.party,
            - round(s.amount_ex * b.credit_share, 2) AS amount_ex,
                CASE
                    WHEN s.is_actual THEN 'supplier_credit'::text
                    ELSE s.source
                END AS source,
            s.source_id || ':credit'::text AS source_id,
            s.document_id,
            s.document_number,
            s.document_status,
            s.paid,
            s.paid_on,
            s.confidence,
            s.is_actual,
            'Credit applied in Xero'::text AS description,
            NULL::numeric AS hours,
            s.account_code,
            s.business_unit,
            'xero_amount_credited'::text AS match_method,
            false AS incomplete_invoice
           FROM supplier s
             JOIN bill_line b ON ((b.xero_invoice_id || ':'::text) || b.n) = s.source_id
          WHERE b.credit_share > 0::numeric AND s.amount_ex <> 0::numeric
        ), fact_credit AS (
         SELECT f.job_id,
            f.event_date,
            f.lane,
            f.lane_detail,
            f.party_kind,
            f.party_id,
            f.party,
            - round(f.amount_ex * f.credit_share, 2) AS amount_ex,
                CASE
                    WHEN f.installer_unconfirmed THEN 'installer_bill_unconfirmed'::text
                    ELSE 'supplier_credit'::text
                END AS source,
            f.source_id || ':credit'::text AS source_id,
            f.document_id,
            f.document_number,
            f.document_status,
            f.paid,
            f.paid_on,
                CASE
                    WHEN f.installer_unconfirmed THEN 'awaiting_confirmation'::text
                    ELSE f.confidence
                END AS confidence,
            NOT f.installer_unconfirmed AS is_actual,
            'Credit applied in Xero'::text AS description,
            NULL::numeric AS hours,
            f.account_code,
            f.business_unit,
            'xero_amount_credited'::text AS match_method,
            false AS incomplete_invoice
           FROM fact_base f
          WHERE f.bill_live AND f.credit_share > 0::numeric AND f.amount_ex <> 0::numeric
        ), credit_note AS (
         SELECT s.job_id,
            s.event_date,
            s.lane,
            s.lane_detail,
            s.party_kind,
            s.party_id,
            s.party,
            - job_cost_credit_note_part(s.amount_ex, a.amount * (1::numeric - COALESCE(( SELECT l.share_placed
                   FROM ledger_cn_note l
                  WHERE l.xero_credit_note_id = a.xero_credit_note_id), 0::numeric)), a.bill_total) AS amount_ex,
                CASE
                    WHEN s.is_actual THEN 'supplier_credit'::text
                    ELSE s.source
                END AS source,
            (((s.source_id || ':credit_note:'::text) || a.xero_credit_note_id) || ':'::text) || a.allocation_n AS source_id,
            s.document_id,
            s.document_number,
            s.document_status,
            s.paid,
            s.paid_on,
            s.confidence,
            s.is_actual,
            ('Supplier credit note '::text || COALESCE(a.credit_note_number, '(no number)'::text)) || ' applied in Xero'::text AS description,
            NULL::numeric AS hours,
            s.account_code,
            s.business_unit,
            'xero_credit_note'::text AS match_method,
            false AS incomplete_invoice
           FROM ( SELECT supplier.job_id,
                    supplier.event_date,
                    supplier.lane,
                    supplier.lane_detail,
                    supplier.party_kind,
                    supplier.party_id,
                    supplier.party,
                    supplier.amount_ex,
                    supplier.source,
                    supplier.source_id,
                    supplier.document_id,
                    supplier.document_number,
                    supplier.document_status,
                    supplier.paid,
                    supplier.paid_on,
                    supplier.confidence,
                    supplier.is_actual,
                    supplier.description,
                    supplier.hours,
                    supplier.account_code,
                    supplier.business_unit,
                    supplier.match_method,
                    supplier.incomplete_invoice
                   FROM supplier
                UNION ALL
                 SELECT fact.job_id,
                    fact.event_date,
                    fact.lane,
                    fact.lane_detail,
                    fact.party_kind,
                    fact.party_id,
                    fact.party,
                    fact.amount_ex,
                    fact.source,
                    fact.source_id,
                    fact.document_id,
                    fact.document_number,
                    fact.document_status,
                    fact.paid,
                    fact.paid_on,
                    fact.confidence,
                    fact.is_actual,
                    fact.description,
                    fact.hours,
                    fact.account_code,
                    fact.business_unit,
                    fact.match_method,
                    fact.incomplete_invoice
                   FROM fact) s
             JOIN v_supplier_credit_allocations a ON a.xero_invoice_id = s.document_id AND a.counts_from_credit_note
          WHERE s.amount_ex <> 0::numeric
        ), ledger_credit AS (
         SELECT l.job_id,
            l.credit_note_date AS event_date,
                CASE
                    WHEN l.account_code = ANY (ARRAY['306'::text, '301'::text]) THEN 'labour'::text
                    WHEN l.account_code ~ '^3[0-9]{2}$'::text THEN 'materials'::text
                    ELSE 'other'::text
                END AS lane,
            COALESCE(l.account_code, 'no_account'::text) AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(l.contact_name), ''::text), 'Unnamed supplier'::text) AS party,
            l.amount_ex_gst AS amount_ex,
            'supplier_credit'::text AS source,
            ((l.xero_credit_note_id || ':'::text) || l.xero_line_item_id) || ':ledger_credit'::text AS source_id,
            l.xero_credit_note_id AS document_id,
            l.credit_note_number AS document_number,
            l.status AS document_status,
            l.status = 'PAID'::text AS paid,
            NULL::date AS paid_on,
            'high'::text AS confidence,
            true AS is_actual,
            ('Supplier credit note '::text || COALESCE(l.credit_note_number, '(no number)'::text)) || ' placed by Bookkeeping'::text AS description,
            NULL::numeric AS hours,
            l.account_code,
            NULL::text AS business_unit,
            'bookkeeping_evidence'::text AS match_method,
            false AS incomplete_invoice
           FROM ledger_cn l
        ), po_base AS (
         SELECT p.id,
            p.job_id,
            p.po_number,
            p.supplier_name,
            p.status,
            p.notes,
            p.delivery_date,
            p.created_at,
            p.invoice_received_at,
                CASE
                    WHEN p.subtotal > 0::numeric THEN p.subtotal
                    WHEN p.total > 0::numeric THEN p.total / 1.1
                    ELSE NULL::numeric
                END AS po_amount_ex,
            NOT (COALESCE(p.subtotal, 0::numeric) > 0::numeric OR COALESCE(p.total, 0::numeric) > 0::numeric) AS unpriced,
            COALESCE(( SELECT min(oe.sent_at) AS min
                   FROM job_order_emails oe
                  WHERE oe.purchase_order_id = p.id AND oe.status = 'sent'::text AND oe.sent_at IS NOT NULL), p.last_sent_at, p.created_at) AS ordered_at
           FROM purchase_orders p
          WHERE p.job_id IS NOT NULL AND p.xero_bill_id IS NULL AND NOT (EXISTS ( SELECT 1
                   FROM job_materials_facts f
                  WHERE f.matched_po_id = p.id AND f.kind = 'actual'::text)) AND (lower(COALESCE(p.status, ''::text)) <> ALL (ARRAY['draft'::text, 'billed'::text, 'cancelled'::text, 'canceled'::text, 'void'::text, 'voided'::text, 'deleted'::text]))
        ), po_state AS (
         SELECT b.id,
            b.job_id,
            b.po_number,
            b.supplier_name,
            b.status,
            b.notes,
            b.delivery_date,
            b.created_at,
            b.invoice_received_at,
            b.po_amount_ex,
            b.unpriced,
            b.ordered_at,
                CASE
                    WHEN b.invoice_received_at IS NOT NULL THEN 'po_invoice_emailed'::text
                    WHEN b.unpriced THEN 'po_ordered'::text
                    ELSE 'po_committed'::text
                END AS state
           FROM po_base b
        ), po AS (
         SELECT s.job_id,
                CASE s.state
                    WHEN 'po_invoice_emailed'::text THEN (s.invoice_received_at AT TIME ZONE 'Australia/Perth'::text)::date
                    WHEN 'po_ordered'::text THEN (s.ordered_at AT TIME ZONE 'Australia/Perth'::text)::date
                    ELSE COALESCE(s.delivery_date, s.created_at::date)
                END AS event_date,
            'materials'::text AS lane,
            'purchase_order'::text AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(s.supplier_name), ''::text), 'Unnamed supplier'::text) AS party,
                CASE
                    WHEN s.unpriced THEN NULL::numeric
                    ELSE s.po_amount_ex
                END AS amount_ex,
            s.state AS source,
            s.id::text AS source_id,
            s.id::text AS document_id,
            s.po_number AS document_number,
            s.status AS document_status,
            false AS paid,
            NULL::date AS paid_on,
                CASE s.state
                    WHEN 'po_invoice_emailed'::text THEN 'invoice_emailed'::text
                    WHEN 'po_ordered'::text THEN 'ordered_not_billed'::text
                    ELSE 'committed'::text
                END AS confidence,
            false AS is_actual,
            s.notes AS description,
            NULL::numeric AS hours,
            NULL::text AS account_code,
            NULL::text AS business_unit,
            'purchase_orders.job_id'::text AS match_method,
            false AS incomplete_invoice
           FROM po_state s
        )
 SELECT trade.job_id,
    trade.event_date,
    trade.lane,
    trade.lane_detail,
    trade.party_kind,
    trade.party_id,
    trade.party,
    trade.amount_ex,
    trade.source,
    trade.source_id,
    trade.document_id,
    trade.document_number,
    trade.document_status,
    trade.paid,
    trade.paid_on,
    trade.confidence,
    trade.is_actual,
    trade.description,
    trade.hours,
    trade.account_code,
    trade.business_unit,
    trade.match_method,
    trade.incomplete_invoice
   FROM trade
UNION ALL
 SELECT trade_employer_super.job_id,
    trade_employer_super.event_date,
    trade_employer_super.lane,
    trade_employer_super.lane_detail,
    trade_employer_super.party_kind,
    trade_employer_super.party_id,
    trade_employer_super.party,
    trade_employer_super.amount_ex,
    trade_employer_super.source,
    trade_employer_super.source_id,
    trade_employer_super.document_id,
    trade_employer_super.document_number,
    trade_employer_super.document_status,
    trade_employer_super.paid,
    trade_employer_super.paid_on,
    trade_employer_super.confidence,
    trade_employer_super.is_actual,
    trade_employer_super.description,
    trade_employer_super.hours,
    trade_employer_super.account_code,
    trade_employer_super.business_unit,
    trade_employer_super.match_method,
    trade_employer_super.incomplete_invoice
   FROM trade_employer_super
UNION ALL
 SELECT supplier.job_id,
    supplier.event_date,
    supplier.lane,
    supplier.lane_detail,
    supplier.party_kind,
    supplier.party_id,
    supplier.party,
    supplier.amount_ex,
    supplier.source,
    supplier.source_id,
    supplier.document_id,
    supplier.document_number,
    supplier.document_status,
    supplier.paid,
    supplier.paid_on,
    supplier.confidence,
    supplier.is_actual,
    supplier.description,
    supplier.hours,
    supplier.account_code,
    supplier.business_unit,
    supplier.match_method,
    supplier.incomplete_invoice
   FROM supplier
UNION ALL
 SELECT fact.job_id,
    fact.event_date,
    fact.lane,
    fact.lane_detail,
    fact.party_kind,
    fact.party_id,
    fact.party,
    fact.amount_ex,
    fact.source,
    fact.source_id,
    fact.document_id,
    fact.document_number,
    fact.document_status,
    fact.paid,
    fact.paid_on,
    fact.confidence,
    fact.is_actual,
    fact.description,
    fact.hours,
    fact.account_code,
    fact.business_unit,
    fact.match_method,
    fact.incomplete_invoice
   FROM fact
UNION ALL
 SELECT supplier_credit.job_id,
    supplier_credit.event_date,
    supplier_credit.lane,
    supplier_credit.lane_detail,
    supplier_credit.party_kind,
    supplier_credit.party_id,
    supplier_credit.party,
    supplier_credit.amount_ex,
    supplier_credit.source,
    supplier_credit.source_id,
    supplier_credit.document_id,
    supplier_credit.document_number,
    supplier_credit.document_status,
    supplier_credit.paid,
    supplier_credit.paid_on,
    supplier_credit.confidence,
    supplier_credit.is_actual,
    supplier_credit.description,
    supplier_credit.hours,
    supplier_credit.account_code,
    supplier_credit.business_unit,
    supplier_credit.match_method,
    supplier_credit.incomplete_invoice
   FROM supplier_credit
UNION ALL
 SELECT fact_credit.job_id,
    fact_credit.event_date,
    fact_credit.lane,
    fact_credit.lane_detail,
    fact_credit.party_kind,
    fact_credit.party_id,
    fact_credit.party,
    fact_credit.amount_ex,
    fact_credit.source,
    fact_credit.source_id,
    fact_credit.document_id,
    fact_credit.document_number,
    fact_credit.document_status,
    fact_credit.paid,
    fact_credit.paid_on,
    fact_credit.confidence,
    fact_credit.is_actual,
    fact_credit.description,
    fact_credit.hours,
    fact_credit.account_code,
    fact_credit.business_unit,
    fact_credit.match_method,
    fact_credit.incomplete_invoice
   FROM fact_credit
UNION ALL
 SELECT credit_note.job_id,
    credit_note.event_date,
    credit_note.lane,
    credit_note.lane_detail,
    credit_note.party_kind,
    credit_note.party_id,
    credit_note.party,
    credit_note.amount_ex,
    credit_note.source,
    credit_note.source_id,
    credit_note.document_id,
    credit_note.document_number,
    credit_note.document_status,
    credit_note.paid,
    credit_note.paid_on,
    credit_note.confidence,
    credit_note.is_actual,
    credit_note.description,
    credit_note.hours,
    credit_note.account_code,
    credit_note.business_unit,
    credit_note.match_method,
    credit_note.incomplete_invoice
   FROM credit_note
UNION ALL
 SELECT ledger_credit.job_id,
    ledger_credit.event_date,
    ledger_credit.lane,
    ledger_credit.lane_detail,
    ledger_credit.party_kind,
    ledger_credit.party_id,
    ledger_credit.party,
    ledger_credit.amount_ex,
    ledger_credit.source,
    ledger_credit.source_id,
    ledger_credit.document_id,
    ledger_credit.document_number,
    ledger_credit.document_status,
    ledger_credit.paid,
    ledger_credit.paid_on,
    ledger_credit.confidence,
    ledger_credit.is_actual,
    ledger_credit.description,
    ledger_credit.hours,
    ledger_credit.account_code,
    ledger_credit.business_unit,
    ledger_credit.match_method,
    ledger_credit.incomplete_invoice
   FROM ledger_credit
UNION ALL
 SELECT po.job_id,
    po.event_date,
    po.lane,
    po.lane_detail,
    po.party_kind,
    po.party_id,
    po.party,
    po.amount_ex,
    po.source,
    po.source_id,
    po.document_id,
    po.document_number,
    po.document_status,
    po.paid,
    po.paid_on,
    po.confidence,
    po.is_actual,
    po.description,
    po.hours,
    po.account_code,
    po.business_unit,
    po.match_method,
    po.incomplete_invoice
   FROM po;
DO $$ BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '33d1c54d5a288fe496b5b863a1ec1d4c' THEN
    RAISE EXCEPTION 'setup: v_job_cost_events does not render as production''s 20261104063000 (A4 V8) definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END $$;
