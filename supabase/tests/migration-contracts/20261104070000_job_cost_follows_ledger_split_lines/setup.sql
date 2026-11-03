-- Prerequisites for 20261104070000 to 20261104072000 (Job Profit A6 cost rules). These migrations are written
-- against v_job_cost_events as 20261104063000 (A4 V8) leaves it; that case's setup put production's definition in
-- the stack, and its migration then ran in the walk. Bookkeeping's current line-evidence view has no loader in the
-- stack: a table with production's columns stands in for it (also made by A4 V8's setup). The revisions table and
-- classifier (production's, for the split-parts load) are added when the stack has none.
DO $$
BEGIN
  IF to_regclass('public.v_job_cost_events') IS NULL OR to_regclass('public.v_supplier_credit_allocations') IS NULL
     OR to_regclass('public.xero_supplier_credit_notes') IS NULL OR to_regprocedure('public.job_cost_installer_bill(jsonb)') IS NULL
     OR to_regprocedure('public.job_cost_credit_share(jsonb,numeric)') IS NULL OR to_regclass('public.feature_flags') IS NULL
     OR to_regclass('public.job_materials_facts') IS NULL OR to_regprocedure('public.job_cost_bill_line_job_id(text)') IS NULL THEN
    RAISE EXCEPTION 'A6 cost rules prerequisites missing: the job cost engine, supplier credit netting, feature_flags or A4 V8';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.v_bookkeeping_line_evidence_current (
  xero_invoice_id text, xero_line_item_id text, amount_ex_gst numeric, allocation text, job_number text, job_id uuid,
  evidenced boolean, basis text, outcome text, document_ref text, trade_invoice_line_id uuid, revision text, stream text,
  emitted_at timestamp with time zone, revision_sha256 text);

CREATE TABLE IF NOT EXISTS public.bookkeeping_evidence_revisions (
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
