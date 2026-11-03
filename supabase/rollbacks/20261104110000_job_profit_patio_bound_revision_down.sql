-- Undo 20261104110000_job_profit_patio_bound_revision: v_job_profit back to its exact earlier definition (md5
-- 87cf36d110e184372e1707a4ff9e942e, as 20261104080000 left it in production, stored verbatim below as production printed
-- it on 3 Nov 2026 with pg_get_viewdef(..., true), TimeZone UTC), job_profit_expected_cost_missing(uuid) back to its
-- exact earlier definition (md5 0c37d911341d324b45d164c9955e64a5, stored verbatim below) and comment, and the two views
-- and two functions this migration added dropped. The view keeps its columns, so it is replaced in place and its grants,
-- comments and job_profit(uuid) are untouched; CREATE OR REPLACE FUNCTION keeps the function's grants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL TimeZone = 'UTC';

DO $down$
DECLARE
  v_md5 text := md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
BEGIN
  IF v_md5 = '87cf36d110e184372e1707a4ff9e942e' THEN
    RAISE NOTICE 'v_job_profit is already the earlier definition';
  ELSIF v_md5 <> 'ac6290aedfe4477b40a6235a7e71d45e' THEN
    RAISE EXCEPTION 'v_job_profit is not the 20261104110000 definition (md5 %)', v_md5;
  ELSE
    EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || $old$ WITH rev AS (
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
            count(*) FILTER (WHERE v.cost_estimate IS NULL) AS variations_not_costed
           FROM v_job_revenue_events e
             JOIN job_variations v ON v.id::text = e.source_id
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
           FROM ( SELECT DISTINCT ON (s.job_id) s.job_id,
                    COALESCE(job_profit_safe_jsonb(s.scope_canonical_text) -> '_pricing_json'::text,
                        CASE
                            WHEN job_profit_safe_jsonb(s.scope_canonical_text) @> '{"tool": "patio-scoper", "revision": {"outputsAgree": true}}'::jsonb AND job_profit_safe_jsonb(s.pricing_canonical_text) @> '{"tool": "patio-scoper", "revision": {"sealed": true}, "pricing_complete": true}'::jsonb AND NOT job_profit_safe_jsonb(s.pricing_canonical_text) @> '{"internal": {"costs_complete": false}}'::jsonb AND (job_profit_safe_jsonb(s.pricing_canonical_text) -> 'sell_to_confirm'::text) = '[]'::jsonb AND jsonb_typeof(job_profit_safe_jsonb(s.scope_canonical_text) #> '{revision,n}'::text[]) = 'number'::text AND COALESCE(job_profit_safe_jsonb(s.scope_canonical_text) #>> '{revision,frozenId}'::text[], ''::text) <> ''::text AND (job_profit_safe_jsonb(s.scope_canonical_text) #>> '{revision,frozenId}'::text[]) = (job_profit_safe_jsonb(s.pricing_canonical_text) #>> '{revision,frozenId}'::text[]) AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text) >= 0::numeric AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'materialCostEstimate'::text) >= 0::numeric AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'totalCostEstimate'::text) >= (job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text) + job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'materialCostEstimate'::text)) THEN jsonb_build_object('labourCostEstimate'::text, job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text), 'materialCostEstimate'::text, job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'totalCostEstimate'::text) - job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text), 'commissionCostEstimate'::text, job_profit_safe_jsonb(s.pricing_canonical_text) -> 'commissionCostEstimate'::text)
                            ELSE NULL::jsonb
                        END) AS pj
                   FROM scope_revisions s
                  WHERE s.status = 'frozen'::text AND s.tool_kind = 'patio'::text AND (EXISTS ( SELECT 1
                           FROM feature_flags ff
                          WHERE ff.flag_name = 'job_profit_patio_expected_from_frozen_scope'::text AND ff.enabled))
                  ORDER BY s.job_id, s.revision_number DESC) n
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
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN 'frozen_at_acceptance'::text
                    WHEN ar.job_id IS NOT NULL THEN 'accepted_quote_revision'::text
                    WHEN sr.job_id IS NOT NULL THEN 'sent_quote_revision'::text
                    WHEN fz.job_id IS NOT NULL THEN 'frozen_scope_revision'::text
                    ELSE NULL::text
                END AS expected_source,
                CASE
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,labour,amount_ex_gst}'::text[])
                    WHEN ar.job_id IS NOT NULL THEN job_profit_num(ar.ce -> 'labour_total'::text)
                    WHEN sr.job_id IS NOT NULL THEN job_profit_num(sr.ce -> 'labour_total'::text)
                    WHEN fz.job_id IS NOT NULL THEN job_profit_num(fz.pj -> 'labourCostEstimate'::text)
                    ELSE NULL::numeric
                END AS expected_labour_ex,
                CASE
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,materials,amount_ex_gst}'::text[])
                    WHEN ar.job_id IS NOT NULL THEN job_profit_num(ar.ce -> 'material_total'::text)
                    WHEN sr.job_id IS NOT NULL THEN job_profit_num(sr.ce -> 'material_total'::text)
                    WHEN fz.job_id IS NOT NULL THEN job_profit_num(fz.pj -> 'materialCostEstimate'::text)
                    ELSE NULL::numeric
                END AS expected_materials_ex,
                CASE
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,commission,amount_ex_gst}'::text[])
                    WHEN ar.job_id IS NOT NULL THEN job_profit_num(ar.ce -> 'subcontract_commission_total'::text)
                    WHEN sr.job_id IS NOT NULL THEN job_profit_num(sr.ce -> 'subcontract_commission_total'::text)
                    WHEN fz.job_id IS NOT NULL THEN job_profit_num(fz.pj -> 'commissionCostEstimate'::text)
                    ELSE NULL::numeric
                END AS expected_commission_ex,
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
            COALESCE(b.xero_project_expenses_ex, 0::numeric) > 0::numeric AND (b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex) < (b.xero_project_expenses_ex - GREATEST(5::numeric, 0.01 * b.xero_project_expenses_ex)) AS project_exceeds_line_costs
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
            WHEN expected_source IS NOT NULL THEN COALESCE(expected_labour_ex, 0::numeric) + COALESCE(expected_materials_ex, 0::numeric) + COALESCE(expected_commission_ex, 0::numeric)
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
            WHEN expected_source IS NOT NULL AND (expected_labour_ex IS NULL OR expected_materials_ex IS NULL OR expected_commission_ex IS NULL) THEN 'expected_cost_lane_missing'::text
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
        END AS expected_cost_missing
   FROM flagged f;$old$;
    IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '87cf36d110e184372e1707a4ff9e942e' THEN
      RAISE EXCEPTION 'v_job_profit after the rollback is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
    END IF;
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)'))) = '0c37d911341d324b45d164c9955e64a5' THEN
    RAISE NOTICE 'job_profit_expected_cost_missing(uuid) is already the earlier definition';
  ELSIF md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)'))) <> '864346d89d03f2ddbcb87124aa618d3d' THEN
    RAISE EXCEPTION 'job_profit_expected_cost_missing(uuid) is not the 20261104110000 definition';
  ELSE
    EXECUTE $oldfn$CREATE OR REPLACE FUNCTION public.job_profit_expected_cost_missing(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  j record;
  v_rev record;
  v_doc record;
  v_pj jsonb;
  v_n text;
  v_list text;
  v_on_job text[] := ARRAY[]::text[];
  v_payer text;
  v_scoper constant text := 'The salesperson who scoped it, in the patio tool (Scope Engine)';
BEGIN
  -- The builder's own name (makesafe_companies), else the name the intake wrote (sometimes only a short code).
  SELECT jb.id, jb.type, jb.job_number, jb.pricing_json,
         COALESCE(NULLIF(btrim(mc.name), ''), NULLIF(btrim(md.requesting_company_name), '')) AS payer
    INTO j
    FROM jobs jb
    LEFT JOIN makesafe_job_details md ON md.job_id = jb.id
    LEFT JOIN makesafe_companies mc ON mc.id = md.requesting_company_id
   WHERE jb.id = p_job_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- 1. A sealed patio scope revision is on the job but v_job_profit cannot read it: say exactly why.
  IF j.type = 'patio' THEN
    SELECT s.revision_number, s.scope_canonical_text, s.pricing_canonical_text
      INTO v_rev
      FROM scope_revisions s
     WHERE s.job_id = p_job_id AND s.status = 'frozen' AND s.tool_kind = 'patio'
     ORDER BY s.revision_number DESC
     LIMIT 1;
    IF FOUND THEN
      v_n := 'Sealed scope revision ' || v_rev.revision_number;
      IF NOT EXISTS (SELECT 1 FROM feature_flags ff
                      WHERE ff.flag_name = 'job_profit_patio_expected_from_frozen_scope' AND ff.enabled) THEN
        RETURN jsonb_build_object('code', 'sealed_scope_switch_off',
          'document', v_n || ' is on the job, but Job Profit reads sealed patio revisions only while its switch is on',
          'holder', 'Marnin (the switch job_profit_patio_expected_from_frozen_scope is his)');
      END IF;
      -- The same cost figures v_job_profit's frozen_scope_rev reads: the old tool's _pricing_json, else a new-tool
      -- revision whose pricing is final.
      v_pj := COALESCE(job_profit_safe_jsonb(v_rev.scope_canonical_text) -> '_pricing_json',
        CASE
          WHEN job_profit_safe_jsonb(v_rev.scope_canonical_text) @> '{"tool": "patio-scoper", "revision": {"outputsAgree": true}}'::jsonb
           AND job_profit_safe_jsonb(v_rev.pricing_canonical_text) @> '{"tool": "patio-scoper", "pricing_complete": true, "revision": {"sealed": true}}'::jsonb
           AND NOT job_profit_safe_jsonb(v_rev.pricing_canonical_text) @> '{"internal": {"costs_complete": false}}'::jsonb
           AND (job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'sell_to_confirm') = '[]'::jsonb
           AND jsonb_typeof(job_profit_safe_jsonb(v_rev.scope_canonical_text) #> '{revision,n}') = 'number'
           AND COALESCE(job_profit_safe_jsonb(v_rev.scope_canonical_text) #>> '{revision,frozenId}', '') <> ''
           AND (job_profit_safe_jsonb(v_rev.scope_canonical_text) #>> '{revision,frozenId}')
               = (job_profit_safe_jsonb(v_rev.pricing_canonical_text) #>> '{revision,frozenId}')
           AND job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate') >= 0
           AND job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'materialCostEstimate') >= 0
           AND job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'totalCostEstimate')
               >= job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate')
                + job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'materialCostEstimate')
          THEN jsonb_build_object(
            'labourCostEstimate', job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate'),
            'materialCostEstimate', job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'totalCostEstimate')
              - job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate'))
        END);
      IF GREATEST(COALESCE(job_profit_num(v_pj -> 'labourCostEstimate'), 0),
                  COALESCE(job_profit_num(v_pj -> 'materialCostEstimate'), 0)) <= 0 THEN
        RETURN jsonb_build_object('code', 'sealed_scope_not_priced',
          'document', v_n || ' with its final cost figures: it carries none (its pricing is not final or states no labour or materials cost)',
          'holder', v_scoper);
      END IF;
      SELECT string_agg(DISTINCT COALESCE(NULLIF(btrim(w.value ->> 'context'), ''), w.value ->> 'code'), '; ')
        INTO v_list
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_pj -> 'pricing_warnings') = 'array'
                                       THEN v_pj -> 'pricing_warnings' ELSE '[]'::jsonb END) w(value)
       WHERE (w.value ->> 'code') ILIKE '%RATE_MISSING%';
      IF v_list IS NOT NULL THEN
        RETURN jsonb_build_object('code', 'sealed_scope_rate_missing',
          'document', v_n || ' sealed again with every rate: a rate is missing for ' || v_list,
          'holder', v_scoper);
      END IF;
      SELECT string_agg(DISTINCT btrim(li.value ->> 'description'), '; ')
        INTO v_list
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_pj -> 'line_items') = 'array'
                                       THEN v_pj -> 'line_items' ELSE '[]'::jsonb END) li(value)
       WHERE COALESCE(job_profit_num(li.value -> 'total_sell'), 0) > 0
         AND COALESCE(job_profit_num(li.value -> 'total_cost'), 0) <= 0;
      IF v_list IS NOT NULL THEN
        RETURN jsonb_build_object('code', 'sealed_scope_line_without_cost',
          'document', v_n || ' sealed again with a cost on every selling line: ' || v_list || ' sells with no cost',
          'holder', v_scoper);
      END IF;
      RETURN jsonb_build_object('code', 'sealed_scope_not_priced',
        'document', v_n || ' with its final cost figures',
        'holder', v_scoper);
    END IF;
    IF EXISTS (SELECT 1 FROM scope_revisions s
                WHERE s.job_id = p_job_id AND s.tool_kind = 'patio' AND s.status = 'superseded') THEN
      RETURN jsonb_build_object('code', 'no_current_sealed_scope',
        'document', 'A current sealed scope revision: every sealed revision on the job is superseded',
        'holder', v_scoper);
    END IF;
  END IF;

  -- 2. A quote went to the customer, but no quote revision with cost figures is stored for it.
  SELECT d.quote_number, d.version, d.sent_at
    INTO v_doc
    FROM job_documents d
   WHERE d.job_id = p_job_id AND d.type = 'quote' AND d.sent_at IS NOT NULL AND d.declined_at IS NULL
   ORDER BY d.sent_at DESC
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('code', 'quote_without_cost_record',
      'document', 'The cost record behind quote ' || COALESCE(NULLIF(btrim(v_doc.quote_number), ''), 'v' || v_doc.version)
        || ' sent ' || to_char(v_doc.sent_at AT TIME ZONE 'Australia/Perth', 'FMDD Mon YYYY')
        || ': the tool that sent it stored no cost figures, and the job''s live pricing is not a fixed document',
      'holder', 'The salesperson who quoted it (seal the quote the customer has in Scope Engine)');
  END IF;

  -- 3. Make-safe, repair and insurance work: the builder's documents set what the builder pays us, not our cost.
  IF EXISTS (SELECT 1 FROM job_documents d WHERE d.job_id = p_job_id AND d.type = 'work_order') THEN
    v_on_job := v_on_job || 'the builder''s works order'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM makesafe_docket_revisions r WHERE r.job_id = p_job_id) THEN
    v_on_job := v_on_job || 'the make-safe invoice basis (the builder''s schedule of rates)'::text;
  END IF;
  IF j.type IN ('makesafe', 'insurance')
     OR (j.type = 'repair' AND (cardinality(v_on_job) > 0 OR j.payer IS NOT NULL)) THEN
    v_payer := COALESCE(j.payer, 'the builder');
    RETURN jsonb_build_object('code', 'builder_job_no_costing',
      'document', 'Our cost estimate for this job (labour, materials and any commission). No costing document exists for builder jobs'
        || CASE WHEN cardinality(v_on_job) > 0
                THEN ': ' || array_to_string(v_on_job, ' and ') || ' on the job '
                     || CASE WHEN cardinality(v_on_job) = 1 THEN 'sets' ELSE 'set' END
                     || ' what ' || v_payer || ' pays us, not our cost'
                ELSE '' END,
      'holder', 'Marnin: no document carries a builder job''s expected cost today. His 21 Oct decision makes the job work order''s labour allowance (Shaun approves it) the expected labour, but no builder job has one yet and Job Profit does not read it yet. Materials have no document');
  END IF;

  -- 4. Nothing priced on the job at all.
  IF j.job_number ILIKE 'SWB-%' THEN
    RETURN jsonb_build_object('code', 'no_contract',
      'document', 'The signed building contract or an accepted quote, with its costing: none is on the job'
        || CASE WHEN j.pricing_json ->> 'source' = 'ghl' THEN ' (the job value came from the CRM, not a quote)' ELSE '' END,
      'holder', 'The builds lead who sold the job');
  END IF;
  IF j.type = 'patio' THEN
    RETURN jsonb_build_object('code', 'no_sealed_scope',
      'document', 'A sealed scope revision from the patio tool, or a sent quote with its cost record: none is on the job',
      'holder', 'The salesperson who priced it (Scope Engine patio tool)');
  END IF;
  IF j.type IN ('fencing', 'decking', 'combo') THEN
    RETURN jsonb_build_object('code', 'no_quote',
      'document', 'A quote sent from the fence tool, which keeps its cost record: none is on the job',
      'holder', 'The salesperson who priced it');
  END IF;
  RETURN jsonb_build_object('code', 'no_costing',
    'document', 'A quote or costed work order stating our expected cost: none is on the job',
    'holder', 'The office');
END
$function$$oldfn$;
    IF md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)'))) <> '0c37d911341d324b45d164c9955e64a5' THEN
      RAISE EXCEPTION 'job_profit_expected_cost_missing(uuid) after the rollback is not the earlier definition';
    END IF;
  END IF;
END
$down$;

COMMENT ON FUNCTION public.job_profit_expected_cost_missing(uuid) IS
  'A6 (3 Nov 2026): for a job with no expected cost in v_job_profit, the document that would fix it and who holds it: {code, document, holder}. Read only. Never a figure.';

DROP VIEW IF EXISTS public.v_job_profit_patio_scope_binding;
DROP VIEW IF EXISTS public.v_job_profit_share_invoices;
DROP FUNCTION IF EXISTS public.job_profit_patio_revision_pricing(text, text);
DROP FUNCTION IF EXISTS public.job_profit_share_on_price(numeric, numeric, numeric);
