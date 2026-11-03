-- Rollback of 20261104063000_job_cost_bill_line_job_number.
-- Restores v_job_cost_events to the 20261103224500 definition (md5 7f7837be26bf12f131bd86c84ab6ea55, pg_get_viewdef(..., true)) and
-- cfo_bill_cost_outcomes_scoped to the definition live on 3 Nov 2026 (md5 e60aed71c96970715cc8df4b77925f0a, pg_get_functiondef),
-- both embedded below exactly as production printed them, then drops job_cost_bill_line_job_id(text) and the switch
-- job_cost_installer_line_job_number_v1. Refuses when either object is neither the migration's nor the old definition.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $down$
DECLARE
  v_old text := $vdef$ WITH trade_mirror_bill AS (
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
                            ELSE x.job_id
                        END AS job_id,
                        CASE
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text)))) THEN 'bookkeeping_evidence'::text
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
                  WHERE b.xero_invoice_id = f.xero_invoice_id AND b.job_id = f.job_id)) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND (EXISTS ( SELECT 1
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
   FROM po$vdef$;
BEGIN
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) = '7f7837be26bf12f131bd86c84ab6ea55' THEN
    RAISE NOTICE 'v_job_cost_events is already the 20261103224500 definition';
    RETURN;
  END IF;
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '33d1c54d5a288fe496b5b863a1ec1d4c' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the 20261104063000 definition (md5 %); refusing', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || v_old;
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '7f7837be26bf12f131bd86c84ab6ea55' THEN
    RAISE EXCEPTION 'v_job_cost_events after the rollback is not the 20261103224500 definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$down$;

DO $downfn$
DECLARE
  v_old text := $fdef$CREATE OR REPLACE FUNCTION public.cfo_bill_cost_outcomes_scoped(p_job uuid)
 RETURNS TABLE(contract_version text, subject_kind text, xero_invoice_id text, invoice_number text, contact_name text, bill_status text, job_id uuid, job_number text, holding_job boolean, xero_linked boolean, row_source text, placed_by text, counts text, reason text, bill_state text, held_reason text, overhead_part boolean, not_job_related_mark boolean, mirror_bill boolean, bill_counted_jobs integer, counted_ex numeric, placed_ex numeric, bill_ex numeric, overhead_ex numeric, credit_applied_ex numeric, evidence_hash text)
 LANGUAGE sql
 STABLE
AS $function$
WITH
-- The bills in scope: with a job, those placed on it; with none, every bill
-- (each filter below is then true).
scope AS (
  SELECT x.xero_invoice_id FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY' AND x.job_id = p_job AND x.xero_invoice_id IS NOT NULL
  UNION
  SELECT f.xero_invoice_id FROM public.job_materials_facts f
   WHERE f.kind = 'actual' AND f.job_id = p_job AND f.xero_invoice_id IS NOT NULL
),
bill AS (
  SELECT DISTINCT ON (x.xero_invoice_id)
         x.org_id, x.xero_invoice_id, x.invoice_number, x.contact_name, x.status, x.sub_total, x.total,
         x.line_items, x.raw_json, x.job_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY' AND x.xero_invoice_id IS NOT NULL
    AND (p_job IS NULL OR x.xero_invoice_id IN (SELECT s.xero_invoice_id FROM scope s))
  ORDER BY x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC, x.job_id::text COLLATE "C"
),
-- The same original one-side rule as the cost engine. This is a per-bill
-- known applied-credit figure, not a sum of repeated per-job outcome fields.
-- No note-side source leaves the original amount and hash unchanged. Payments
-- and copy clocks are omitted from the witness under the existing D22 rule.
note_credit AS (
  SELECT b.xero_invoice_id,
    sum(public.job_cost_credit_note_part(b.sub_total, a.amount, b.total)) AS note_credit_ex,
    jsonb_agg(jsonb_build_array(a.org_id, a.xero_credit_note_id,
      a.allocation_n, a.allocation_id, a.credit_note_number,
      to_char(a.credit_note_date, 'YYYY-MM-DD'),
      to_char(a.allocation_date, 'YYYY-MM-DD'), a.amount)
      ORDER BY a.org_id, a.xero_credit_note_id COLLATE "C", a.allocation_n) AS note_credit_witness
  FROM bill b
  JOIN public.v_supplier_credit_allocations a
    ON a.org_id=b.org_id AND a.xero_invoice_id=b.xero_invoice_id
  WHERE a.counts_from_credit_note AND b.sub_total IS NOT NULL
  GROUP BY b.xero_invoice_id
),
-- The engine's own mirror test (v_job_cost_events.trade_mirror_bill).
mirror AS (
  SELECT DISTINCT x.xero_invoice_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY'
    AND (p_job IS NULL OR x.xero_invoice_id IN (SELECT s.xero_invoice_id FROM scope s))
    AND (
      EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = x.xero_invoice_id)
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li
        WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]'
      )
    )
),
-- Allocation rows on a job (one per bill and job: job_materials_facts_invoice_job_uidx).
fact AS (
  SELECT f.xero_invoice_id, f.job_id,
         f.automation_source AS source,
         round(f.amount_ex_gst, 2) AS amount_ex,
         (f.amount_ex_gst IS NULL) AS amount_unreadable,
         CASE
           WHEN f.automation_source IN ('manual_queue', 'manual_split')
             THEN CASE WHEN NULLIF(btrim(f.assigned_by), '') IS NULL OR btrim(f.assigned_by) = 'ops_dashboard'
                       THEN 'unrecorded' ELSE 'person' END
           WHEN f.automation_source = 'agent_ai' THEN 'ai_reader'
           ELSE 'rule'
         END AS placed_by
  FROM public.job_materials_facts f
  WHERE f.kind = 'actual' AND f.job_id IS NOT NULL AND f.xero_invoice_id IS NOT NULL
    AND (p_job IS NULL OR f.xero_invoice_id IN (SELECT s.xero_invoice_id FROM scope s))
),
-- What stops the engine reading the bill through its Xero lines (the two NOT
-- EXISTS of v_job_cost_events.bill_line), per bill.
blocker AS (
  SELECT b.xero_invoice_id,
         EXISTS (SELECT 1 FROM public.job_materials_facts f
                  WHERE f.xero_invoice_id = b.xero_invoice_id
                    AND (f.job_id IS DISTINCT FROM b.job_id OR f.automation_source = 'manual_split')
                    AND f.kind = 'actual' AND f.job_id IS NOT NULL) AS by_rows,
         EXISTS (SELECT 1 FROM public.job_materials_facts f
                  WHERE f.xero_invoice_id = b.xero_invoice_id
                    AND (f.job_id IS DISTINCT FROM b.job_id OR f.automation_source = 'manual_split')) AS by_any_row
  FROM bill b
  WHERE b.job_id IS NOT NULL
),
-- What the engine counts, per bill and job. Supplier sources only; a credit
-- row is a credit, so gross leaves it out.
eng AS (
  SELECT e.document_id AS xero_invoice_id, e.job_id,
         bool_or(e.is_actual) AS any_actual,
         sum(e.amount_ex) FILTER (WHERE e.is_actual) AS counted_ex,
         sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.source <> 'supplier_credit') AS counted_gross_ex,
         bool_or(e.match_method IN ('xero_invoices.job_id', 'bookkeeping_evidence')) AS via_lines,
         bool_or(e.source = 'installer_bill_unconfirmed') AS held_unconfirmed,
         bool_or(e.source = 'installer_bill_not_job_related') AS held_not_job_related
  FROM public.v_job_cost_events e
  WHERE e.party_kind = 'supplier'
    AND e.source IN ('supplier_bill', 'materials_fact', 'supplier_credit',
                     'installer_bill_unconfirmed', 'installer_bill_not_job_related')
    AND e.document_id IS NOT NULL AND e.job_id IS NOT NULL
    AND (p_job IS NULL OR e.document_id IN (SELECT s.xero_invoice_id FROM scope s))
    -- A job with no bill skips the engine read entirely (a one-time
    -- filter); it changes no row, since the IN above would keep none.
    AND (p_job IS NULL OR EXISTS (SELECT 1 FROM scope s))
  GROUP BY e.document_id, e.job_id
),
pair AS (
  SELECT xero_invoice_id, job_id FROM bill WHERE job_id IS NOT NULL
  UNION SELECT xero_invoice_id, job_id FROM fact
  UNION SELECT xero_invoice_id, job_id FROM eng
),
row0 AS (
  SELECT
    p.xero_invoice_id,
    p.job_id,
    j.job_number,
    COALESCE(lower(j.metadata ->> 'do_not_schedule') = 'true', false) AS holding_job,
    -- v_job_profit reads jobs WHERE legacy IS NOT TRUE: a legacy or missing
    -- job has no Job Profit row, so cost the engine puts there counts nowhere.
    (j.id IS NULL OR j.legacy IS TRUE) AS legacy_job,
    b.xero_invoice_id IS NOT NULL AS bill_known,
    b.invoice_number,
    b.contact_name,
    b.status AS bill_status,
    COALESCE(b.job_id = p.job_id, false) AS xero_linked,
    f.source AS row_source,
    f.amount_ex AS row_ex,
    COALESCE(f.amount_unreadable, false) AS amount_unreadable,
    CASE
      WHEN f.placed_by IS NOT NULL THEN f.placed_by
      WHEN b.job_id = p.job_id THEN 'xero_link'
    END AS placed_by,
    COALESCE(public.job_cost_installer_bill(b.line_items), false) AS installer,
    (m.xero_invoice_id IS NOT NULL) AS mirror_bill,
    COALESCE(bl.by_rows, false) AS blocked_by_rows,
    COALESCE(bl.by_any_row, false) AS blocked_by_any_row,
    COALESCE(q.overhead_ex, 0) > 0 AS has_overhead,
    COALESCE(e.any_actual, false) AS engine_counts,
    COALESCE(e.via_lines, false) AS engine_via_lines,
    COALESCE(e.held_unconfirmed, false) AS engine_held_unconfirmed,
    COALESCE(e.held_not_job_related, false) AS engine_held_not_job_related,
    e.counted_ex,
    e.counted_gross_ex
  FROM pair p
  LEFT JOIN public.jobs j ON j.id = p.job_id
  LEFT JOIN bill b ON b.xero_invoice_id = p.xero_invoice_id
  LEFT JOIN fact f ON f.xero_invoice_id = p.xero_invoice_id AND f.job_id = p.job_id
  LEFT JOIN blocker bl ON bl.xero_invoice_id = p.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = p.xero_invoice_id
  LEFT JOIN eng e ON e.xero_invoice_id = p.xero_invoice_id AND e.job_id = p.job_id
  LEFT JOIN mirror m ON m.xero_invoice_id = p.xero_invoice_id
  -- A mirror is listed only where a person placed it (and never counted).
  WHERE m.xero_invoice_id IS NULL OR f.source IN ('manual_queue', 'manual_split')
),
row1 AS (
  SELECT r.*,
    CASE
      WHEN r.engine_counts AND r.legacy_job THEN 'not_counted'
      WHEN r.engine_counts THEN 'counted'
      WHEN r.mirror_bill THEN 'not_counted'
      WHEN r.amount_unreadable OR NOT r.bill_known THEN 'unknown'
      WHEN r.bill_status IN ('VOIDED', 'DELETED') THEN 'not_counted'
      WHEN r.engine_held_unconfirmed OR r.engine_held_not_job_related THEN 'not_counted'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.bill_status IS DISTINCT FROM 'AUTHORISED'
           AND r.bill_status IS DISTINCT FROM 'PAID' THEN 'not_counted'
      WHEN r.row_source IS NULL AND r.xero_linked AND (r.blocked_by_any_row OR r.has_overhead) THEN 'not_counted'
      ELSE 'unknown'
    END AS counts,
    CASE
      WHEN r.engine_counts AND r.legacy_job THEN 'job_outside_job_profit'
      WHEN r.engine_counts AND r.engine_via_lines THEN 'engine_reads_xero_lines'
      WHEN r.engine_counts THEN 'engine_reads_allocation_rows'
      WHEN r.mirror_bill THEN 'mirror_bill_person_placed'
      WHEN r.amount_unreadable THEN 'amount_unreadable'
      WHEN NOT r.bill_known THEN 'bill_copy_missing'
      WHEN r.bill_status IN ('VOIDED', 'DELETED') THEN 'bill_voided'
      WHEN r.engine_held_unconfirmed AND r.installer THEN 'installer_unconfirmed'
      WHEN r.engine_held_unconfirmed THEN 'labour_part_unconfirmed'
      WHEN r.engine_held_not_job_related THEN 'installer_not_job_related'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.bill_status IS DISTINCT FROM 'AUTHORISED'
           AND r.bill_status IS DISTINCT FROM 'PAID' THEN 'bill_not_approved'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.blocked_by_rows THEN 'xero_link_read_through_rows'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.has_overhead THEN 'xero_link_read_through_overhead'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.blocked_by_any_row THEN 'xero_link_hidden_by_other_row'
      ELSE 'engine_reason_unknown'
    END AS reason
  FROM row0 r
),
-- Per bill: credit applied (known only when the stored copy shows it; never 0
-- by assumption), the rows' digest and the bill's state.
bill_sum AS (
  SELECT r.xero_invoice_id,
         count(*) FILTER (WHERE r.counts = 'counted') AS counted_jobs,
         bool_or(r.counts = 'unknown') AS any_unknown,
         sum(COALESCE(r.counted_gross_ex, 0)) FILTER (WHERE r.counts = 'counted') AS counted_gross_ex,
         jsonb_agg(jsonb_build_object(
           'job_id', r.job_id,
           'counts', r.counts,
           'reason', r.reason,
           'xero_linked', r.xero_linked,
           'source', r.row_source,
           'placed_ex', r.row_ex)
           ORDER BY r.job_id::text COLLATE "C") AS rows_digest
  FROM row1 r
  GROUP BY r.xero_invoice_id
),
judged AS (
  SELECT r.*,
    round(b.sub_total, 2) AS bill_ex,
    CASE
      WHEN b.status IN ('AUTHORISED', 'PAID') THEN 'live'
      WHEN b.status IN ('VOIDED', 'DELETED') THEN 'void'
      ELSE COALESCE(b.status, 'missing')
    END AS status_class,
    b.line_items,
    b.raw_json ->> 'LineAmountTypes' AS line_amount_types,
    CASE
      WHEN b.raw_json IS NULL OR COALESCE(b.total, 0) <= 0 OR b.sub_total IS NULL THEN NULL
      WHEN (jsonb_typeof(b.raw_json -> 'CreditNotes') = 'array'
            AND jsonb_array_length(b.raw_json -> 'CreditNotes') > 0
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b.raw_json -> 'CreditNotes') c
                             WHERE public.job_profit_num(c.value -> 'AppliedAmount') IS NULL))
        OR jsonb_typeof(b.raw_json -> 'AmountCredited') = 'number'
        THEN round(public.job_cost_credit_share(b.raw_json, b.total) * b.sub_total, 2)
      ELSE NULL
    END AS bill_credit_applied_ex,
    nc.note_credit_ex,
    nc.note_credit_witness,
    round(COALESCE(q.overhead_ex, 0), 2) AS overhead_ex,
    q.status AS queue_status,
    s.counted_jobs,
    s.rows_digest,
    CASE
      WHEN NOT r.bill_known OR b.sub_total IS NULL OR s.any_unknown THEN 'unknown'
      WHEN b.status IN ('VOIDED', 'DELETED') THEN 'voided'
      WHEN r.mirror_bill THEN 'trade_mirror'
      WHEN q.status = 'not_job_related' AND s.counted_jobs > 0 THEN 'held'
      WHEN q.status = 'not_job_related' THEN 'not_job_related'
      WHEN s.counted_jobs = 0 AND COALESCE(q.overhead_ex, 0) > 0
           AND abs(round(b.sub_total, 2) - round(q.overhead_ex, 2)) <= 0.005 THEN 'overhead'
      WHEN s.counted_jobs = 0 THEN 'not_counted'
      -- v_bill_allocation_balance's comparison (remainder within half a cent), over
      -- the counted parts only, so it can differ from that view (see the header).
      WHEN round(b.sub_total, 2) - s.counted_gross_ex - COALESCE(q.overhead_ex, 0) < -0.005 THEN 'over_counted'
      WHEN abs(round(b.sub_total, 2) - s.counted_gross_ex - COALESCE(q.overhead_ex, 0)) <= 0.005 THEN 'counted_in_full'
      ELSE 'counted_in_part'
    END AS bill_state
  FROM row1 r
  JOIN bill_sum s ON s.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN bill b ON b.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN note_credit nc ON nc.xero_invoice_id = r.xero_invoice_id
),
credit_judged AS (
  SELECT j.*,
    CASE WHEN j.note_credit_ex IS NULL THEN j.bill_credit_applied_ex
         ELSE COALESCE(j.bill_credit_applied_ex, 0) + j.note_credit_ex END AS credit_applied_ex
  FROM judged j
)
SELECT
  'cfo-bill-cost-outcome-v1'::text AS contract_version,
  'xero_accpay'::text AS subject_kind,
  j.xero_invoice_id,
  j.invoice_number,
  j.contact_name,
  j.bill_status,
  j.job_id,
  j.job_number,
  j.holding_job,
  j.xero_linked,
  j.row_source,
  j.placed_by,
  j.counts,
  j.reason,
  j.bill_state,
  CASE WHEN j.bill_state = 'held' THEN 'not_job_related_mark_on_counted_bill' END AS held_reason,
  (j.overhead_ex > 0) AS overhead_part,
  COALESCE(j.queue_status = 'not_job_related', false) AS not_job_related_mark,
  j.mirror_bill,
  j.counted_jobs::integer AS bill_counted_jobs,
  -- CFO's amounts. Never in the Context-facing read.
  CASE WHEN j.counts = 'counted' THEN j.counted_ex END AS counted_ex,
  j.row_ex AS placed_ex,
  j.bill_ex,
  j.overhead_ex,
  j.credit_applied_ex,
  md5((jsonb_build_array(
    'cfo-bill-cost-outcome-v1',
    j.xero_invoice_id,
    j.status_class,
    j.bill_ex,
    j.line_items,
    j.line_amount_types,
    -- Credit the engine applies: none known and none shown are the same
    -- (job_cost_credit_share reads 0 for both), so a prepayment landing in
    -- AmountCredited never moves the hash.
    round(COALESCE(j.credit_applied_ex, 0), 2),
    j.rows_digest,
    j.overhead_ex,
    j.queue_status
  ) || CASE WHEN j.note_credit_witness IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(j.note_credit_witness) END)::text) AS evidence_hash
FROM credit_judged j
$function$
$fdef$;
BEGIN
  IF md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)) = 'e60aed71c96970715cc8df4b77925f0a' THEN
    RAISE NOTICE 'cfo_bill_cost_outcomes_scoped is already the old definition';
    RETURN;
  END IF;
  IF md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)) <> '05654c5a54724306a0fcc611c64cf09b' THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped is not the 20261104063000 definition (md5 %); refusing', md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure));
  END IF;
  EXECUTE v_old;
  IF md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)) <> 'e60aed71c96970715cc8df4b77925f0a' THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped after the rollback is not the old definition (md5 %)', md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure));
  END IF;
END
$downfn$;

DROP FUNCTION IF EXISTS public.job_cost_bill_line_job_id(text);
DELETE FROM public.feature_flags WHERE flag_name = 'job_cost_installer_line_job_number_v1';
