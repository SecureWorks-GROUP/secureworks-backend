-- Rollback of 20261104091000_job_revenue_credit_division: v_job_revenue_events back to its exact earlier definition
-- (md5 aeb851cd8d3d6e807cd7a5d620e020a8; in the registered migration-contract stack, ac208427bcf489ec12086cc08e3b9289). Refuses unless the view is the 20261104091000 definition (md5 2191799f0f51ef34b5fe90879e8387cb):
-- roll back later changes first. Re-running it is a no-op. Roll this back before 20261104090000 (it reads that
-- migration's job_cost_document_business_unit).

SET LOCAL lock_timeout = '5s';

DO $down$
DECLARE v text := md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
BEGIN
  IF v IN ('aeb851cd8d3d6e807cd7a5d620e020a8', 'ac208427bcf489ec12086cc08e3b9289') THEN
    RAISE NOTICE 'v_job_revenue_events is already the definition before 20261104091000';
    RETURN;
  END IF;
  IF v = '2191799f0f51ef34b5fe90879e8387cb' THEN
    EXECUTE $def$CREATE OR REPLACE VIEW public.v_job_revenue_events AS
 SELECT COALESCE(x.job_id, ev.job_id) AS job_id,
    'invoice_line'::text AS kind,
    x.invoice_date,
        CASE
            WHEN li.value ? '_header_ex'::text THEN job_profit_num(li.value -> '_header_ex'::text)
            WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
            ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
        END AS amount_ex,
    x.status,
    x.status = 'PAID'::text AS paid,
    x.fully_paid_on AS paid_on,
    x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]) AS counts_as_invoiced,
    (x.xero_invoice_id || ':'::text) || li.n AS source_id,
    x.xero_invoice_id AS document_id,
    x.invoice_number AS document_number,
    x.contact_name AS party,
    li.value ->> 'Description'::text AS description,
    li.value ->> 'AccountCode'::text AS account_code,
    ( SELECT t.value ->> 'Option'::text
           FROM jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(li.value -> 'Tracking'::text) = 'array'::text THEN li.value -> 'Tracking'::text
                    ELSE '[]'::jsonb
                END) t(value)
          WHERE (t.value ->> 'Name'::text) = 'Business Unit'::text
         LIMIT 1) AS business_unit,
    false AS agreed
   FROM xero_invoices x
     CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(x.line_items) = 'array'::text AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
            ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Invoice total (no lines stored)'))
        END) WITH ORDINALITY li(value, n)
     LEFT JOIN v_bookkeeping_line_evidence_current ev ON x.job_id IS NULL AND ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text) AND ev.allocation = 'job'::text AND ev.evidenced AND ev.job_id IS NOT NULL
  WHERE x.invoice_type = 'ACCREC'::text AND COALESCE(x.job_id, ev.job_id) IS NOT NULL AND (x.status <> ALL (ARRAY['VOIDED'::text, 'DELETED'::text]))
UNION ALL
 SELECT COALESCE(x.job_id, inv_ev.job_id) AS job_id,
    'credit_applied'::text AS kind,
    x.invoice_date,
    - round(x.sub_total * job_cost_credit_share(x.raw_json, x.total), 2) AS amount_ex,
    x.status,
    x.status = 'PAID'::text AS paid,
    x.fully_paid_on AS paid_on,
    true AS counts_as_invoiced,
    x.xero_invoice_id || ':credit'::text AS source_id,
    x.xero_invoice_id AS document_id,
    x.invoice_number AS document_number,
    x.contact_name AS party,
    'Credit applied in Xero'::text AS description,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    false AS agreed
   FROM xero_invoices x
     LEFT JOIN LATERAL ( SELECT
                CASE
                    WHEN count(*) > 0 AND count(*) = count(e.job_id) AND count(DISTINCT e.job_id) = 1 THEN (array_agg(e.job_id))[1]
                    ELSE NULL::uuid
                END AS job_id
           FROM jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(x.line_items) = 'array'::text THEN x.line_items
                    ELSE '[]'::jsonb
                END) l(value)
             LEFT JOIN v_bookkeeping_line_evidence_current e ON e.xero_invoice_id = x.xero_invoice_id AND e.xero_line_item_id = (l.value ->> 'LineItemID'::text) AND e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL
          WHERE COALESCE(job_profit_num(l.value -> 'LineAmount'::text), 0::numeric) <> 0::numeric) inv_ev ON x.job_id IS NULL
  WHERE x.invoice_type = 'ACCREC'::text AND COALESCE(x.job_id, inv_ev.job_id) IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND job_cost_credit_share(x.raw_json, x.total) > 0::numeric AND COALESCE(x.sub_total, 0::numeric) <> 0::numeric
