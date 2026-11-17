-- P2-10.2 rollback. Drop the order trigger first, then restore main's reader
-- (P2-01.7 plus P2-03.1, md5 c98dd14a) and drop this migration's functions.
SET LOCAL lock_timeout = '5s';
DO $guard$ DECLARE h text;
/* block */ BEGIN
 h:=md5(pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true));
 IF h NOT IN ('6bcae603f8c25b97fc5ea9d9d7669a9d','c98dd14a51e982b78493c3385b25c9d9') THEN
  RAISE EXCEPTION 'P2-10.2 rollback: cost line reader changed'; END IF;
END $guard$;
DROP TRIGGER IF EXISTS dispatch_order_commitment ON public.dispatch_supplier_order_emails;
CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS
 WITH po_base AS (
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
                   FROM job_cost_lines f
                  WHERE f.order_kind = 'purchase_order'::text AND f.order_id = p.id::text AND f.state IS NOT NULL)) AND (lower(COALESCE(p.status, ''::text)) <> ALL (ARRAY['draft'::text, 'billed'::text, 'cancelled'::text, 'canceled'::text, 'void'::text, 'voided'::text, 'deleted'::text]))
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
 SELECT p.job_id,
    l.document_date AS event_date,
    p.lane,
    l.event_lane_detail AS lane_detail,
    l.party_kind,
    l.party_id,
    l.party_name AS party,
    p.amount_ex,
    l.event_source AS source,
    COALESCE(l.event_source_id, l.id::text) ||
        CASE
            WHEN (( SELECT count(*) AS count
               FROM job_cost_line_parts s
              WHERE s.line_id = l.id)) > 1 THEN ':part'::text || p.part_no::text
            ELSE ''::text
        END AS source_id,
    l.document_id,
    l.document_number,
    l.document_status,
    l.paid,
    l.paid_on,
    l.event_confidence AS confidence,
    l.is_actual,
    l.description,
    l.hours,
    l.account_code,
    l.business_unit,
    l.event_match_method AS match_method,
    l.incomplete_invoice,
    l.id AS cost_line_id,
    l.kind AS cost_kind
   FROM job_cost_line_parts p
     JOIN job_cost_lines l ON l.id = p.line_id
  WHERE p.target = 'job'::text AND l.state IS NOT NULL
UNION ALL
 SELECT s.job_id,
    l.document_date AS event_date,
    l.lane,
    l.event_lane_detail AS lane_detail,
    l.party_kind,
    l.party_id,
    l.party_name AS party,
    l.amount_ex,
    'installer_bill_unconfirmed'::text AS source,
    COALESCE(l.event_source_id, l.id::text) AS source_id,
    l.document_id,
    l.document_number,
    l.document_status,
    l.paid,
    l.paid_on,
    l.event_confidence AS confidence,
    false AS is_actual,
    l.description,
    l.hours,
    l.account_code,
    l.business_unit,
    l.event_match_method AS match_method,
    l.incomplete_invoice,
    l.id AS cost_line_id,
    l.kind AS cost_kind
   FROM job_cost_lines l
     JOIN LATERAL ( SELECT (array_agg(DISTINCT (ri.suggestion ->> 'job_id'::text)::uuid))[1] AS job_id
           FROM reconcile_items ri
          WHERE ri.status = 'open'::text AND ri.subject_table = 'cost_document'::text AND ri.subject_id = ((l.document_kind || ':'::text) || l.document_id) AND ri.org_id = l.org_id AND (ri.suggestion ->> 'job_id'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text
         HAVING count(DISTINCT (ri.suggestion ->> 'job_id'::text)::uuid) = 1) s ON true
  WHERE l.kind = 'installer_bill'::text AND l.state = 'needs_person'::text
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
    po.incomplete_invoice,
    NULL::uuid AS cost_line_id,
    NULL::text AS cost_kind
   FROM po;
DO $restored$
/* block */ BEGIN
 IF md5(pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true))<>'c98dd14a51e982b78493c3385b25c9d9' THEN
  RAISE EXCEPTION 'P2-10.2 rollback: main reader not restored'; END IF;
END $restored$;
REVOKE ALL ON public.v_job_cost_events_lines FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_job_cost_events_lines TO service_role;
DROP FUNCTION IF EXISTS public.install_dispatch_order_commitment();
DROP FUNCTION IF EXISTS public.remove_dispatch_order_commitment();
DROP FUNCTION IF EXISTS public.dispatch_order_commitment_trg();
DROP FUNCTION IF EXISTS public.dispatch_order_rematch_subjects(uuid,text,text);
