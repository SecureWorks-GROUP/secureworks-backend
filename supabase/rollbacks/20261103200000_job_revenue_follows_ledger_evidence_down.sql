-- Undo 20261103200000_job_revenue_follows_ledger_evidence: v_job_revenue_events, v_job_profit, job_profit_line_evidence_many and
-- job_profit_line_evidence_score back to their exact earlier definitions (md5 ac208427bcf489ec12086cc08e3b9289, 4ab42d7dda7e77b8e3dfc984833a5265,
-- e7b5a2cdfd91d2f2fb551c304e264e9e, a41b54e38ca038a8595eb1aac158d1c4): revenue again reads only the invoice's job link.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- v_job_profit's text carries a timestamp, which prints in the session's time zone; the md5 guards are taken in UTC.
SET LOCAL TimeZone = 'UTC';

DO $down$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) = 'ac208427bcf489ec12086cc08e3b9289' AND md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) = '4ab42d7dda7e77b8e3dfc984833a5265'
     AND md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) = 'e7b5a2cdfd91d2f2fb551c304e264e9e' AND md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) = 'a41b54e38ca038a8595eb1aac158d1c4' THEN
    RAISE NOTICE 'already at the earlier definitions';
    RETURN;
  END IF;
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) <> 'aeb851cd8d3d6e807cd7a5d620e020a8' OR md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '986aefcd415e62150ea7376a1c21fc17'
     OR md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'fa520b9d6721716868c5f2048a367ae5' OR md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> '669fe32f975cb22739d8d941e8b61b52' THEN
    RAISE EXCEPTION 'not the 20261103200000_job_revenue_follows_ledger_evidence definitions; refusing to overwrite';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_revenue_events AS ' || $old_rev$ SELECT x.job_id,
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
  WHERE v.job_id IS NOT NULL;$old_rev$;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || $old_vjp$ WITH rev AS (
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
         SELECT x.job_id,
            sum(
                CASE
                    WHEN COALESCE(x.total, 0::numeric) <> 0::numeric THEN x.amount_paid * x.sub_total / x.total
                    ELSE x.amount_paid
                END) AS collected_ex
           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCREC'::text AND x.job_id IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
          GROUP BY x.job_id
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
    invoice_emailed_ex
   FROM flagged f;$old_vjp$;
  EXECUTE $old_many$CREATE OR REPLACE FUNCTION public.job_profit_line_evidence_many(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, result jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH jobs_in AS (
  SELECT DISTINCT u AS job_id FROM unnest(p_job_ids) u WHERE u IS NOT NULL
),
ev AS (
  SELECT * FROM public.v_bookkeeping_line_evidence_current
),
cost AS (
  SELECT c.job_id, c.source, c.source_id, c.document_id, c.document_number, c.description, c.amount_ex, c.event_date, c.lane
  FROM public.v_job_cost_events c
  WHERE c.job_id IN (SELECT j.job_id FROM jobs_in j) AND c.is_actual
),
trade_bill AS (
  SELECT til.id::text AS line_id, ti.xero_bill_id
  FROM public.trade_invoice_lines til
  JOIN public.trade_invoices ti ON ti.id = til.trade_invoice_id
  WHERE til.id::text IN (SELECT split_part(source_id, ':', 1) FROM cost WHERE source IN ('trade_line', 'trade_employer_super'))
),
revenue AS (
  SELECT l.invoice_job_id AS job_id, 'invoice_line'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date, 'revenue'::text AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM public.v_xero_lines l
  LEFT JOIN ev e ON e.xero_invoice_id = l.xero_invoice_id AND e.xero_line_item_id = l.line_item_id
  WHERE l.invoice_type = 'ACCREC' AND l.invoice_job_id IN (SELECT j.job_id FROM jobs_in j)
),
direct AS (
  SELECT c.job_id, c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         xl.division, c.amount_ex, c.event_date AS line_date, c.lane,
         m.allocation, m.job_id AS ev_job_id, m.job_number AS ev_job_number, m.evidenced, m.basis, m.document_ref, m.revision
  FROM cost c
  LEFT JOIN public.v_xero_lines xl ON c.source = 'supplier_bill' AND xl.cost_source_id = c.source_id
  LEFT JOIN trade_bill tb ON c.source = 'trade_line' AND tb.line_id = c.source_id
  LEFT JOIN LATERAL (
    SELECT e.* FROM ev e
    WHERE (c.source = 'supplier_bill' AND e.xero_invoice_id = xl.xero_invoice_id AND e.xero_line_item_id = xl.line_item_id)
       OR (c.source = 'trade_line' AND (e.trade_invoice_line_id::text = c.source_id
           OR (e.xero_invoice_id = tb.xero_bill_id AND e.job_id = c.job_id AND abs(coalesce(e.amount_ex_gst, 0) - c.amount_ex) <= 0.01)))
    ORDER BY (e.job_id = c.job_id) DESC NULLS LAST
    LIMIT 1
  ) m ON true
  WHERE c.source IN ('supplier_bill', 'trade_line')
),
materials AS (
  SELECT c.job_id, c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         NULL::text AS division, c.amount_ex, c.event_date AS line_date, c.lane,
         CASE WHEN s.n > 0 THEN 'job' END AS allocation,
         CASE WHEN s.n > 0 THEN c.job_id END AS ev_job_id, NULL::text AS ev_job_number,
         coalesce(s.n > 0 AND abs(s.ex - c.amount_ex) <= 1.00, false) AS evidenced,
         CASE WHEN s.n > 0 THEN s.n || ' evidenced bill line(s), $' || round(s.ex, 2) END AS basis,
         NULL::text AS document_ref, s.revision
  FROM cost c
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, sum(e.amount_ex_gst) AS ex, max(e.revision) AS revision
    FROM ev e WHERE e.xero_invoice_id = c.document_id AND e.job_id = c.job_id AND e.evidenced AND e.allocation = 'job'
  ) s ON true
  WHERE c.source = 'materials_fact'
),
derived AS (
  SELECT c.job_id, c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         NULL::text AS division, c.amount_ex, c.event_date AS line_date, c.lane,
         CASE WHEN ok.v THEN 'job' END AS allocation, CASE WHEN ok.v THEN c.job_id END AS ev_job_id,
         NULL::text AS ev_job_number, coalesce(ok.v, false) AS evidenced,
         CASE c.source WHEN 'trade_employer_super' THEN 'follows its crew line' ELSE 'follows its bill' END AS basis,
         NULL::text AS document_ref, NULL::text AS revision
  FROM cost c
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN c.source = 'trade_employer_super' THEN
        (SELECT bool_and(d.evidenced AND d.ev_job_id = c.job_id) FROM direct d
          WHERE d.job_id = c.job_id AND d.kind = 'trade_line' AND d.ref = split_part(c.source_id, ':', 1))
      ELSE
        (SELECT bool_and(d.evidenced AND d.ev_job_id = c.job_id) FROM direct d
          WHERE d.job_id = c.job_id AND d.kind = 'supplier_bill' AND split_part(d.ref, ':', 1) = c.document_id)
    END AS v
  ) ok ON true
  WHERE c.source NOT IN ('supplier_bill', 'trade_line', 'materials_fact')
),
not_carried AS (
  SELECT e.job_id, 'not_in_job_profit'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date,
         CASE WHEN l.invoice_type = 'ACCREC' THEN 'revenue' ELSE 'cost' END AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM ev e
  JOIN public.v_xero_lines l ON l.xero_invoice_id = e.xero_invoice_id AND l.line_item_id = e.xero_line_item_id
  WHERE e.job_id IN (SELECT j.job_id FROM jobs_in j) AND e.allocation = 'job' AND e.evidenced
    AND NOT (l.invoice_type = 'ACCREC' AND l.invoice_job_id IS NOT DISTINCT FROM e.job_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = e.job_id AND c.source = 'supplier_bill' AND c.source_id = l.cost_source_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = e.job_id AND c.source = 'materials_fact' AND c.document_id = l.xero_invoice_id)
    AND NOT EXISTS (SELECT 1 FROM cost c JOIN trade_bill tb ON tb.line_id = c.source_id
                     WHERE c.job_id = e.job_id AND c.source = 'trade_line' AND tb.xero_bill_id = l.xero_invoice_id)
),
items AS (
  SELECT i.*,
    CASE
      WHEN i.kind = 'not_in_job_profit' THEN 'not_in_job_profit'
      WHEN i.evidenced AND i.allocation = 'job' AND i.ev_job_id = i.job_id THEN 'evidenced'
      WHEN i.evidenced AND (i.allocation <> 'job' OR i.ev_job_id IS DISTINCT FROM i.job_id) THEN 'evidence_says_elsewhere'
      ELSE 'no_evidence'
    END AS state
  FROM (SELECT * FROM revenue UNION ALL SELECT * FROM direct UNION ALL SELECT * FROM materials
        UNION ALL SELECT * FROM derived UNION ALL SELECT * FROM not_carried) i
),
jp AS (
  -- Job Profit's own check: a profit it withholds cannot be verified
  SELECT p.job_id, p.margin_ok, p.cost_flag, p.invoiced_ex, p.actual_cost_ex
  FROM public.v_job_profit p
  WHERE p.job_id IN (SELECT j.job_id FROM jobs_in j)
),
tally AS (
  SELECT j.job_id,
         count(i.kind) AS n,
         count(*) FILTER (WHERE i.state = 'evidenced') AS ok,
         count(*) FILTER (WHERE i.kind = 'invoice_line') AS rev_n,
         count(*) FILTER (WHERE i.kind = 'invoice_line' AND i.state = 'evidenced') AS rev_ok,
         count(*) FILTER (WHERE i.kind <> 'invoice_line' AND i.kind <> 'not_in_job_profit') AS cost_n,
         count(*) FILTER (WHERE i.kind <> 'invoice_line' AND i.kind <> 'not_in_job_profit' AND i.state = 'evidenced') AS cost_ok,
         count(*) FILTER (WHERE i.state = 'not_in_job_profit') AS not_carried,
         count(*) FILTER (WHERE i.state = 'evidence_says_elsewhere') AS elsewhere,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.state = 'evidenced'), 0) AS ok_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.kind = 'invoice_line'), 0) AS rev_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.kind <> 'invoice_line' AND i.kind <> 'not_in_job_profit'), 0) AS cost_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.state <> 'evidenced'), 0) AS gap_ex
  FROM jobs_in j
  LEFT JOIN items i ON i.job_id = j.job_id
  GROUP BY j.job_id
)
SELECT t.job_id, jsonb_build_object(
  'job_id', t.job_id,
  'rule', 'r57-v2',
  'status', CASE WHEN t.n = 0 THEN 'no_lines'
                 WHEN t.rev_n > 0 AND t.ok = t.n AND coalesce(jp.margin_ok, false)
                      AND abs(coalesce(jp.invoiced_ex, 0) - t.rev_ex) <= 0.01
                      AND abs(coalesce(jp.actual_cost_ex, 0) - t.cost_ex) <= 0.01 THEN 'verified'
                 ELSE 'provisional' END,
  'items', t.n, 'evidenced', t.ok,
  'invoice_lines', t.rev_n, 'invoice_lines_evidenced', t.rev_ok,
  'cost_items', t.cost_n, 'cost_items_evidenced', t.cost_ok,
  'evidence_says_elsewhere', t.elsewhere, 'not_in_job_profit', t.not_carried,
  'evidenced_ex', round(t.ok_ex, 2), 'not_evidenced_ex', round(t.gap_ex, 2),
  'why_not_verified', array_remove(ARRAY[
     CASE WHEN t.n = 0 THEN 'no invoice or cost lines' END,
     CASE WHEN t.rev_n = 0 AND t.n > 0 THEN 'no customer-invoice lines' END,
     CASE WHEN t.rev_n > t.rev_ok THEN (t.rev_n - t.rev_ok) || ' customer-invoice line(s) without evidence' END,
     CASE WHEN t.cost_n > t.cost_ok THEN (t.cost_n - t.cost_ok) || ' cost item(s) without evidence for this job' END,
     CASE WHEN t.not_carried > 0 THEN t.not_carried || ' evidenced line(s) Job Profit does not carry' END,
     CASE WHEN jp.job_id IS NOT NULL AND abs(coalesce(jp.invoiced_ex, 0) - t.rev_ex) > 0.01
          THEN 'Job Profit counts revenue of $' || round(coalesce(jp.invoiced_ex, 0), 2) || ' but the checked invoice lines total $' || round(t.rev_ex, 2) || ' (an invoice without stored lines, or a credit, is not checked)' END,
     CASE WHEN jp.job_id IS NOT NULL AND abs(coalesce(jp.actual_cost_ex, 0) - t.cost_ex) > 0.01
          THEN 'Job Profit counts cost of $' || round(coalesce(jp.actual_cost_ex, 0), 2) || ' but the checked cost items total $' || round(t.cost_ex, 2) END,
     CASE WHEN t.n > 0 AND NOT coalesce(jp.margin_ok, false)
          THEN 'Job Profit withholds this job''s profit (' || coalesce(jp.cost_flag, 'job not in Job Profit') || ')' END], NULL),
  'reconciles', jsonb_build_object(
     'revenue_job_profit', round(coalesce(jp.invoiced_ex, 0), 2), 'revenue_checked', round(t.rev_ex, 2),
     'cost_job_profit', round(coalesce(jp.actual_cost_ex, 0), 2), 'cost_checked', round(t.cost_ex, 2),
     'ok', jp.job_id IS NOT NULL AND abs(coalesce(jp.invoiced_ex, 0) - t.rev_ex) <= 0.01 AND abs(coalesce(jp.actual_cost_ex, 0) - t.cost_ex) <= 0.01),
  'profit_check', CASE WHEN jp.job_id IS NULL THEN 'not_in_job_profit' WHEN jp.margin_ok THEN 'ok' ELSE coalesce(jp.cost_flag, 'withheld') END,
  'lines', coalesce((
     SELECT jsonb_agg(jsonb_build_object(
       'kind', i.kind, 'ref', i.ref, 'document', i.document, 'description', left(i.description, 160),
       'division', i.division, 'lane', i.lane, 'amount_ex', round(i.amount_ex, 2), 'date', i.line_date,
       'state', i.state, 'allocation', i.allocation, 'evidence_job_number', i.ev_job_number,
       'basis', i.basis, 'document_ref', left(i.document_ref, 16), 'revision', i.revision)
       ORDER BY (i.state = 'evidenced'), i.line_date, i.ref)
     FROM items i WHERE i.job_id = t.job_id), '[]'::jsonb),
  'read_at', now())
