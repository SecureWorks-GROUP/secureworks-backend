-- P0-09.1, derived on 17 Nov 2026 from main migrations, NOT A LIVE READ.
-- The director has not supplied live view text. Before ANY switch-on, the director
-- must compare pg_get_viewdef(..., true) and md5 on live against this file, in UTC,
-- and replace this derived reference with the verified live definitions if different.
-- No live read date or live md5 is claimed. Do not apply this reference as a migration.
-- Exported from the disposable registered migration stack, with the budget switch OFF.
-- Newest view writers: cost 20261104123000, revenue 20261111100000,
-- profit 20261114040000. Later migrations through this slice do not replace them.
-- Derived pg_get_viewdef md5 values (UTC), pending director live verification:
-- v_job_cost_events: b48997c55913ce3c90e3a3c947533fd3
-- v_job_revenue_events: b8354d49625e92fdb4a52d81df3a761a
-- v_job_profit: 578270db501761330fad0b46412aac95
-- Base tables and views directly named after FROM or JOIN (CTEs/functions excluded):
-- feature_flags
-- job_budgets
-- job_client_signoffs
-- job_cost_crew_super_rulings
-- job_documents
-- job_materials_facts
-- job_order_emails
-- job_variations
-- jobs
-- makesafe_job_details
-- materials_reconciliation_queue
-- purchase_orders
-- quote_revisions
-- trade_invoice_lines
-- trade_invoices
-- users
-- v_bookkeeping_line_evidence_current
-- v_bookkeeping_line_parts_current
-- v_invoice_line_completeness
-- v_job_cost_events
-- v_job_profit_patio_scope_binding
-- v_job_revenue_events
-- v_supplier_credit_allocations
-- v_trade_charge_resolved
-- work_order_customer_variations
-- xero_invoices
-- xero_projects
-- xero_supplier_credit_notes

