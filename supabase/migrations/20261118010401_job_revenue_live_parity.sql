-- Follow-up 29 (1)-(3): make a fresh registered stack match the director's
-- 18 Nov 2026 UTC live read. Live already has this view: no change there.
-- The registered stack omits 20261103200000; 20261104091000 preserves either
-- preimage, rather than wiping ledger evidence. Rehearsal and limits:
-- docs/evidence/followup-29-revenue-live-parity.md.
-- No rows, functions, grants, switches, triggers or schedules are changed.
DO $migration$
DECLARE
  before_hash text;
  live_hash constant text := 'cea985aadcb59a2f751b1f403176a39c';
  fresh_hash constant text := 'b8354d49625e92fdb4a52d81df3a761a'; BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '60s', true);
  PERFORM set_config('TimeZone', 'UTC', true);
  SELECT md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) INTO before_hash;
  IF before_hash = live_hash THEN
    RAISE NOTICE 'Follow-up 29: revenue already matches the verified live view';
    RETURN;
  END IF;
  IF before_hash IS DISTINCT FROM fresh_hash THEN
    RAISE EXCEPTION 'Follow-up 29: unexpected revenue preimage (md5 %); refusing to replace', before_hash;
  END IF;
  EXECUTE $view$CREATE OR REPLACE VIEW public.v_job_revenue_events AS
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
    job_cost_document_business_unit(x.line_items) AS business_unit,
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
  WHERE v.job_id IS NOT NULL
UNION ALL
 SELECT cv.job_id,
    'variation'::text AS kind,
    cv.approved_at::date AS invoice_date,
    cv.customer_price_ex AS amount_ex,
    cv.status,
    false AS paid,
    NULL::date AS paid_on,
    false AS counts_as_invoiced,
    'office_variation:'::text || cv.id AS source_id,
    cv.id::text AS document_id,
    'Work order variation '::text || cv.variation_number AS document_number,
    NULL::text AS party,
    cv.description,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    true AS agreed
   FROM work_order_customer_variations cv
  WHERE cv.status = 'approved'::text;
$view$;
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) IS DISTINCT FROM live_hash THEN
    RAISE EXCEPTION 'Follow-up 29: revenue postimage does not match the verified live hash';
  END IF;
END
$migration$;
