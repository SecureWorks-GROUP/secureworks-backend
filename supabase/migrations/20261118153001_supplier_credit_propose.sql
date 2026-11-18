-- P3-02.3: bounded index-backed reads and atomic proposal + Reconcile list raise
-- for supplier credit PDFs stored in context_email_attachments.
-- Creates three partial indexes and three service_role-only functions only:
-- no table rewrite, no trigger, no schedule, no switch change, no row write.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE r record;
/* block */ BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS body
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'supplier_credit_candidate_attachments',
        'supplier_credit_matching_bills',
        'supplier_credit_record_proposal'
      )
  LOOP
    IF (r.sig, r.body) NOT IN (
      ('supplier_credit_candidate_attachments(uuid,timestamp with time zone,integer,uuid[])', '13effc40a91ae574f74a6f153350ef8a'),
      ('supplier_credit_matching_bills(uuid,text)', '499d35fdd2681eb569b656de3fe607b5'),
      ('supplier_credit_record_proposal(uuid,uuid,text,text,text,text,text,date,numeric,numeric,text,text,uuid,jsonb,jsonb,jsonb)', 'aa7f1e92d96d40cb8fae3326c4b51616')
    ) THEN
      RAISE EXCEPTION 'supplier_credit_propose_function_drift'
        USING DETAIL = r.sig;
    END IF;
  END LOOP;
END $guard$;

-- Plain index lock/build justification (director ruling 18 Nov 15:14, lock_timeout 5s):
-- 1. context_email_attachments_stored_pdf_created_idx: needed (no created_at/status index on main; prevents oldest-first Seq Scan + Sort); ~16,400 live rows builds in <50 ms (25.3 ms measured on 100k rows in PG17).
-- 2. supplier_credit_drafts_org_source_attachment_idx: needed (no source_attachment_id index on main; prevents org anti-join scan); 0 live rows (empty table, switch off) builds in <5 ms.
-- 3. xero_invoices_accpay_org_lower_number_idx: needed (no invoice_number index on main; prevents ACCPAY Seq Scan); ~5,200 live rows builds in <50 ms (30.6 ms measured on 100k rows in PG17).
CREATE INDEX IF NOT EXISTS context_email_attachments_stored_pdf_created_idx
  ON public.context_email_attachments (created_at ASC, id ASC)
  WHERE status = 'stored' AND content_type = 'application/pdf';

