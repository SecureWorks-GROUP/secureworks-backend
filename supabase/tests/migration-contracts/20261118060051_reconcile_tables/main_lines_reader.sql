-- Exact P2-01.7 line view from main. Restore only this object, not its whole migration.
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
                   FROM public.job_cost_lines f
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
 SELECT p.job_id,l.document_date AS event_date,p.lane,l.event_lane_detail AS lane_detail,
 l.party_kind,l.party_id,l.party_name AS party,p.amount_ex,l.event_source AS source,
 coalesce(l.event_source_id,l.id::text) || CASE WHEN
  (SELECT count(*) FROM public.job_cost_line_parts s WHERE s.line_id=l.id)>1
  THEN ':part'||p.part_no::text ELSE '' END AS source_id,
 l.document_id,l.document_number,l.document_status,l.paid,l.paid_on,
 l.event_confidence AS confidence,l.is_actual,l.description,l.hours,l.account_code,
 l.business_unit,l.event_match_method AS match_method,l.incomplete_invoice,
 l.id AS cost_line_id,l.kind AS cost_kind
 FROM public.job_cost_line_parts p JOIN public.job_cost_lines l ON l.id=p.line_id
 WHERE p.target='job' AND l.state IS NOT NULL
 UNION ALL
 -- P2-03.1 replaces this typed, empty suggestion stand-in. No reconcile store
 -- exists yet; never invent a job for an installer bill awaiting a person.
 SELECT s.job_id,l.document_date,l.lane,l.event_lane_detail,
 l.party_kind,l.party_id,l.party_name,l.amount_ex,'installer_bill_unconfirmed'::text,
 coalesce(l.event_source_id,l.id::text),l.document_id,l.document_number,l.document_status,
 l.paid,l.paid_on,l.event_confidence,false,l.description,l.hours,l.account_code,
 l.business_unit,l.event_match_method,l.incomplete_invoice,l.id,l.kind
 FROM public.job_cost_lines l JOIN
 (SELECT NULL::text document_id,NULL::uuid job_id WHERE false) s ON s.document_id=l.document_id
 WHERE l.kind='installer_bill' AND l.state='needs_person'
 UNION ALL SELECT po.*,NULL::uuid,NULL::text FROM po;