CREATE OR REPLACE VIEW public.v_job_cost_events AS
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
        ), trade_bill_xline AS (
         SELECT ti.id AS trade_invoice_id,
            li.n,
            round(
                CASE
                    WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                    ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                END, 2) AS amount_ex,
            job_cost_crew_bill_line_job_number(li.value ->> 'Description'::text) AS job_number,
            job_cost_line_business_unit(li.value) AS business_unit
           FROM trade_invoices ti
             JOIN xero_invoices x ON x.xero_invoice_id = ti.xero_bill_id AND x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
             CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(x.line_items) = 'array'::text THEN x.line_items
                    ELSE '[]'::jsonb
                END) WITH ORDINALITY li(value, n)
          WHERE NOT job_cost_super_withheld_line(li.value)
        ), trade_bill_tline AS (
         SELECT l.id AS line_id,
            l.trade_invoice_id,
            l.created_at,
            round(l.line_total_ex, 2) AS amount_ex,
            upper(NULLIF(btrim(l.job_number), ''::text)) AS job_number
           FROM trade_invoice_lines l
          WHERE (EXISTS ( SELECT 1
                   FROM trade_invoices ti
                  WHERE ti.id = l.trade_invoice_id AND ti.xero_bill_id IS NOT NULL))
        ), trade_bill_p1 AS (
         SELECT t.line_id,
            x.trade_invoice_id,
            x.n,
            x.business_unit
           FROM ( SELECT tl.line_id,
                    tl.trade_invoice_id,
                    tl.amount_ex,
                    tl.job_number,
                    row_number() OVER (PARTITION BY tl.trade_invoice_id, tl.amount_ex, tl.job_number ORDER BY tl.created_at, tl.line_id) AS k
                   FROM trade_bill_tline tl
                  WHERE tl.job_number IS NOT NULL) t
             JOIN ( SELECT xl.trade_invoice_id,
                    xl.n,
                    xl.amount_ex,
                    xl.job_number,
                    xl.business_unit,
                    row_number() OVER (PARTITION BY xl.trade_invoice_id, xl.amount_ex, xl.job_number ORDER BY xl.n) AS k
                   FROM trade_bill_xline xl
                  WHERE xl.job_number IS NOT NULL) x ON x.trade_invoice_id = t.trade_invoice_id AND x.amount_ex = t.amount_ex AND x.job_number = t.job_number AND x.k = t.k
        ), trade_bill_line AS (
         SELECT p1.line_id,
            p1.business_unit
           FROM trade_bill_p1 p1
        UNION ALL
         SELECT t.line_id,
            x.business_unit
           FROM ( SELECT tl.line_id,
                    tl.trade_invoice_id,
                    tl.amount_ex,
                    row_number() OVER (PARTITION BY tl.trade_invoice_id, tl.amount_ex ORDER BY tl.created_at, tl.line_id) AS k
                   FROM trade_bill_tline tl
                  WHERE NOT (EXISTS ( SELECT 1
                           FROM trade_bill_p1 p
                          WHERE p.line_id = tl.line_id))) t
             JOIN ( SELECT xl.trade_invoice_id,
                    xl.n,
                    xl.amount_ex,
                    xl.business_unit,
                    row_number() OVER (PARTITION BY xl.trade_invoice_id, xl.amount_ex ORDER BY xl.n) AS k
                   FROM trade_bill_xline xl
                  WHERE NOT (EXISTS ( SELECT 1
                           FROM trade_bill_p1 p
                          WHERE p.trade_invoice_id = xl.trade_invoice_id AND p.n = xl.n))) x ON x.trade_invoice_id = t.trade_invoice_id AND x.amount_ex = t.amount_ex AND x.k = t.k
        ), trade_bill_bu AS (
         SELECT jsonb_object_agg(trade_bill_line.line_id::text, trade_bill_line.business_unit) AS m
           FROM trade_bill_line
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
            tbu.m ->> r.line_id::text AS business_unit,
            r.match_method,
            COALESCE(c.zero_line OR c.mismatch, false) AS incomplete_invoice
           FROM v_trade_charge_resolved r
             JOIN trade_invoices ti ON ti.id = r.trade_invoice_id
             LEFT JOIN users u ON u.id = r.user_id
             LEFT JOIN v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
             CROSS JOIN trade_bill_bu tbu
          WHERE r.resolved_job_id IS NOT NULL AND NOT r.is_probable_test_line AND ti.status <> 'ops-reject'::text AND (upper(COALESCE(ti.xero_bill_status, ''::text)) <> ALL (ARRAY['DELETED'::text, 'VOIDED'::text]))
        ), trade_party AS (
         SELECT jsonb_object_agg(p.job_id::text, p.parties) AS m
           FROM ( SELECT trade.job_id,
                    jsonb_agg(DISTINCT lower(trade.party)) AS parties
                   FROM trade
                  WHERE trade.is_actual
                  GROUP BY trade.job_id) p
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
        ), bill_part AS (
         SELECT p.xero_invoice_id,
            p.xero_line_item_id,
            p.part,
            p.line_ex,
            p.job_id,
            p.amount_ex_gst
           FROM v_bookkeeping_line_parts_current p
          WHERE p.allocation = 'job'::text AND p.evidenced AND p.job_id IS NOT NULL AND NOT p.super_withheld
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
        ), sca AS MATERIALIZED (
         SELECT v_supplier_credit_allocations.org_id,
            v_supplier_credit_allocations.xero_credit_note_id,
            v_supplier_credit_allocations.credit_note_number,
            v_supplier_credit_allocations.allocation_n,
            v_supplier_credit_allocations.xero_invoice_id,
            v_supplier_credit_allocations.amount,
            v_supplier_credit_allocations.state,
            v_supplier_credit_allocations.bill_side,
            v_supplier_credit_allocations.counts_from_credit_note
           FROM v_supplier_credit_allocations
        ), ledger_cn_bill AS (
         SELECT a.xero_invoice_id,
            sum(a.amount * l.share_placed) AS applied_moved,
            sum(job_cost_credit_ex(a.amount * l.share_placed, a.xero_credit_note_id, a.xero_invoice_id)) AS applied_moved_ex
           FROM sca a
             JOIN ledger_cn_note l ON l.xero_credit_note_id = a.xero_credit_note_id
          WHERE a.state = 'bill_live'::text AND (a.bill_side = ANY (ARRAY['counts_it'::text, 'amount_credited'::text]))
          GROUP BY a.xero_invoice_id
        ), bill_credit AS (
         SELECT x.xero_invoice_id,
                CASE
                    WHEN x.sub_total > 0::numeric AND cn.listed THEN GREATEST(LEAST(GREATEST(cn.applied_ex / x.sub_total, 0::numeric), 1::numeric) - COALESCE(m.applied_moved_ex, 0::numeric) / x.sub_total, 0::numeric)
                    ELSE GREATEST(job_cost_credit_share(x.raw_json, x.total) - COALESCE(m.applied_moved, 0::numeric) / NULLIF(x.total, 0::numeric), 0::numeric)
                END AS credit_share
           FROM xero_invoices x
             LEFT JOIN ledger_cn_bill m ON m.xero_invoice_id = x.xero_invoice_id
             CROSS JOIN LATERAL ( SELECT count(*) > 0 AND bool_and(job_profit_num(c.value -> 'AppliedAmount'::text) IS NOT NULL) AS listed,
                    sum(job_cost_credit_ex(job_profit_num(c.value -> 'AppliedAmount'::text), COALESCE(c.value ->> 'CreditNoteID'::text, c.value ->> 'ID'::text), x.xero_invoice_id)) AS applied_ex
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(x.raw_json -> 'CreditNotes'::text) = 'array'::text THEN x.raw_json -> 'CreditNotes'::text
                            ELSE '[]'::jsonb
                        END) c(value)) cn
          WHERE x.invoice_type = 'ACCPAY'::text AND x.total > 0::numeric AND x.raw_json @? '$?(((@."CreditNotes".size() > 0 || @."AmountCredited" > 0) || @."Prepayments".size() > 0) || @."Overpayments".size() > 0)'::jsonpath AND job_cost_credit_share(x.raw_json, x.total) > 0::numeric
        ), bill_credit_one AS (
         SELECT DISTINCT ON (bill_credit.xero_invoice_id) bill_credit.xero_invoice_id,
            bill_credit.credit_share
           FROM bill_credit
          ORDER BY bill_credit.xero_invoice_id, bill_credit.credit_share DESC
        ), installer_bill AS (
         SELECT x.id
           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND x.line_items @? '$[*]?(((@."AccountCode" == "306" || @."AccountCode" == "301") || @."AccountCode" == 306) || @."AccountCode" == 301)'::jsonpath AND job_cost_installer_bill(x.line_items)
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
            bl.part,
            bl.line,
            bl.amount_ex,
            bl.credit_share,
                CASE
                    WHEN NOT (bl.x_row_id IN ( SELECT installer_bill.id
                       FROM installer_bill)) THEN 'not_installer'::text
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
                            WHEN sp.xero_invoice_id IS NOT NULL THEN
                            CASE
                                WHEN NOT (x.id IN ( SELECT installer_bill.id
                                   FROM installer_bill)) OR NOT (EXISTS ( SELECT 1
                                   FROM jsonb_array_elements_text(tp.m -> sp.job_id::text) tpp(party)
                                  WHERE lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || tpp.party) || '%'::text))) THEN sp.job_id
                                ELSE NULL::uuid
                            END
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT (x.id IN ( SELECT installer_bill.id
                               FROM installer_bill)) OR NOT (EXISTS ( SELECT 1
                               FROM jsonb_array_elements_text(tp.m -> ev.job_id::text) tpp(party)
                              WHERE lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || tpp.party) || '%'::text)))) THEN ev.job_id
                            WHEN tj.job_id IS NOT NULL THEN tj.job_id
                            ELSE x.job_id
                        END AS job_id,
                        CASE
                            WHEN sp.xero_invoice_id IS NOT NULL THEN 'bookkeeping_evidence'::text
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT (x.id IN ( SELECT installer_bill.id
                               FROM installer_bill)) OR NOT (EXISTS ( SELECT 1
                               FROM jsonb_array_elements_text(tp.m -> ev.job_id::text) tpp(party)
                              WHERE lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || tpp.party) || '%'::text)))) THEN 'bookkeeping_evidence'::text
                            WHEN tj.job_id IS NOT NULL THEN 'bill_line_job_number'::text
                            ELSE 'xero_invoices.job_id'::text
                        END AS placed_by,
                    x.invoice_date,
                    x.xero_invoice_id,
                    x.invoice_number,
                    x.contact_name,
                    x.status,
                    x.fully_paid_on,
                    x.id AS x_row_id,
                    li.n,
                    sp.part,
                    li.value AS line,
                        CASE
                            WHEN sp.xero_invoice_id IS NOT NULL THEN sp.amount_ex_gst
                            WHEN li.value ? '_header_ex'::text THEN job_profit_num(li.value -> '_header_ex'::text)
                            WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                            ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                        END AS amount_ex,
                    COALESCE(bc.credit_share, 0::numeric) AS credit_share
                   FROM xero_invoices x
                     LEFT JOIN bill_credit_one bc ON bc.xero_invoice_id = x.xero_invoice_id
                     CROSS JOIN LATERAL jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(x.line_items) = 'array'::text AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
                            ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Bill total (no lines stored)'))
                        END) WITH ORDINALITY li(value, n)
                     LEFT JOIN jobs hj ON hj.id = x.job_id AND lower(COALESCE(hj.metadata ->> 'do_not_schedule'::text, ''::text)) = 'true'::text
                     LEFT JOIN bill_ev ev ON ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text)
                     LEFT JOIN bill_part sp ON sp.xero_invoice_id = x.xero_invoice_id AND sp.xero_line_item_id = (li.value ->> 'LineItemID'::text) AND (x.job_id IS NULL OR hj.id IS NOT NULL) AND abs(sp.line_ex -
                        CASE
                            WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                            ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                        END) <= 0.005
                     CROSS JOIN trade_party tp
                     LEFT JOIN LATERAL ( SELECT
                                CASE
                                    WHEN strpos(upper(COALESCE(li.value ->> 'Description'::text, ''::text)), 'SW'::text) > 0 THEN job_cost_bill_line_job_id(li.value ->> 'Description'::text)
                                    ELSE NULL::uuid
                                END AS job_id
                          WHERE (x.job_id IS NULL OR hj.id IS NOT NULL) AND NOT (EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e
                                  WHERE e.xero_invoice_id = x.xero_invoice_id AND e.xero_line_item_id = (li.value ->> 'LineItemID'::text))) AND NOT (EXISTS ( SELECT 1
                                   FROM materials_reconciliation_queue q
                                  WHERE q.xero_invoice_id = x.xero_invoice_id AND q.status = 'not_job_related'::text))) tn ON true
                     LEFT JOIN LATERAL ( SELECT tn.job_id
                          WHERE tn.job_id IS NOT NULL AND (NOT (x.id IN ( SELECT installer_bill.id
                                   FROM installer_bill)) OR NOT (EXISTS ( SELECT 1
                                   FROM jsonb_array_elements_text(tp.m -> tn.job_id::text) tpp(party)
                                  WHERE lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || tpp.party) || '%'::text))))) tj ON true
                  WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND NOT job_cost_super_withheld_line(li.value) AND NOT (EXISTS ( SELECT 1
                           FROM trade_mirror_bill m
                          WHERE m.xero_invoice_id = x.xero_invoice_id)) AND NOT (EXISTS ( SELECT 1
                           FROM job_materials_facts f
                          WHERE f.xero_invoice_id = x.xero_invoice_id AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = 'manual_split'::text) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND ((EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e
                                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) OR (EXISTS ( SELECT 1
                                   FROM bill_part p2
                                  WHERE p2.xero_invoice_id = f.xero_invoice_id AND p2.job_id <> f.job_id)))))) AND NOT (EXISTS ( SELECT 1
                           FROM materials_reconciliation_queue q
                          WHERE q.xero_invoice_id = x.xero_invoice_id AND COALESCE(q.overhead_ex, 0::numeric) > 0::numeric))) bl
          WHERE bl.job_id IS NOT NULL
        ), bill_super AS (
         SELECT x.xero_invoice_id,
            sum(job_cost_super_company_contribution(li.value)) AS company_super,
            sum(
                CASE
                    WHEN job_cost_super_withheld_line(li.value) THEN 0::numeric
                    WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                    ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                END) AS base_ex
           FROM xero_invoices x
             CROSS JOIN LATERAL jsonb_array_elements(x.line_items) li(value)
          WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND jsonb_typeof(x.line_items) = 'array'::text AND x.line_items::text ~* 'company contribution'::text
          GROUP BY x.xero_invoice_id
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
            ((b.xero_invoice_id || ':'::text) || b.n) || COALESCE(':part'::text || b.part, ''::text) AS source_id,
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
        ), bill_employer_super AS (
         SELECT s.job_id,
            s.event_date,
            s.lane,
            'employer_super'::text AS lane_detail,
            s.party_kind,
            s.party_id,
            s.party,
            round(s.amount_ex * bs.company_super / bs.base_ex, 6) AS amount_ex,
                CASE
                    WHEN s.is_actual THEN 'bill_employer_super'::text
                    ELSE s.source
                END AS source,
            s.source_id || ':employer_super'::text AS source_id,
            s.document_id,
            s.document_number,
            s.document_status,
            false AS paid,
            NULL::date AS paid_on,
            s.confidence,
            s.is_actual,
            'Employer super on: '::text || COALESCE(s.description, ''::text) AS description,
            NULL::numeric AS hours,
            s.account_code,
            s.business_unit,
            s.match_method,
            s.incomplete_invoice
           FROM supplier s
             JOIN bill_super bs ON bs.xero_invoice_id = s.document_id
          WHERE bs.company_super > 0.005 AND bs.base_ex > 0::numeric AND s.amount_ex <> 0::numeric AND (EXISTS ( SELECT 1
                   FROM feature_flags ff
                  WHERE ff.flag_name = 'job_cost_employer_super_v1'::text AND ff.enabled))
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
            job_cost_document_business_unit(x.line_items) AS business_unit,
            COALESCE(f.automation_source, 'materials_fact'::text) AS match_method,
            false AS incomplete_invoice,
            COALESCE(x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]), false) AS bill_live,
            COALESCE(bc.credit_share, 0::numeric) AS credit_share,
            (COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text, 'agent_ai'::text])) AND (f.lane = 'labour'::text OR x.line_items @? '$[*]?(((@."AccountCode" == "306" || @."AccountCode" == "301") || @."AccountCode" == 306) || @."AccountCode" == 301)'::jsonpath AND job_cost_installer_bill(x.line_items)) AS installer_unconfirmed
           FROM job_materials_facts f
             LEFT JOIN xero_invoices x ON x.xero_invoice_id = f.xero_invoice_id AND x.invoice_type = 'ACCPAY'::text
             LEFT JOIN bill_credit_one bc ON bc.xero_invoice_id = x.xero_invoice_id
          WHERE f.kind = 'actual'::text AND f.job_id IS NOT NULL AND f.amount_ex_gst IS NOT NULL AND (COALESCE(x.status, ''::text) <> ALL (ARRAY['VOIDED'::text, 'DELETED'::text])) AND NOT (EXISTS ( SELECT 1
                   FROM trade_mirror_bill m
                  WHERE m.xero_invoice_id = f.xero_invoice_id)) AND NOT (EXISTS ( SELECT 1
                   FROM bill_line b
                  WHERE b.xero_invoice_id = f.xero_invoice_id AND (b.job_id = f.job_id OR b.placed_by <> 'xero_invoices.job_id'::text AND f.job_id = x.job_id))) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND ((EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e
                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) OR (EXISTS ( SELECT 1
                   FROM bill_part p2
                  WHERE p2.xero_invoice_id = f.xero_invoice_id AND p2.job_id <> f.job_id))))
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
            - (round(sum(s.amount_ex * b.credit_share) OVER (PARTITION BY b.xero_invoice_id ORDER BY s.source_id ROWS UNBOUNDED PRECEDING), 2) - COALESCE(round(sum(s.amount_ex * b.credit_share) OVER (PARTITION BY b.xero_invoice_id ORDER BY s.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 2), 0::numeric)) AS amount_ex,
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
             JOIN bill_line b ON (((b.xero_invoice_id || ':'::text) || b.n) || COALESCE(':part'::text || b.part, ''::text)) = s.source_id
          WHERE b.credit_share > 0::numeric AND s.amount_ex <> 0::numeric
        ), fact_credit AS (
         SELECT f.job_id,
            f.event_date,
            f.lane,
            f.lane_detail,
            f.party_kind,
            f.party_id,
            f.party,
            - (round(sum(f.amount_ex * f.credit_share) OVER (PARTITION BY f.document_id ORDER BY f.source_id ROWS UNBOUNDED PRECEDING), 2) - COALESCE(round(sum(f.amount_ex * f.credit_share) OVER (PARTITION BY f.document_id ORDER BY f.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 2), 0::numeric)) AS amount_ex,
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
            - (round(sum(job_cost_credit_note_part_ex(s.amount_ex, a.amount * (1::numeric - COALESCE(( SELECT l.share_placed
                   FROM ledger_cn_note l
                  WHERE l.xero_credit_note_id = a.xero_credit_note_id), 0::numeric)), a.xero_credit_note_id, a.xero_invoice_id)) OVER (PARTITION BY s.document_id, a.xero_credit_note_id, a.allocation_n ORDER BY s.source_id ROWS UNBOUNDED PRECEDING), 2) - COALESCE(round(sum(job_cost_credit_note_part_ex(s.amount_ex, a.amount * (1::numeric - COALESCE(( SELECT l.share_placed
                   FROM ledger_cn_note l
                  WHERE l.xero_credit_note_id = a.xero_credit_note_id), 0::numeric)), a.xero_credit_note_id, a.xero_invoice_id)) OVER (PARTITION BY s.document_id, a.xero_credit_note_id, a.allocation_n ORDER BY s.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 2), 0::numeric)) AS amount_ex,
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
             JOIN sca a ON a.xero_invoice_id = s.document_id AND a.counts_from_credit_note
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
 SELECT bill_employer_super.job_id,
    bill_employer_super.event_date,
    bill_employer_super.lane,
    bill_employer_super.lane_detail,
    bill_employer_super.party_kind,
    bill_employer_super.party_id,
    bill_employer_super.party,
    bill_employer_super.amount_ex,
    bill_employer_super.source,
    bill_employer_super.source_id,
    bill_employer_super.document_id,
    bill_employer_super.document_number,
    bill_employer_super.document_status,
    bill_employer_super.paid,
    bill_employer_super.paid_on,
    bill_employer_super.confidence,
    bill_employer_super.is_actual,
    bill_employer_super.description,
    bill_employer_super.hours,
    bill_employer_super.account_code,
    bill_employer_super.business_unit,
    bill_employer_super.match_method,
    bill_employer_super.incomplete_invoice
   FROM bill_employer_super
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

CREATE OR REPLACE VIEW public.v_job_revenue_events AS
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
    job_cost_document_business_unit(x.line_items) AS business_unit,
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

CREATE OR REPLACE VIEW public.v_job_profit AS
 WITH rev AS (
         SELECT e.job_id,
            sum(e.amount_ex) FILTER (WHERE e.counts_as_invoiced) AS invoiced_ex,
            sum(e.amount_ex) FILTER (WHERE e.kind = 'invoice_line'::text AND e.status = 'DRAFT'::text) AS draft_revenue_ex,
            sum(e.amount_ex) FILTER (WHERE e.kind = 'variation'::text AND e.agreed) AS variations_listed_ex,
            count(DISTINCT e.document_id) FILTER (WHERE e.counts_as_invoiced) AS invoice_count,
            bool_and(e.paid) FILTER (WHERE e.counts_as_invoiced) AS all_paid,
            max(e.paid_on) FILTER (WHERE e.counts_as_invoiced) AS last_paid_on,
            min(e.invoice_date) FILTER (WHERE e.counts_as_invoiced) AS first_invoice_date
           FROM v_job_revenue_events e
          GROUP BY e.job_id
        ), collected AS (
         SELECT COALESCE(x.job_id, inv_ev.job_id) AS job_id,
            sum(
                CASE
                    WHEN COALESCE(x.total, 0::numeric) <> 0::numeric THEN (x.amount_paid + COALESCE(( SELECT sum((a.value ->> 'AppliedAmount'::text)::numeric) AS sum
                       FROM jsonb_array_elements(COALESCE(x.raw_json -> 'Overpayments'::text, '[]'::jsonb) || COALESCE(x.raw_json -> 'Prepayments'::text, '[]'::jsonb)) a(value)
                      WHERE jsonb_typeof(a.value) = 'object'::text), 0::numeric)) * x.sub_total / x.total
                    ELSE x.amount_paid + COALESCE(( SELECT sum((a.value ->> 'AppliedAmount'::text)::numeric) AS sum
                       FROM jsonb_array_elements(COALESCE(x.raw_json -> 'Overpayments'::text, '[]'::jsonb) || COALESCE(x.raw_json -> 'Prepayments'::text, '[]'::jsonb)) a(value)
                      WHERE jsonb_typeof(a.value) = 'object'::text), 0::numeric)
                END) AS collected_ex
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
          WHERE x.invoice_type = 'ACCREC'::text AND COALESCE(x.job_id, inv_ev.job_id) IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
          GROUP BY (COALESCE(x.job_id, inv_ev.job_id))
        ), super_unknown_lines AS (
         SELECT til.id::text AS line_id
           FROM trade_invoice_lines til
             JOIN trade_invoices ti ON ti.id = til.trade_invoice_id
          WHERE (ti.super_amount IS NULL OR ti.net_pay IS NULL) AND NOT (ti.super_amount IS NULL AND (EXISTS ( SELECT 1
                   FROM job_cost_crew_super_rulings r
                  WHERE r.user_id = ti.user_id AND COALESCE(( SELECT x.invoice_date
                           FROM xero_invoices x
                          WHERE x.xero_invoice_id = ti.xero_bill_id
                         LIMIT 1), ti.week_end) < r.none_before))) AND (EXISTS ( SELECT 1
                   FROM feature_flags ff
                  WHERE ff.flag_name = 'job_cost_employer_super_v1'::text AND ff.enabled)) AND NOT ((ti.created_at < '2026-08-26 16:00:00+00'::timestamp with time zone OR ti.week_end < '2026-08-27'::date) AND (EXISTS ( SELECT 1
                   FROM feature_flags ff2
                  WHERE ff2.flag_name = 'job_cost_employer_super_none_before_27aug'::text AND ff2.enabled)))
        ), cost AS (
         SELECT e.job_id,
            sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'labour'::text) AS labour_ex,
            sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'materials'::text) AS materials_ex,
            sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'commission'::text) AS commission_ex,
            sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.lane = 'other'::text) AS other_ex,
            sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.source = 'trade_line'::text) AS trade_lines_ex,
            sum(e.amount_ex) FILTER (WHERE e.source = 'po_committed'::text) AS committed_open_ex,
            count(*) FILTER (WHERE e.source = 'po_ordered'::text) AS ordered_not_billed_count,
            count(*) FILTER (WHERE e.source = 'po_ordered'::text AND e.event_date <= ((now() AT TIME ZONE 'Australia/Perth'::text)::date - ((job_profit_partial_cost_policy() ->> 'po_no_bill_days'::text)::integer))) AS ordered_not_billed_over_30_count,
            count(*) FILTER (WHERE e.source = 'po_invoice_emailed'::text) AS invoice_emailed_count,
            count(*) FILTER (WHERE (e.source = ANY (ARRAY['po_committed'::text, 'po_invoice_emailed'::text])) AND
                CASE
                    WHEN e.source = 'po_committed'::text THEN ( SELECT COALESCE(po.delivery_date, (po.created_at AT TIME ZONE 'Australia/Perth'::text)::date) AS "coalesce"
                       FROM purchase_orders po
                      WHERE po.id = e.source_id::uuid)
                    ELSE e.event_date
                END <= ((now() AT TIME ZONE 'Australia/Perth'::text)::date - ((job_profit_partial_cost_policy() ->> 'po_no_bill_days'::text)::integer))) AS po_no_bill_overdue_count,
            sum(e.amount_ex) FILTER (WHERE e.source = 'po_invoice_emailed'::text) AS invoice_emailed_ex,
            sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.source = 'supplier_credit'::text) AS supplier_credits_ex,
            count(*) FILTER (WHERE e.is_actual) AS actual_events,
            bool_and(e.paid) FILTER (WHERE e.is_actual AND e.amount_ex <> 0::numeric) AS all_paid,
            bool_or(e.lane_detail = 'unclassified'::text) AS has_unclassified,
            bool_or(e.source = 'trade_line'::text AND e.match_method <> 'job_id'::text) AS has_text_matched,
            bool_or(e.incomplete_invoice) AS has_incomplete_invoice,
            bool_or(e.source = 'trade_line'::text AND e.is_actual AND (e.source_id IN ( SELECT l.line_id
                   FROM super_unknown_lines l))) AS has_employer_super_unknown,
            bool_or(e.source = 'installer_bill_unconfirmed'::text) AS has_installer_unconfirmed,
            bool_or(e.source = 'trade_line'::text AND e.amount_ex <> 0::numeric AND (e.document_status <> ALL (ARRAY['approved'::text, 'pushed_to_xero'::text, 'paid'::text]))) AS has_unapproved_trade,
            min(e.event_date) FILTER (WHERE e.is_actual) AS first_cost_date,
            max(e.event_date) FILTER (WHERE e.is_actual) AS last_cost_date
           FROM v_job_cost_events e
          GROUP BY e.job_id
        ), project AS (
         SELECT p.job_id,
            sum(p.total_expenses) FILTER (WHERE named.own) AS project_expenses_ex,
            sum(p.total_invoiced) FILTER (WHERE named.own) AS project_invoiced_ex,
            count(*) FILTER (WHERE named.own) AS project_count,
            bool_or(NOT named.own) AS contact_only
           FROM xero_projects p
             JOIN jobs pj ON pj.id = p.job_id
             CROSS JOIN LATERAL ( SELECT COALESCE(btrim(pj.job_number) <> ''::text AND upper(p.project_name) ~ (regexp_replace(upper(btrim(pj.job_number)), '([^A-Z0-9])'::text, '\\\1'::text, 'g'::text) || '(?![0-9])'::text), false) AS own) named
          GROUP BY p.job_id
        ), var AS (
         SELECT e.job_id,
            count(*) AS variations_agreed,
            count(*) FILTER (WHERE v.id IS NOT NULL AND v.cost_estimate IS NULL) AS variations_not_costed
           FROM v_job_revenue_events e
             LEFT JOIN job_variations v ON v.id::text = e.source_id
          WHERE e.kind = 'variation'::text AND e.agreed AND e.amount_ex > 0::numeric
          GROUP BY e.job_id
        ), accepted_rev AS (
         SELECT n.job_id,
            n.ce
           FROM ( SELECT DISTINCT ON (r.job_id) r.job_id,
                    r.internal_cost_snapshot_json -> 'cost_estimates'::text AS ce
                   FROM quote_revisions r
                     JOIN job_documents d ON d.id = r.job_document_id
                  WHERE d.accepted_at IS NOT NULL
                  ORDER BY r.job_id, d.accepted_at DESC, r.version DESC) n
          WHERE GREATEST(COALESCE(job_profit_num(n.ce -> 'labour_total'::text), 0::numeric), COALESCE(job_profit_num(n.ce -> 'material_total'::text), 0::numeric), COALESCE(job_profit_num(n.ce -> 'subcontract_commission_total'::text), 0::numeric)) > 0::numeric
        ), sent_rev AS (
         SELECT n.job_id,
            n.ce
           FROM ( SELECT DISTINCT ON (r.job_id) r.job_id,
                    r.internal_cost_snapshot_json -> 'cost_estimates'::text AS ce
                   FROM quote_revisions r
                  WHERE r.sent_at IS NOT NULL
                  ORDER BY r.job_id, r.sent_at DESC, r.version DESC) n
          WHERE GREATEST(COALESCE(job_profit_num(n.ce -> 'labour_total'::text), 0::numeric), COALESCE(job_profit_num(n.ce -> 'material_total'::text), 0::numeric), COALESCE(job_profit_num(n.ce -> 'subcontract_commission_total'::text), 0::numeric)) > 0::numeric
        ), frozen_scope_rev AS (
         SELECT n.job_id,
            n.pj
           FROM ( SELECT b.job_id,
                    b.pj
                   FROM v_job_profit_patio_scope_binding b
                  WHERE b.revision_id IS NOT NULL AND (EXISTS ( SELECT 1
                           FROM feature_flags ff
                          WHERE ff.flag_name = 'job_profit_patio_expected_from_frozen_scope'::text AND ff.enabled))) n
          WHERE GREATEST(COALESCE(job_profit_num(n.pj -> 'labourCostEstimate'::text), 0::numeric), COALESCE(job_profit_num(n.pj -> 'materialCostEstimate'::text), 0::numeric)) > 0::numeric AND NOT (EXISTS ( SELECT 1
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(n.pj -> 'pricing_warnings'::text) = 'array'::text THEN n.pj -> 'pricing_warnings'::text
                            ELSE '[]'::jsonb
                        END) w(value)
                  WHERE (w.value ->> 'code'::text) ~~* '%RATE_MISSING%'::text)) AND NOT (EXISTS ( SELECT 1
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(n.pj -> 'line_items'::text) = 'array'::text THEN n.pj -> 'line_items'::text
                            ELSE '[]'::jsonb
                        END) li(value)
                  WHERE COALESCE(job_profit_num(li.value -> 'total_sell'::text), 0::numeric) > 0::numeric AND COALESCE(job_profit_num(li.value -> 'total_cost'::text), 0::numeric) <= 0::numeric))
        ), budget_rev AS (
         SELECT DISTINCT ON (b.job_id) b.job_id,
            b.id AS budget_id,
            b.work_order_ex_gst,
            b.materials_ex_gst,
            b.commission_ex_gst,
            b.cost_before_commission_ex_gst - b.materials_ex_gst - b.work_order_ex_gst AS other_ex,
            b.gross_profit_ex_gst
           FROM job_budgets b
          WHERE (EXISTS ( SELECT 1
                   FROM feature_flags ff
                  WHERE ff.flag_name = 'job_profit_expected_from_job_budget'::text AND ff.enabled))
          ORDER BY b.job_id, b.version DESC
        ), quote_docs AS (
         SELECT DISTINCT d.job_id
           FROM job_documents d
          WHERE d.type = 'quote'::text AND d.sent_at IS NOT NULL
        ), quote_rows AS (
         SELECT q.job_id,
            v.value_inc_gst,
            v.value_source,
            v.whole_quote_total_inc,
            v.whole_quote_source,
            d.accepted_at,
            d.sent_at,
            d.created_at,
            d.superseded_at,
            d.declined_at,
            row_number() OVER (PARTITION BY q.job_id ORDER BY (d.superseded_at IS NULL AND d.declined_at IS NULL AND v.value_inc_gst IS NOT NULL) DESC, (d.accepted_at IS NOT NULL) DESC, d.accepted_at DESC NULLS LAST, d.sent_at DESC, d.created_at DESC) AS pick_rank
           FROM quote_docs q
             CROSS JOIN LATERAL job_quote_values(q.job_id) v(document_id, job_contact_id, party_is_owner, run_label, value_inc_gst, value_source, whole_quote_total_inc, whole_quote_source)
             JOIN job_documents d ON d.id = v.document_id
        ), quoted AS (
         SELECT q.job_id,
            COALESCE(q.whole_quote_total_inc, q.picked_value_inc_gst) AS quoted_inc,
                CASE
                    WHEN q.whole_quote_total_inc IS NOT NULL THEN 'whole_job_total:'::text || q.whole_quote_source
                    WHEN q.picked_value_inc_gst IS NOT NULL THEN (q.picked_basis || ':'::text) || q.picked_value_source
                    ELSE NULL::text
                END AS quoted_source
           FROM ( SELECT r.job_id,
                    max(r.whole_quote_total_inc) AS whole_quote_total_inc,
                    max(r.whole_quote_source) FILTER (WHERE r.whole_quote_total_inc IS NOT NULL) AS whole_quote_source,
                    max(r.value_inc_gst) FILTER (WHERE r.pick_rank = 1 AND r.superseded_at IS NULL AND r.declined_at IS NULL AND r.value_inc_gst IS NOT NULL) AS picked_value_inc_gst,
                    max(r.value_source) FILTER (WHERE r.pick_rank = 1 AND r.superseded_at IS NULL AND r.declined_at IS NULL AND r.value_inc_gst IS NOT NULL) AS picked_value_source,
                        CASE
                            WHEN bool_or(r.accepted_at IS NOT NULL) FILTER (WHERE r.pick_rank = 1 AND r.superseded_at IS NULL AND r.declined_at IS NULL AND r.value_inc_gst IS NOT NULL) THEN 'accepted'::text
                            ELSE 'newest_current'::text
                        END AS picked_basis
                   FROM quote_rows r
                  GROUP BY r.job_id) q
        ), base AS (
         SELECT j.id AS job_id,
            j.org_id,
            j.job_number,
            j.client_name,
                CASE
                    WHEN j.type = 'repair'::text OR fam.family = 'repair'::text THEN 'repair'::text
                    ELSE j.type
                END AS work_type,
            fam.family AS work_subtype,
            j.status,
            j.created_at,
            lower(COALESCE(j.metadata ->> 'do_not_schedule'::text, ''::text)) = 'true'::text AS holding_job,
            round(qd.quoted_inc / 1.1, 2) AS quoted_ex,
            'sent_quote:'::text || qd.quoted_source AS quoted_source,
                CASE
                    WHEN bg.job_id IS NOT NULL THEN 'job_budget'::text
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN 'frozen_at_acceptance'::text
                    WHEN ar.job_id IS NOT NULL THEN 'accepted_quote_revision'::text
                    WHEN sr.job_id IS NOT NULL THEN 'sent_quote_revision'::text
                    WHEN fz.job_id IS NOT NULL AND (COALESCE(job_profit_num(fz.pj -> 'labourCostEstimate'::text), 0::numeric) > 0::numeric OR COALESCE(cost.labour_ex, 0::numeric) <= 0::numeric) THEN 'frozen_scope_revision'::text
                    ELSE NULL::text
                END AS expected_source,
                CASE
                    WHEN bg.job_id IS NOT NULL THEN bg.work_order_ex_gst
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,labour,amount_ex_gst}'::text[])
                    WHEN ar.job_id IS NOT NULL THEN job_profit_num(ar.ce -> 'labour_total'::text)
                    WHEN sr.job_id IS NOT NULL THEN job_profit_num(sr.ce -> 'labour_total'::text)
                    WHEN fz.job_id IS NOT NULL AND (COALESCE(job_profit_num(fz.pj -> 'labourCostEstimate'::text), 0::numeric) > 0::numeric OR COALESCE(cost.labour_ex, 0::numeric) <= 0::numeric) THEN job_profit_num(fz.pj -> 'labourCostEstimate'::text)
                    ELSE NULL::numeric
                END AS expected_labour_ex,
                CASE
                    WHEN bg.job_id IS NOT NULL THEN bg.materials_ex_gst
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,materials,amount_ex_gst}'::text[])
                    WHEN ar.job_id IS NOT NULL THEN job_profit_num(ar.ce -> 'material_total'::text)
                    WHEN sr.job_id IS NOT NULL THEN job_profit_num(sr.ce -> 'material_total'::text)
                    WHEN fz.job_id IS NOT NULL AND (COALESCE(job_profit_num(fz.pj -> 'labourCostEstimate'::text), 0::numeric) > 0::numeric OR COALESCE(cost.labour_ex, 0::numeric) <= 0::numeric) THEN job_profit_num(fz.pj -> 'materialCostEstimate'::text)
                    ELSE NULL::numeric
                END AS expected_materials_ex,
                CASE
                    WHEN bg.job_id IS NOT NULL THEN bg.commission_ex_gst
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,commission,amount_ex_gst}'::text[])
                    WHEN ar.job_id IS NOT NULL THEN job_profit_num(ar.ce -> 'subcontract_commission_total'::text)
                    WHEN sr.job_id IS NOT NULL THEN job_profit_num(sr.ce -> 'subcontract_commission_total'::text)
                    WHEN fz.job_id IS NOT NULL AND (COALESCE(job_profit_num(fz.pj -> 'labourCostEstimate'::text), 0::numeric) > 0::numeric OR COALESCE(cost.labour_ex, 0::numeric) <= 0::numeric) THEN job_profit_num(fz.pj -> 'commissionCostEstimate'::text)
                    ELSE NULL::numeric
                END AS expected_commission_ex,
            bg.other_ex AS expected_other_ex,
            bg.budget_id AS expected_budget_id,
            bg.gross_profit_ex_gst AS budget_gross_profit_ex,
            job_profit_num(j.pricing_json -> 'materialCostEstimate'::text) AS live_materials_estimate_ex,
            COALESCE(rev.invoiced_ex, 0::numeric) AS invoiced_ex,
            COALESCE(rev.draft_revenue_ex, 0::numeric) AS draft_revenue_ex,
            COALESCE(rev.variations_listed_ex, 0::numeric) AS variations_listed_ex,
            COALESCE(col.collected_ex, 0::numeric) AS collected_ex,
            COALESCE(rev.invoice_count, 0::bigint) AS invoice_count,
            rev.all_paid AS revenue_all_paid,
            rev.last_paid_on AS revenue_last_paid_on,
            rev.first_invoice_date,
            COALESCE(cost.labour_ex, 0::numeric) AS line_labour_ex,
            COALESCE(cost.materials_ex, 0::numeric) AS line_materials_ex,
            COALESCE(cost.commission_ex, 0::numeric) AS line_commission_ex,
            COALESCE(cost.other_ex, 0::numeric) AS line_other_ex,
            COALESCE(cost.supplier_credits_ex, 0::numeric) AS line_supplier_credits_ex,
            COALESCE(cost.trade_lines_ex, 0::numeric) AS trade_lines_ex,
            COALESCE(cost.committed_open_ex, 0::numeric) AS committed_open_ex,
            COALESCE(cost.ordered_not_billed_count, 0::bigint) AS ordered_not_billed_count,
            COALESCE(cost.ordered_not_billed_over_30_count, 0::bigint) AS ordered_not_billed_over_30_count,
            COALESCE(cost.invoice_emailed_count, 0::bigint) AS invoice_emailed_count,
            cost.invoice_emailed_ex,
            COALESCE(cost.po_no_bill_overdue_count, 0::bigint) AS po_no_bill_overdue_count,
            COALESCE(var.variations_agreed, 0::bigint) AS variations_agreed,
            COALESCE(var.variations_not_costed, 0::bigint) AS variations_not_costed,
            LEAST((j.completed_at AT TIME ZONE 'Australia/Perth'::text)::date, (so.first_signoff_at AT TIME ZONE 'Australia/Perth'::text)::date) AS work_done_on,
            COALESCE(cost.actual_events, 0::bigint) AS actual_cost_events,
            cost.all_paid AS cost_all_paid,
            COALESCE(cost.has_unclassified, false) AS has_unclassified,
            COALESCE(cost.has_text_matched, false) AS has_text_matched,
            COALESCE(cost.has_incomplete_invoice, false) AS has_incomplete_invoice,
            COALESCE(cost.has_unapproved_trade, false) AS has_unapproved_trade,
            COALESCE(cost.has_installer_unconfirmed, false) AS has_installer_unconfirmed,
            COALESCE(cost.has_employer_super_unknown, false) AS has_employer_super_unknown,
            cost.first_cost_date,
            cost.last_cost_date,
            pr.project_expenses_ex AS xero_project_expenses_ex,
            pr.project_invoiced_ex AS xero_project_invoiced_ex,
            COALESCE(pr.project_count, 0::bigint) AS xero_project_count,
            COALESCE(pr.contact_only, false) AS project_contact_only
           FROM jobs j
             LEFT JOIN makesafe_job_details md ON md.job_id = j.id
             CROSS JOIN LATERAL ( SELECT
                        CASE
                            WHEN lower(COALESCE(j.metadata ->> 'insurance_job_type'::text, ''::text)) = 'restoration'::text THEN 'restoration'::text
                            ELSE lower(COALESCE(NULLIF(btrim(j.metadata ->> 'ses_family'::text), ''::text), NULLIF(btrim(j.metadata ->> 'makesafe_job_family'::text), ''::text), NULLIF(btrim(md.report_type), ''::text)))
                        END AS family) fam
             LEFT JOIN quoted qd ON qd.job_id = j.id
             LEFT JOIN accepted_rev ar ON ar.job_id = j.id
             LEFT JOIN sent_rev sr ON sr.job_id = j.id
             LEFT JOIN frozen_scope_rev fz ON fz.job_id = j.id
             LEFT JOIN budget_rev bg ON bg.job_id = j.id
             LEFT JOIN rev ON rev.job_id = j.id
             LEFT JOIN collected col ON col.job_id = j.id
             LEFT JOIN cost ON cost.job_id = j.id
             LEFT JOIN project pr ON pr.job_id = j.id
             LEFT JOIN var ON var.job_id = j.id
             LEFT JOIN LATERAL ( SELECT min(s.created_at) AS first_signoff_at
                   FROM job_client_signoffs s
                  WHERE s.job_id = j.id) so ON true
          WHERE j.legacy IS NOT TRUE
        ), basis AS (
         SELECT b.job_id,
            b.org_id,
            b.job_number,
            b.client_name,
            b.work_type,
            b.work_subtype,
            b.status,
            b.created_at,
            b.holding_job,
            b.quoted_ex,
            b.quoted_source,
            b.expected_source,
            b.expected_labour_ex,
            b.expected_materials_ex,
            b.expected_commission_ex,
            b.expected_other_ex,
            b.expected_budget_id,
            b.budget_gross_profit_ex,
            b.live_materials_estimate_ex,
            b.invoiced_ex,
            b.draft_revenue_ex,
            b.variations_listed_ex,
            b.collected_ex,
            b.invoice_count,
            b.revenue_all_paid,
            b.revenue_last_paid_on,
            b.first_invoice_date,
            b.line_labour_ex,
            b.line_materials_ex,
            b.line_commission_ex,
            b.line_other_ex,
            b.trade_lines_ex,
            b.committed_open_ex,
            b.ordered_not_billed_count,
            b.ordered_not_billed_over_30_count,
            b.invoice_emailed_count,
            b.invoice_emailed_ex,
            b.po_no_bill_overdue_count,
            b.variations_agreed,
            b.variations_not_costed,
            b.work_done_on,
            b.actual_cost_events,
            b.cost_all_paid,
            b.has_unclassified,
            b.has_text_matched,
            b.has_incomplete_invoice,
            b.has_unapproved_trade,
            b.has_installer_unconfirmed,
            b.has_employer_super_unknown,
            b.first_cost_date,
            b.last_cost_date,
            b.xero_project_expenses_ex,
            b.xero_project_invoiced_ex,
            b.xero_project_count,
            b.project_contact_only,
            b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex AS line_total_ex,
            COALESCE(b.xero_project_expenses_ex, 0::numeric) > 0::numeric AND (b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex - b.line_supplier_credits_ex) < (b.xero_project_expenses_ex - GREATEST(5::numeric, 0.01 * b.xero_project_expenses_ex)) AS project_exceeds_line_costs
           FROM base b
        ), costed AS (
         SELECT s.job_id,
            s.org_id,
            s.job_number,
            s.client_name,
            s.work_type,
            s.work_subtype,
            s.status,
            s.created_at,
            s.holding_job,
            s.quoted_ex,
            s.quoted_source,
            s.expected_source,
            s.expected_labour_ex,
            s.expected_materials_ex,
            s.expected_commission_ex,
            s.expected_other_ex,
            s.expected_budget_id,
            s.budget_gross_profit_ex,
            s.live_materials_estimate_ex,
            s.invoiced_ex,
            s.draft_revenue_ex,
            s.variations_listed_ex,
            s.collected_ex,
            s.invoice_count,
            s.revenue_all_paid,
            s.revenue_last_paid_on,
            s.first_invoice_date,
            s.line_labour_ex,
            s.line_materials_ex,
            s.line_commission_ex,
            s.line_other_ex,
            s.trade_lines_ex,
            s.committed_open_ex,
            s.ordered_not_billed_count,
            s.ordered_not_billed_over_30_count,
            s.invoice_emailed_count,
            s.invoice_emailed_ex,
            s.po_no_bill_overdue_count,
            s.variations_agreed,
            s.variations_not_costed,
            s.work_done_on,
            s.actual_cost_events,
            s.cost_all_paid,
            s.has_unclassified,
            s.has_text_matched,
            s.has_incomplete_invoice,
            s.has_unapproved_trade,
            s.has_installer_unconfirmed,
            s.has_employer_super_unknown,
            s.first_cost_date,
            s.last_cost_date,
            s.xero_project_expenses_ex,
            s.xero_project_invoiced_ex,
            s.xero_project_count,
            s.project_contact_only,
            s.line_total_ex,
            s.project_exceeds_line_costs,
            s.line_materials_ex <= 0::numeric AND ((s.work_type = ANY (ARRAY['fencing'::text, 'patio'::text, 'decking'::text, 'combo'::text])) OR COALESCE(s.expected_materials_ex, 0::numeric) > 0::numeric OR s.expected_source IS NULL AND COALESCE(s.live_materials_estimate_ex, 0::numeric) > 0::numeric) AS materials_missing,
            s.line_labour_ex = 0::numeric AS labour_missing,
            s.line_materials_ex > 0::numeric AND COALESCE(s.expected_materials_ex, 0::numeric) > 0::numeric AND s.line_materials_ex < (s.expected_materials_ex * ((job_profit_partial_cost_policy() ->> 'materials_below_quote_share'::text)::numeric)) AS materials_below_quote,
            s.line_labour_ex = 0::numeric AND s.work_done_on IS NOT NULL AND s.work_done_on <= ((now() AT TIME ZONE 'Australia/Perth'::text)::date - ((job_profit_partial_cost_policy() ->> 'work_done_no_labour_days'::text)::integer)) AS work_done_no_labour_overdue,
            s.variations_agreed > 0 AND s.quoted_ex IS NOT NULL AND s.invoiced_ex < (s.quoted_ex + s.variations_listed_ex - ((job_profit_partial_cost_policy() ->> 'variation_cover_tolerance_ex'::text)::numeric)) AS variation_not_invoiced,
            s.variations_agreed > 0 AND s.quoted_ex IS NULL AS variation_invoice_unchecked,
            s.line_labour_ex AS actual_labour_ex,
            s.line_materials_ex AS actual_materials_ex,
            s.line_commission_ex AS actual_commission_ex,
            s.line_other_ex AS actual_other_ex,
            s.line_total_ex AS actual_cost_ex,
            s.actual_cost_events > 0 AS has_cost
           FROM basis s
        ), held AS (
         SELECT c.job_id,
            c.org_id,
            c.job_number,
            c.client_name,
            c.work_type,
            c.work_subtype,
            c.status,
            c.created_at,
            c.holding_job,
            c.quoted_ex,
            c.quoted_source,
            c.expected_source,
            c.expected_labour_ex,
            c.expected_materials_ex,
            c.expected_commission_ex,
            c.expected_other_ex,
            c.expected_budget_id,
            c.budget_gross_profit_ex,
            c.live_materials_estimate_ex,
            c.invoiced_ex,
            c.draft_revenue_ex,
            c.variations_listed_ex,
            c.collected_ex,
            c.invoice_count,
            c.revenue_all_paid,
            c.revenue_last_paid_on,
            c.first_invoice_date,
            c.line_labour_ex,
            c.line_materials_ex,
            c.line_commission_ex,
            c.line_other_ex,
            c.trade_lines_ex,
            c.committed_open_ex,
            c.ordered_not_billed_count,
            c.ordered_not_billed_over_30_count,
            c.invoice_emailed_count,
            c.invoice_emailed_ex,
            c.po_no_bill_overdue_count,
            c.variations_agreed,
            c.variations_not_costed,
            c.work_done_on,
            c.actual_cost_events,
            c.cost_all_paid,
            c.has_unclassified,
            c.has_text_matched,
            c.has_incomplete_invoice,
            c.has_unapproved_trade,
            c.has_installer_unconfirmed,
            c.has_employer_super_unknown,
            c.first_cost_date,
            c.last_cost_date,
            c.xero_project_expenses_ex,
            c.xero_project_invoiced_ex,
            c.xero_project_count,
            c.project_contact_only,
            c.line_total_ex,
            c.project_exceeds_line_costs,
            c.materials_missing,
            c.labour_missing,
            c.materials_below_quote,
            c.work_done_no_labour_overdue,
            c.variation_not_invoiced,
            c.variation_invoice_unchecked,
            c.actual_labour_ex,
            c.actual_materials_ex,
            c.actual_commission_ex,
            c.actual_other_ex,
            c.actual_cost_ex,
            c.has_cost,
            c.materials_below_quote AND (((job_profit_partial_cost_policy() -> 'holds_margin'::text) ->> 'materials_below_quote'::text)::boolean) AS materials_below_quote_holds,
            c.ordered_not_billed_over_30_count > 0 AND (((job_profit_partial_cost_policy() -> 'holds_margin'::text) ->> 'ordered_not_billed_over_30_days'::text)::boolean) AS ordered_over_limit_holds,
            c.po_no_bill_overdue_count > 0 AND (((job_profit_partial_cost_policy() -> 'holds_margin'::text) ->> 'po_no_bill_overdue'::text)::boolean) AS po_no_bill_overdue_holds,
            c.variations_not_costed > 0 AND (((job_profit_partial_cost_policy() -> 'holds_margin'::text) ->> 'variation_not_costed'::text)::boolean) AS variation_not_costed_holds,
            c.variation_not_invoiced AND (((job_profit_partial_cost_policy() -> 'holds_margin'::text) ->> 'variation_not_invoiced'::text)::boolean) AS variation_not_invoiced_holds
           FROM costed c
        ), flagged AS (
         SELECT c.job_id,
            c.org_id,
            c.job_number,
            c.client_name,
            c.work_type,
            c.work_subtype,
            c.status,
            c.created_at,
            c.holding_job,
            c.quoted_ex,
            c.quoted_source,
            c.expected_source,
            c.expected_labour_ex,
            c.expected_materials_ex,
            c.expected_commission_ex,
            c.expected_other_ex,
            c.expected_budget_id,
            c.budget_gross_profit_ex,
            c.live_materials_estimate_ex,
            c.invoiced_ex,
            c.draft_revenue_ex,
            c.variations_listed_ex,
            c.collected_ex,
            c.invoice_count,
            c.revenue_all_paid,
            c.revenue_last_paid_on,
            c.first_invoice_date,
            c.line_labour_ex,
            c.line_materials_ex,
            c.line_commission_ex,
            c.line_other_ex,
            c.trade_lines_ex,
            c.committed_open_ex,
            c.ordered_not_billed_count,
            c.ordered_not_billed_over_30_count,
            c.invoice_emailed_count,
            c.invoice_emailed_ex,
            c.po_no_bill_overdue_count,
            c.variations_agreed,
            c.variations_not_costed,
            c.work_done_on,
            c.actual_cost_events,
            c.cost_all_paid,
            c.has_unclassified,
            c.has_text_matched,
            c.has_incomplete_invoice,
            c.has_unapproved_trade,
            c.has_installer_unconfirmed,
            c.has_employer_super_unknown,
            c.first_cost_date,
            c.last_cost_date,
            c.xero_project_expenses_ex,
            c.xero_project_invoiced_ex,
            c.xero_project_count,
            c.project_contact_only,
            c.line_total_ex,
            c.project_exceeds_line_costs,
            c.materials_missing,
            c.labour_missing,
            c.materials_below_quote,
            c.work_done_no_labour_overdue,
            c.variation_not_invoiced,
            c.variation_invoice_unchecked,
            c.actual_labour_ex,
            c.actual_materials_ex,
            c.actual_commission_ex,
            c.actual_other_ex,
            c.actual_cost_ex,
            c.has_cost,
            c.materials_below_quote_holds,
            c.ordered_over_limit_holds,
            c.po_no_bill_overdue_holds,
            c.variation_not_costed_holds,
            c.variation_not_invoiced_holds,
                CASE
                    WHEN c.invoiced_ex > 0::numeric THEN 'ok'::text
                    ELSE 'missing_client_invoice'::text
                END AS revenue_flag,
                CASE
                    WHEN c.project_exceeds_line_costs THEN 'xero_project_exceeds_line_costs'::text
                    WHEN c.has_installer_unconfirmed THEN 'installer_bill_unconfirmed'::text
                    WHEN NOT c.has_cost THEN 'no_cost_linked'::text
                    WHEN c.has_incomplete_invoice THEN 'incomplete_invoice_lines'::text
                    WHEN c.has_unclassified THEN 'unclassified_lines'::text
                    WHEN c.materials_missing THEN 'materials_not_linked'::text
                    WHEN c.labour_missing THEN 'no_labour_linked'::text
                    WHEN c.has_employer_super_unknown THEN 'employer_super_unknown'::text
                    WHEN c.materials_below_quote_holds THEN 'materials_below_quote'::text
                    WHEN c.ordered_over_limit_holds THEN 'ordered_not_billed_over_30_days'::text
                    WHEN c.po_no_bill_overdue_holds THEN 'po_no_bill_overdue'::text
                    WHEN c.variation_not_costed_holds THEN 'variation_not_costed'::text
                    WHEN c.has_text_matched THEN 'text_matched_lines'::text
                    ELSE 'ok'::text
                END AS cost_flag,
            c.invoiced_ex > 0::numeric AND c.has_cost AND NOT c.has_incomplete_invoice AND NOT c.has_unclassified AND NOT c.project_exceeds_line_costs AND NOT c.has_installer_unconfirmed AND NOT c.materials_missing AND NOT c.labour_missing AND NOT c.materials_below_quote_holds AND NOT c.ordered_over_limit_holds AND NOT c.po_no_bill_overdue_holds AND NOT c.variation_not_costed_holds AND NOT c.variation_not_invoiced_holds AND NOT c.has_employer_super_unknown AS margin_ok
           FROM held c
        )
 SELECT job_id,
    org_id,
    job_number,
    client_name,
    work_type,
    work_subtype,
    status,
    created_at,
    quoted_ex,
    quoted_source,
    expected_source,
    expected_labour_ex,
    expected_materials_ex,
    expected_commission_ex,
        CASE
            WHEN expected_source IS NOT NULL THEN COALESCE(expected_labour_ex, 0::numeric) + COALESCE(expected_materials_ex, 0::numeric) + COALESCE(expected_commission_ex, 0::numeric) + COALESCE(expected_other_ex, 0::numeric)
            ELSE NULL::numeric
        END AS expected_cost_ex,
    'line_level'::text AS cost_basis,
    actual_labour_ex,
    actual_materials_ex,
    actual_commission_ex,
    actual_other_ex,
    actual_cost_ex,
    line_total_ex AS line_level_cost_ex,
    actual_cost_events,
    trade_lines_ex,
    committed_open_ex,
    xero_project_expenses_ex,
    xero_project_invoiced_ex,
    xero_project_count,
    invoiced_ex,
    draft_revenue_ex,
    variations_listed_ex,
    collected_ex,
    invoice_count,
        CASE
            WHEN margin_ok THEN invoiced_ex - actual_cost_ex
            ELSE NULL::numeric
        END AS profit_ex,
        CASE
            WHEN margin_ok THEN round((invoiced_ex - actual_cost_ex) / invoiced_ex * 100::numeric, 1)
            ELSE NULL::numeric
        END AS margin_pct,
        CASE
            WHEN NOT project_exceeds_line_costs THEN invoiced_ex - actual_cost_ex
            ELSE NULL::numeric
        END AS profit_ex_unsuppressed,
    invoice_count > 0 AND COALESCE(revenue_all_paid, false) AS revenue_verified_paid,
    NOT project_exceeds_line_costs AND actual_cost_events > 0 AND COALESCE(cost_all_paid, false) AS costs_verified_paid,
    revenue_last_paid_on,
    first_invoice_date,
    first_cost_date,
    last_cost_date,
    revenue_flag,
    cost_flag,
    array_remove(ARRAY[
        CASE
            WHEN revenue_flag <> 'ok'::text THEN revenue_flag
            ELSE NULL::text
        END,
        CASE
            WHEN NOT has_cost THEN 'no_cost_linked'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_incomplete_invoice THEN 'incomplete_invoice_lines'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_unclassified THEN 'unclassified_lines'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_text_matched THEN 'text_matched_lines'::text
            ELSE NULL::text
        END,
        CASE
            WHEN project_exceeds_line_costs THEN 'xero_project_exceeds_line_costs'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_installer_unconfirmed THEN 'installer_bill_unconfirmed'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_cost AND actual_labour_ex = 0::numeric THEN 'no_labour_linked'::text
            ELSE NULL::text
        END,
        CASE
            WHEN project_contact_only THEN 'xero_project_linked_by_contact_only'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_cost AND materials_missing THEN 'materials_not_linked'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_unapproved_trade THEN 'unapproved_trade_charges'::text
            ELSE NULL::text
        END,
        CASE
            WHEN committed_open_ex > 0::numeric THEN 'open_purchase_orders'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ordered_not_billed_count > 0 THEN 'ordered_not_billed'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ordered_not_billed_over_30_count > 0 THEN 'ordered_not_billed_over_30_days'::text
            ELSE NULL::text
        END,
        CASE
            WHEN invoice_emailed_count > 0 THEN 'invoice_emailed_bill_not_placed'::text
            ELSE NULL::text
        END,
        CASE
            WHEN draft_revenue_ex > 0::numeric THEN 'draft_revenue'::text
            ELSE NULL::text
        END,
        CASE
            WHEN holding_job THEN 'holding_job'::text
            ELSE NULL::text
        END,
        CASE
            WHEN materials_below_quote THEN 'materials_below_quote'::text
            ELSE NULL::text
        END,
        CASE
            WHEN po_no_bill_overdue_count > 0 THEN 'po_no_bill_overdue'::text
            ELSE NULL::text
        END,
        CASE
            WHEN work_done_no_labour_overdue THEN 'work_done_no_labour_overdue'::text
            ELSE NULL::text
        END,
        CASE
            WHEN variations_not_costed > 0 THEN 'variation_not_costed'::text
            ELSE NULL::text
        END,
        CASE
            WHEN variation_not_invoiced THEN 'variation_not_invoiced'::text
            ELSE NULL::text
        END,
        CASE
            WHEN variation_invoice_unchecked THEN 'variation_invoice_unchecked'::text
            ELSE NULL::text
        END,
        CASE
            WHEN expected_source IS NOT NULL AND (expected_labour_ex IS NULL OR expected_materials_ex IS NULL OR expected_commission_ex IS NULL OR expected_source = 'job_budget'::text AND expected_other_ex IS NULL) THEN 'expected_cost_lane_missing'::text
            ELSE NULL::text
        END,
        CASE
            WHEN has_employer_super_unknown THEN 'employer_super_unknown'::text
            ELSE NULL::text
        END], NULL::text) AS completeness,
    margin_ok,
    holding_job,
    ordered_not_billed_count,
    ordered_not_billed_over_30_count,
    invoice_emailed_count,
    invoice_emailed_ex,
        CASE
            WHEN expected_source IS NULL THEN job_profit_expected_cost_missing(job_id)
            ELSE NULL::jsonb
        END AS expected_cost_missing,
    COALESCE(( SELECT sum(cv.customer_price_ex) AS sum
           FROM work_order_customer_variations cv
          WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric) AS office_variations_ex,
    COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum
           FROM work_order_customer_variations cv
          WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric) AS office_variation_labour_ex,
    expected_labour_ex + COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum
           FROM work_order_customer_variations cv
          WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric) AS expected_labour_with_variations_ex,
        CASE
            WHEN expected_source IS NOT NULL THEN COALESCE(expected_labour_ex, 0::numeric) + COALESCE(expected_materials_ex, 0::numeric) + COALESCE(expected_commission_ex, 0::numeric) + COALESCE(expected_other_ex, 0::numeric) + COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum
               FROM work_order_customer_variations cv
              WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric)
            ELSE NULL::numeric
        END AS expected_cost_with_variations_ex,
    expected_other_ex,
    expected_budget_id,
    budget_gross_profit_ex
   FROM flagged f;
