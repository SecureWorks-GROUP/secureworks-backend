-- Rollback for 20261102130000_job_cost_bookkeeping_evidence_placement:
-- restores v_job_cost_events exactly as it was (md5 92d9a2923438e6a1da601e2179ae34e3) and the
-- cfo_bill_cost_outcomes_scoped via_lines expression. Writes no row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE VIEW public.v_job_cost_events AS
 WITH trade_mirror_bill AS (
         SELECT x.xero_invoice_id
           FROM xero_invoices x
          WHERE ((x.invoice_type = 'ACCPAY'::text) AND ((EXISTS ( SELECT 1
                   FROM trade_invoices t
                  WHERE (t.xero_bill_id = x.xero_invoice_id))) OR (EXISTS ( SELECT 1
                   FROM jsonb_array_elements(
                        CASE
                            WHEN (jsonb_typeof(x.line_items) = 'array'::text) THEN x.line_items
                            ELSE '[]'::jsonb
                        END) li(value)
                  WHERE ((li.value ->> 'Description'::text) ~ '\| SW - [A-Z]'::text)))))
        ), trade AS (
         SELECT r.resolved_job_id AS job_id,
            COALESCE(r.line_date, r.week_start) AS event_date,
                CASE
                    WHEN (r.cost_lane = 'unclassified'::text) THEN 'other'::text
                    ELSE r.cost_lane
                END AS lane,
            r.cost_lane AS lane_detail,
            'trade'::text AS party_kind,
            (r.user_id)::text AS party_id,
            COALESCE(NULLIF(btrim(u.name), ''::text), 'Unnamed trade'::text) AS party,
            r.line_total_ex AS amount_ex,
            'trade_line'::text AS source,
            (r.line_id)::text AS source_id,
            (ti.id)::text AS document_id,
            ti.invoice_number AS document_number,
            ti.status AS document_status,
            ((ti.status = 'paid'::text) OR (upper(COALESCE(ti.xero_bill_status, ''::text)) = 'PAID'::text)) AS paid,
            ti.paid_at AS paid_on,
                CASE r.match_method
                    WHEN 'job_id'::text THEN 'high'::text
                    WHEN 'line_job_number'::text THEN 'medium'::text
                    ELSE 'low'::text
                END AS confidence,
            (r.cost_lane <> 'advance'::text) AS is_actual,
            r.description,
            r.total_hours AS hours,
            NULL::text AS account_code,
            NULL::text AS business_unit,
            r.match_method,
            COALESCE((c.zero_line OR c.mismatch), false) AS incomplete_invoice
           FROM (((v_trade_charge_resolved r
             JOIN trade_invoices ti ON ((ti.id = r.trade_invoice_id)))
             LEFT JOIN users u ON ((u.id = r.user_id)))
             LEFT JOIN v_invoice_line_completeness c ON ((c.trade_invoice_id = r.trade_invoice_id)))
          WHERE ((r.resolved_job_id IS NOT NULL) AND (NOT r.is_probable_test_line) AND (ti.status <> 'ops-reject'::text) AND (upper(COALESCE(ti.xero_bill_status, ''::text)) <> ALL (ARRAY['DELETED'::text, 'VOIDED'::text])))
        ), trade_employer_super AS (
         SELECT t.job_id,
            t.event_date,
            t.lane,
            'employer_super'::text AS lane_detail,
            t.party_kind,
            t.party_id,
            t.party,
            round(((t.amount_ex * s.employer_super_ex) / s.subtotal_ex), 6) AS amount_ex,
            'trade_employer_super'::text AS source,
            (t.source_id || ':employer_super'::text) AS source_id,
            t.document_id,
            t.document_number,
            t.document_status,
            false AS paid,
            NULL::date AS paid_on,
            t.confidence,
            t.is_actual,
            ('Employer super on: '::text || COALESCE(t.description, ''::text)) AS description,
            NULL::numeric AS hours,
            t.account_code,
            t.business_unit,
            t.match_method,
            t.incomplete_invoice
           FROM (trade t
             JOIN ( SELECT (ti.id)::text AS document_id,
                    ti.subtotal_ex,
                    (ti.super_amount - (ti.subtotal_ex - ti.net_pay)) AS employer_super_ex
                   FROM trade_invoices ti
                  WHERE ((ti.super_amount IS NOT NULL) AND (ti.net_pay IS NOT NULL) AND (ti.subtotal_ex > (0)::numeric))) s ON ((s.document_id = t.document_id)))
          WHERE ((s.employer_super_ex > 0.005) AND (t.amount_ex <> (0)::numeric) AND (EXISTS ( SELECT 1
                   FROM feature_flags ff
                  WHERE ((ff.flag_name = 'job_cost_employer_super_v1'::text) AND ff.enabled))))
        ), bill_line AS (
         SELECT x.job_id,
            x.invoice_date,
            x.xero_invoice_id,
            x.invoice_number,
            x.contact_name,
            x.status,
            x.fully_paid_on,
            li.n,
            li.value AS line,
                CASE
                    WHEN (li.value ? '_header_ex'::text) THEN job_profit_num((li.value -> '_header_ex'::text))
                    WHEN ((x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text) THEN (COALESCE(job_profit_num((li.value -> 'LineAmount'::text)), (0)::numeric) - COALESCE(job_profit_num((li.value -> 'TaxAmount'::text)), (0)::numeric))
                    ELSE COALESCE(job_profit_num((li.value -> 'LineAmount'::text)), (0)::numeric)
                END AS amount_ex,
            job_cost_credit_share(x.raw_json, x.total) AS credit_share,
                CASE
                    WHEN (NOT job_cost_installer_bill(x.line_items)) THEN 'not_installer'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM job_materials_facts f
                      WHERE ((f.xero_invoice_id = x.xero_invoice_id) AND (f.job_id = x.job_id) AND (f.automation_source = ANY (ARRAY['manual_queue'::text, 'agent_ai'::text]))))) THEN 'confirmed'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM materials_reconciliation_queue q
                      WHERE ((q.xero_invoice_id = x.xero_invoice_id) AND (q.status = 'not_job_related'::text)))) THEN 'not_job_related'::text
                    ELSE 'unconfirmed'::text
                END AS installer_state
           FROM (xero_invoices x
             CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN ((jsonb_typeof(x.line_items) = 'array'::text) AND (jsonb_array_length(x.line_items) > 0)) THEN x.line_items
                    ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Bill total (no lines stored)'))
                END) WITH ORDINALITY li(value, n))
          WHERE ((x.invoice_type = 'ACCPAY'::text) AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND (x.job_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM trade_mirror_bill m
                  WHERE (m.xero_invoice_id = x.xero_invoice_id)))) AND (NOT (EXISTS ( SELECT 1
                   FROM job_materials_facts f
                  WHERE ((f.xero_invoice_id = x.xero_invoice_id) AND ((f.job_id IS DISTINCT FROM x.job_id) OR (f.automation_source = 'manual_split'::text)))))) AND (NOT (EXISTS ( SELECT 1
                   FROM materials_reconciliation_queue q
                  WHERE ((q.xero_invoice_id = x.xero_invoice_id) AND (COALESCE(q.overhead_ex, (0)::numeric) > (0)::numeric))))))
        ), supplier AS (
         SELECT b.job_id,
            b.invoice_date AS event_date,
                CASE
                    WHEN (COALESCE((b.line ->> 'Description'::text), ''::text) ~* 'commission'::text) THEN 'commission'::text
                    WHEN ((b.line ->> 'AccountCode'::text) = ANY (ARRAY['306'::text, '301'::text])) THEN 'labour'::text
                    WHEN ((b.line ->> 'AccountCode'::text) ~ '^3[0-9]{2}$'::text) THEN 'materials'::text
                    ELSE 'other'::text
                END AS lane,
            COALESCE((b.line ->> 'AccountCode'::text), 'no_account'::text) AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(b.contact_name), ''::text), 'Unnamed supplier'::text) AS party,
            b.amount_ex,
                CASE b.installer_state
                    WHEN 'unconfirmed'::text THEN 'installer_bill_unconfirmed'::text
                    WHEN 'not_job_related'::text THEN 'installer_bill_not_job_related'::text
                    ELSE 'supplier_bill'::text
                END AS source,
            ((b.xero_invoice_id || ':'::text) || b.n) AS source_id,
            b.xero_invoice_id AS document_id,
            b.invoice_number AS document_number,
            b.status AS document_status,
            (b.status = 'PAID'::text) AS paid,
            b.fully_paid_on AS paid_on,
                CASE b.installer_state
                    WHEN 'unconfirmed'::text THEN 'awaiting_confirmation'::text
                    WHEN 'not_job_related'::text THEN 'person_marked_not_job_related'::text
                    ELSE 'high'::text
                END AS confidence,
            (b.installer_state <> ALL (ARRAY['unconfirmed'::text, 'not_job_related'::text])) AS is_actual,
            (b.line ->> 'Description'::text) AS description,
            NULL::numeric AS hours,
            (b.line ->> 'AccountCode'::text) AS account_code,
            ( SELECT (t.value ->> 'Option'::text)
                   FROM jsonb_array_elements(
                        CASE
                            WHEN (jsonb_typeof((b.line -> 'Tracking'::text)) = 'array'::text) THEN (b.line -> 'Tracking'::text)
                            ELSE '[]'::jsonb
                        END) t(value)
                  WHERE ((t.value ->> 'Name'::text) = 'Business Unit'::text)
                 LIMIT 1) AS business_unit,
            'xero_invoices.job_id'::text AS match_method,
            false AS incomplete_invoice
           FROM bill_line b
        ), fact_base AS (
         SELECT f.job_id,
            f.fact_date AS event_date,
                CASE
                    WHEN (f.lane = ANY (ARRAY['labour'::text, 'materials'::text, 'commission'::text, 'other'::text])) THEN f.lane
                    ELSE 'materials'::text
                END AS lane,
            f.lane AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(f.contact_name), ''::text), 'Unnamed supplier'::text) AS party,
            f.amount_ex_gst AS amount_ex,
            'materials_fact'::text AS source,
            (f.id)::text AS source_id,
            f.xero_invoice_id AS document_id,
            f.invoice_number AS document_number,
            x.status AS document_status,
            COALESCE((x.status = 'PAID'::text), false) AS paid,
            x.fully_paid_on AS paid_on,
            COALESCE(f.confidence, 'unknown'::text) AS confidence,
            true AS is_actual,
            f.match_reason AS description,
            NULL::numeric AS hours,
            NULL::text AS account_code,
            NULL::text AS business_unit,
            COALESCE(f.automation_source, 'materials_fact'::text) AS match_method,
            false AS incomplete_invoice,
            COALESCE((x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])), false) AS bill_live,
            job_cost_credit_share(x.raw_json, x.total) AS credit_share,
            ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text, 'agent_ai'::text])) AND ((f.lane = 'labour'::text) OR job_cost_installer_bill(x.line_items))) AS installer_unconfirmed
           FROM (job_materials_facts f
             LEFT JOIN xero_invoices x ON (((x.xero_invoice_id = f.xero_invoice_id) AND (x.invoice_type = 'ACCPAY'::text))))
          WHERE ((f.kind = 'actual'::text) AND (f.job_id IS NOT NULL) AND (f.amount_ex_gst IS NOT NULL) AND (COALESCE(x.status, ''::text) <> ALL (ARRAY['VOIDED'::text, 'DELETED'::text])) AND (NOT (EXISTS ( SELECT 1
                   FROM trade_mirror_bill m
                  WHERE (m.xero_invoice_id = f.xero_invoice_id)))) AND (NOT (EXISTS ( SELECT 1
                   FROM bill_line b
                  WHERE ((b.xero_invoice_id = f.xero_invoice_id) AND (b.job_id = f.job_id))))))
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
            (NOT fact_base.installer_unconfirmed) AS is_actual,
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
            (- round((s.amount_ex * b.credit_share), 2)) AS amount_ex,
                CASE
                    WHEN s.is_actual THEN 'supplier_credit'::text
                    ELSE s.source
                END AS source,
            (s.source_id || ':credit'::text) AS source_id,
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
           FROM (supplier s
             JOIN bill_line b ON ((((b.xero_invoice_id || ':'::text) || b.n) = s.source_id)))
          WHERE ((b.credit_share > (0)::numeric) AND (s.amount_ex <> (0)::numeric))
        ), fact_credit AS (
         SELECT f.job_id,
            f.event_date,
            f.lane,
            f.lane_detail,
            f.party_kind,
            f.party_id,
            f.party,
            (- round((f.amount_ex * f.credit_share), 2)) AS amount_ex,
                CASE
                    WHEN f.installer_unconfirmed THEN 'installer_bill_unconfirmed'::text
                    ELSE 'supplier_credit'::text
                END AS source,
            (f.source_id || ':credit'::text) AS source_id,
            f.document_id,
            f.document_number,
            f.document_status,
            f.paid,
            f.paid_on,
                CASE
                    WHEN f.installer_unconfirmed THEN 'awaiting_confirmation'::text
                    ELSE f.confidence
                END AS confidence,
            (NOT f.installer_unconfirmed) AS is_actual,
            'Credit applied in Xero'::text AS description,
            NULL::numeric AS hours,
            f.account_code,
            f.business_unit,
            'xero_amount_credited'::text AS match_method,
            false AS incomplete_invoice
           FROM fact_base f
          WHERE (f.bill_live AND (f.credit_share > (0)::numeric) AND (f.amount_ex <> (0)::numeric))
        ), credit_note AS (
         SELECT s.job_id,
            s.event_date,
            s.lane,
            s.lane_detail,
            s.party_kind,
            s.party_id,
            s.party,
            (- job_cost_credit_note_part(s.amount_ex, a.amount, a.bill_total)) AS amount_ex,
                CASE
                    WHEN s.is_actual THEN 'supplier_credit'::text
                    ELSE s.source
                END AS source,
            ((((s.source_id || ':credit_note:'::text) || a.xero_credit_note_id) || ':'::text) || a.allocation_n) AS source_id,
            s.document_id,
            s.document_number,
            s.document_status,
            s.paid,
            s.paid_on,
            s.confidence,
            s.is_actual,
            (('Supplier credit note '::text || COALESCE(a.credit_note_number, '(no number)'::text)) || ' applied in Xero'::text) AS description,
            NULL::numeric AS hours,
            s.account_code,
            s.business_unit,
            'xero_credit_note'::text AS match_method,
            false AS incomplete_invoice
           FROM (( SELECT supplier.job_id,
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
             JOIN v_supplier_credit_allocations a ON (((a.xero_invoice_id = s.document_id) AND a.counts_from_credit_note)))
          WHERE (s.amount_ex <> (0)::numeric)
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
                    WHEN (p.subtotal > (0)::numeric) THEN p.subtotal
                    WHEN (p.total > (0)::numeric) THEN (p.total / 1.1)
                    ELSE NULL::numeric
                END AS po_amount_ex,
            (NOT ((COALESCE(p.subtotal, (0)::numeric) > (0)::numeric) OR (COALESCE(p.total, (0)::numeric) > (0)::numeric))) AS unpriced,
            COALESCE(( SELECT min(oe.sent_at) AS min
                   FROM job_order_emails oe
                  WHERE ((oe.purchase_order_id = p.id) AND (oe.status = 'sent'::text) AND (oe.sent_at IS NOT NULL))), p.last_sent_at, p.created_at) AS ordered_at
           FROM purchase_orders p
          WHERE ((p.job_id IS NOT NULL) AND (p.xero_bill_id IS NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM job_materials_facts f
                  WHERE ((f.matched_po_id = p.id) AND (f.kind = 'actual'::text))))) AND (lower(COALESCE(p.status, ''::text)) <> ALL (ARRAY['draft'::text, 'billed'::text, 'cancelled'::text, 'canceled'::text, 'void'::text, 'voided'::text, 'deleted'::text])))
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
                    WHEN (b.invoice_received_at IS NOT NULL) THEN 'po_invoice_emailed'::text
                    WHEN b.unpriced THEN 'po_ordered'::text
                    ELSE 'po_committed'::text
                END AS state
           FROM po_base b
        ), po AS (
         SELECT s.job_id,
                CASE s.state
                    WHEN 'po_invoice_emailed'::text THEN ((s.invoice_received_at AT TIME ZONE 'Australia/Perth'::text))::date
                    WHEN 'po_ordered'::text THEN ((s.ordered_at AT TIME ZONE 'Australia/Perth'::text))::date
                    ELSE COALESCE(s.delivery_date, (s.created_at)::date)
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
            (s.id)::text AS source_id,
            (s.id)::text AS document_id,
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

DO $cfo$
DECLARE
  d text := pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped'::regproc);
BEGIN
  IF position($x$bool_or(e.match_method IN ('xero_invoices.job_id', 'bookkeeping_evidence')) AS via_lines$x$ in d) > 0 THEN
    EXECUTE replace(d, $x$bool_or(e.match_method IN ('xero_invoices.job_id', 'bookkeeping_evidence')) AS via_lines$x$, $x$bool_or(e.match_method = 'xero_invoices.job_id') AS via_lines$x$);
  END IF;
END $cfo$;

DO $check$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass)) <> '92d9a2923438e6a1da601e2179ae34e3' THEN
    RAISE EXCEPTION 'rollback did not restore v_job_cost_events (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass));
  END IF;
END $check$;