UNION ALL
 SELECT v.job_id,
    'variation'::text AS kind,
    COALESCE(v.accepted_at, v.approved_at, v.sent_at, v.created_at)::date AS invoice_date,
        CASE
            WHEN v.gst_included THEN round(v.amount / 1.1, 2)
            ELSE v.amount
        END AS amount_ex,
    v.status,
    false AS paid,
    NULL::date AS paid_on,
    false AS counts_as_invoiced,
    v.id::text AS source_id,
    v.id::text AS document_id,
    'V'::text || v.variation_number AS document_number,
    NULL::text AS party,
    v.description,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    v.declined_at IS NULL AND (lower(COALESCE(v.status, ''::text)) <> ALL (ARRAY['declined'::text, 'rejected'::text])) AND (v.accepted_at IS NOT NULL OR (lower(COALESCE(v.status, ''::text)) = ANY (ARRAY['accepted'::text, 'invoiced'::text]))) AS agreed
   FROM job_variations v
  WHERE v.job_id IS NOT NULL;$def$;
  ELSIF v = '18c6f924719d2c53ca537e8d58d7555f' THEN
    -- the registered migration-contract stack (no 20261103200000): its own earlier definition
    EXECUTE $sdef$CREATE OR REPLACE VIEW public.v_job_revenue_events AS
 SELECT x.job_id,
    'invoice_line'::text AS kind,
    x.invoice_date,
        CASE
            WHEN li.value ? '_header_ex'::text THEN job_profit_num(li.value -> '_header_ex'::text)
            WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
            ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
        END AS amount_ex,
    x.status,
    x.status = 'PAID'::text AS paid,
    x.fully_paid_on AS paid_on,
    x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]) AS counts_as_invoiced,
    (x.xero_invoice_id || ':'::text) || li.n AS source_id,
    x.xero_invoice_id AS document_id,
    x.invoice_number AS document_number,
    x.contact_name AS party,
    li.value ->> 'Description'::text AS description,
    li.value ->> 'AccountCode'::text AS account_code,
    ( SELECT t.value ->> 'Option'::text
           FROM jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(li.value -> 'Tracking'::text) = 'array'::text THEN li.value -> 'Tracking'::text
                    ELSE '[]'::jsonb
                END) t(value)
          WHERE (t.value ->> 'Name'::text) = 'Business Unit'::text
         LIMIT 1) AS business_unit,
    false AS agreed
   FROM xero_invoices x
     CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(x.line_items) = 'array'::text AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
            ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Invoice total (no lines stored)'))
        END) WITH ORDINALITY li(value, n)
  WHERE x.invoice_type = 'ACCREC'::text AND x.job_id IS NOT NULL AND (x.status <> ALL (ARRAY['VOIDED'::text, 'DELETED'::text]))
UNION ALL
 SELECT x.job_id,
    'credit_applied'::text AS kind,
    x.invoice_date,
    - round(x.sub_total * job_cost_credit_share(x.raw_json, x.total), 2) AS amount_ex,
    x.status,
    x.status = 'PAID'::text AS paid,
    x.fully_paid_on AS paid_on,
    true AS counts_as_invoiced,
    x.xero_invoice_id || ':credit'::text AS source_id,
    x.xero_invoice_id AS document_id,
    x.invoice_number AS document_number,
    x.contact_name AS party,
    'Credit applied in Xero'::text AS description,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    false AS agreed
   FROM xero_invoices x
  WHERE x.invoice_type = 'ACCREC'::text AND x.job_id IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND job_cost_credit_share(x.raw_json, x.total) > 0::numeric AND COALESCE(x.sub_total, 0::numeric) <> 0::numeric
UNION ALL
 SELECT v.job_id,
    'variation'::text AS kind,
    COALESCE(v.accepted_at, v.approved_at, v.sent_at, v.created_at)::date AS invoice_date,
        CASE
            WHEN v.gst_included THEN round(v.amount / 1.1, 2)
            ELSE v.amount
        END AS amount_ex,
    v.status,
    false AS paid,
    NULL::date AS paid_on,
    false AS counts_as_invoiced,
    v.id::text AS source_id,
    v.id::text AS document_id,
    'V'::text || v.variation_number AS document_number,
    NULL::text AS party,
    v.description,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    v.declined_at IS NULL AND (lower(COALESCE(v.status, ''::text)) <> ALL (ARRAY['declined'::text, 'rejected'::text])) AND (v.accepted_at IS NOT NULL OR (lower(COALESCE(v.status, ''::text)) = ANY (ARRAY['accepted'::text, 'invoiced'::text]))) AS agreed
   FROM job_variations v
  WHERE v.job_id IS NOT NULL;$sdef$;
  ELSE
    RAISE EXCEPTION 'v_job_revenue_events is not the 20261104091000 definition (md5 %); roll back later changes first', v;
  END IF;
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) NOT IN ('aeb851cd8d3d6e807cd7a5d620e020a8', 'ac208427bcf489ec12086cc08e3b9289') THEN
    RAISE EXCEPTION 'v_job_revenue_events after the rollback is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
  END IF;
END
$down$;