FROM tally t
LEFT JOIN jp ON jp.job_id = t.job_id;
$function$
$old_many$;
  EXECUTE $old_score$CREATE OR REPLACE FUNCTION public.job_profit_line_evidence_score(p_from date DEFAULT '2026-07-01'::date, p_to date DEFAULT '2026-11-01'::date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH xl AS (
  SELECT l.*, e.allocation, e.evidenced, e.job_id AS ev_job_id
  FROM public.v_xero_lines l
  LEFT JOIN public.v_bookkeeping_line_evidence_current e
    ON e.xero_invoice_id = l.xero_invoice_id AND e.xero_line_item_id = l.line_item_id
  WHERE l.invoice_date >= p_from AND l.invoice_date < p_to
),
candidates AS MATERIALIZED (
  -- only a job whose every customer-invoice line in the window is evidenced can be verified;
  -- MATERIALIZED so the per-job check below is never pushed under the GROUP BY
  SELECT x.invoice_job_id AS job_id
  FROM xl x WHERE x.invoice_type = 'ACCREC' AND x.invoice_job_id IS NOT NULL
  GROUP BY x.invoice_job_id
  HAVING bool_and(coalesce(x.evidenced, false) AND x.allocation = 'job' AND x.ev_job_id = x.invoice_job_id)
)
SELECT jsonb_build_object(
  'rule', 'r57-v2',
  'from', p_from, 'to_before', p_to,
  'invoice_lines', (SELECT jsonb_build_object('lines', count(*), 'ex', round(coalesce(sum(line_ex), 0), 2),
                     'evidenced', count(*) FILTER (WHERE evidenced), 'evidenced_ex', round(coalesce(sum(line_ex) FILTER (WHERE evidenced), 0), 2))
                    FROM xl WHERE invoice_type = 'ACCREC'),
  'cost_lines', (SELECT jsonb_build_object('lines', count(*), 'ex', round(coalesce(sum(line_ex), 0), 2),
                  'evidenced', count(*) FILTER (WHERE evidenced), 'evidenced_ex', round(coalesce(sum(line_ex) FILTER (WHERE evidenced), 0), 2),
                  'to_job', count(*) FILTER (WHERE evidenced AND allocation = 'job'),
                  'to_overhead', count(*) FILTER (WHERE evidenced AND allocation = 'overhead'),
                  'not_job_cost', count(*) FILTER (WHERE evidenced AND allocation = 'not_job_cost'))
                 FROM xl WHERE invoice_type = 'ACCPAY'),
  'invoices_without_stored_lines', (SELECT jsonb_build_object(
      'accrec', count(*) FILTER (WHERE x.invoice_type = 'ACCREC'),
      'accrec_ex', round(coalesce(sum(x.sub_total) FILTER (WHERE x.invoice_type = 'ACCREC'), 0), 2),
      'accpay', count(*) FILTER (WHERE x.invoice_type = 'ACCPAY'),
      'accpay_ex', round(coalesce(sum(x.sub_total) FILTER (WHERE x.invoice_type = 'ACCPAY'), 0), 2))
    FROM public.xero_invoices x
    WHERE x.invoice_type IN ('ACCREC', 'ACCPAY') AND x.status IN ('AUTHORISED', 'SUBMITTED', 'PAID')
      AND x.invoice_date >= p_from AND x.invoice_date < p_to
      AND coalesce(jsonb_typeof(x.line_items), 'null') <> 'array'),
  'jobs_with_invoice_lines', (SELECT count(DISTINCT invoice_job_id) FROM xl WHERE invoice_type = 'ACCREC' AND invoice_job_id IS NOT NULL),
  'jobs_verified', (SELECT count(*) FROM public.job_profit_line_evidence_many(ARRAY(SELECT c.job_id FROM candidates c)) m
                    WHERE m.result ->> 'status' = 'verified'),
  'revisions', coalesce((SELECT jsonb_agg(jsonb_build_object('revision', r.revision, 'sha256', r.sha256, 'facts_in_file', r.facts_in_file,
                          'facts_loaded', r.rows_loaded, 'closed_at', r.closed_at) ORDER BY r.revision)
                         FROM public.bookkeeping_evidence_revisions r WHERE r.status = 'current'), '[]'::jsonb),
  'read_at', now());
$function$
$old_score$;
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) <> 'ac208427bcf489ec12086cc08e3b9289' OR md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '4ab42d7dda7e77b8e3dfc984833a5265'
     OR md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'e7b5a2cdfd91d2f2fb551c304e264e9e' OR md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> 'a41b54e38ca038a8595eb1aac158d1c4' THEN
    RAISE EXCEPTION 'rollback did not restore the exact earlier definitions';
  END IF;
END
$down$;