CREATE INDEX IF NOT EXISTS supplier_credit_drafts_org_source_attachment_idx
  ON public.supplier_credit_drafts (org_id, source_attachment_id)
  WHERE source_attachment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS xero_invoices_accpay_org_lower_number_idx
  ON public.xero_invoices (org_id, lower(invoice_number))
  WHERE invoice_type = 'ACCPAY' AND invoice_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.supplier_credit_candidate_attachments(
  p_org_id uuid,
  p_since timestamptz,
  p_limit integer DEFAULT 10,
  p_exclude_ids uuid[] DEFAULT '{}'
) RETURNS TABLE (
  id uuid,
  file_name text,
  content_type text,
  storage_bucket text,
  storage_path text,
  status text,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $fn$
/* block */ BEGIN
  IF p_org_id IS NULL OR p_since IS NULL OR coalesce(p_limit, 10) <= 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id, a.file_name, a.content_type, a.storage_bucket, a.storage_path, a.status, a.created_at
  FROM public.context_email_attachments a
  WHERE a.status = 'stored'
    AND a.content_type = 'application/pdf'
    AND a.created_at >= p_since
    AND (
      a.file_name ILIKE '%credit%'
      OR a.file_name ILIKE '%adjust%'
      OR a.file_name ILIKE '%cn%'
    )
    AND NOT (a.id = ANY(coalesce(p_exclude_ids, '{}')))
    AND NOT EXISTS (
      SELECT 1
      FROM public.supplier_credit_drafts d
      WHERE d.org_id = p_org_id
        AND d.source_attachment_id IS NOT NULL
        AND d.source_attachment_id = a.id
    )
  ORDER BY a.created_at ASC, a.id ASC
  LIMIT coalesce(p_limit, 10);
END $fn$;

CREATE OR REPLACE FUNCTION public.supplier_credit_matching_bills(
  p_org_id uuid,
  p_bill_number text
) RETURNS TABLE (
  xero_invoice_id text,
  invoice_number text,
  xero_contact_id text,
  contact_name text,
  job_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_bill text := nullif(btrim(coalesce(p_bill_number, '')), '');
/* block */ BEGIN
  IF p_org_id IS NULL OR v_bill IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    x.xero_invoice_id,
    x.invoice_number,
    x.xero_contact_id,
    x.contact_name,
    (SELECT j.id FROM public.jobs j WHERE j.id = x.job_id AND j.org_id = p_org_id) AS job_id
  FROM public.xero_invoices x
  WHERE x.org_id = p_org_id
    AND x.invoice_type = 'ACCPAY'
    AND x.invoice_number IS NOT NULL
    AND lower(x.invoice_number) = lower(v_bill)
  ORDER BY x.xero_invoice_id ASC
  LIMIT 2;
END $fn$;

CREATE OR REPLACE FUNCTION public.supplier_credit_record_proposal(
  p_org_id uuid,
  p_source_attachment_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_xero_contact_id text,
  p_supplier_name text,
  p_credit_number text,
  p_credit_date date,
  p_amount_ex numeric(12,2),
  p_amount_inc numeric(12,2),
  p_names_bill_number text,
  p_matched_bill_xero_invoice_id text,
  p_matched_job_id uuid,
  p_match_reasons jsonb,
  p_suggestion jsonb,
  p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_contact_id text := nullif(btrim(coalesce(p_xero_contact_id, '')), '');
  v_credit_no text := nullif(btrim(coalesce(p_credit_number, '')), '');
  v_supplier text := nullif(btrim(coalesce(p_supplier_name, '')), '');
  v_is_duplicate boolean := false;
  v_state text;
  v_draft_id uuid;
  v_item_id uuid;
  v_job_ids uuid[];
/* block */ BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'supplier_credit_org_required';
  END IF;
  IF v_supplier IS NULL OR v_credit_no IS NULL THEN
    RAISE EXCEPTION 'supplier_credit_identity_required';
  END IF;

  IF v_contact_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.xero_supplier_credit_notes c
      WHERE c.org_id = p_org_id
        AND c.xero_contact_id = v_contact_id
        AND c.credit_note_number IS NOT NULL
        AND lower(c.credit_note_number) = lower(v_credit_no)
    ) INTO v_is_duplicate;
  END IF;

  v_state := CASE WHEN v_is_duplicate THEN 'duplicate' ELSE 'proposed' END;

  INSERT INTO public.supplier_credit_drafts (
    org_id,
    source_attachment_id,
    storage_bucket,
    storage_path,
    xero_contact_id,
    supplier_name,
    credit_number,
    credit_date,
    amount_ex,
    amount_inc,
    names_bill_number,
    matched_bill_xero_invoice_id,
    matched_job_id,
    match_reasons,
    state
  ) VALUES (
    p_org_id,
    p_source_attachment_id,
    p_storage_bucket,
    p_storage_path,
    v_contact_id,
    v_supplier,
    v_credit_no,
    p_credit_date,
    p_amount_ex,
    p_amount_inc,
    p_names_bill_number,
    p_matched_bill_xero_invoice_id,
    p_matched_job_id,
    coalesce(p_match_reasons, '[]'::jsonb),
    v_state
  )
  ON CONFLICT (org_id, (lower(supplier_name)), credit_number) DO NOTHING
  RETURNING id INTO v_draft_id;

  IF v_draft_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'already_exists');
  END IF;

  IF v_state = 'duplicate' THEN
    RETURN jsonb_build_object('outcome', 'duplicate', 'draft_id', v_draft_id);
  END IF;

  v_job_ids := CASE WHEN p_matched_job_id IS NOT NULL THEN ARRAY[p_matched_job_id] ELSE '{}'::uuid[] END;
  v_item_id := public.reconcile_item_raise(
    'credit_note_proposed',
    'supplier_credit_drafts',
    v_draft_id::text,
    v_job_ids,
    p_suggestion,
    p_evidence,
    'phase3:books'
  );

  RETURN jsonb_build_object(
    'outcome', 'proposed',
    'draft_id', v_draft_id,
    'reconcile_item_id', v_item_id
  );
END $fn$;

COMMENT ON FUNCTION public.supplier_credit_candidate_attachments(uuid, timestamptz, integer, uuid[]) IS
  'P3-02.3: oldest-first stored credit PDF attachments in the window not yet recorded on supplier_credit_drafts. Service role only.';
COMMENT ON FUNCTION public.supplier_credit_matching_bills(uuid, text) IS
  'P3-02.3: up to two ACCPAY bills in the organisation matching the named invoice number ignoring case. Service role only.';
COMMENT ON FUNCTION public.supplier_credit_record_proposal(uuid, uuid, text, text, text, text, text, date, numeric, numeric, text, text, uuid, jsonb, jsonb, jsonb) IS
  'P3-02.3: atomically records a supplier credit proposal (or duplicate) and raises credit_note_proposed via reconcile_item_raise. Service role only.';

REVOKE ALL ON FUNCTION
  public.supplier_credit_candidate_attachments(uuid, timestamptz, integer, uuid[]),
  public.supplier_credit_matching_bills(uuid, text),
  public.supplier_credit_record_proposal(uuid, uuid, text, text, text, text, text, date, numeric, numeric, text, text, uuid, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.supplier_credit_candidate_attachments(uuid, timestamptz, integer, uuid[]),
  public.supplier_credit_matching_bills(uuid, text),
  public.supplier_credit_record_proposal(uuid, uuid, text, text, text, text, text, date, numeric, numeric, text, text, uuid, jsonb, jsonb, jsonb)
  TO service_role;
