-- Undo 20261104040000_dispatch_order_bill_more_rules: v_dispatch_order_bills goes back to its 20261104010000
-- definition (rules (a) and (b) only; md5 of pg_get_viewdef(..., true) b383b75b2c114c37758060a5e5493f3f), embedded
-- below exactly as pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true) returned it (production
-- PostgreSQL 17.6 and the contract stack's 17.11 give the same text). The view is dropped and made again because
-- the newer one has three more columns (matched_po_number, matched_site_address, matched_in), which CREATE OR
-- REPLACE cannot take away. Nothing depends on the view. Refuses when the view is neither definition.
SET LOCAL lock_timeout = '5s';

DO $down$
DECLARE
  v_old text := $old$ WITH orders AS MATERIALIZED (
         SELECT o.order_kind,
            o.order_id,
            o.org_id,
            o.job_id,
            o.job_number,
            o.supplier_id,
            o.supplier_name,
            o.supplier_record_name,
            o.supplier_xero_contact_id,
            o.order_status,
            o.ordered_at,
            o.order_label,
            dispatch_supplier_name_key(o.supplier_name) AS name_key,
            dispatch_supplier_name_key(o.supplier_record_name) AS record_key,
            dispatch_job_number_pattern(o.job_number) AS job_pattern,
            "substring"(upper(o.job_number), '^SW(?:MS|[A-Z])-([0-9]{4,6})$'::text) AS job_digits
           FROM v_dispatch_orders o
        ), bills AS MATERIALIZED (
         SELECT x.xero_invoice_id,
            x.org_id,
            x.invoice_number,
            x.reference,
            x.line_items,
            x.xero_contact_id,
            x.contact_name,
            x.status,
            x.invoice_date,
            x.sub_total,
            dispatch_supplier_name_key(x.contact_name) AS contact_key
           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCPAY'::text AND (upper(COALESCE(x.status, ''::text)) = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
        ), supplier_pairs AS (
         SELECT o.order_kind,
            o.order_id,
            o.org_id,
            o.job_id,
            o.job_number,
            o.supplier_id,
            o.supplier_name,
            o.order_status,
            o.ordered_at,
            o.job_pattern,
            o.job_digits,
            b.xero_invoice_id,
            b.invoice_number,
            b.contact_name AS bill_contact_name,
            b.status AS bill_status,
            b.invoice_date AS bill_date,
            b.sub_total AS bill_sub_total,
                CASE
                    WHEN o.supplier_xero_contact_id IS NOT NULL AND b.xero_contact_id = o.supplier_xero_contact_id THEN 'xero_contact'::text
                    ELSE 'supplier_name'::text
                END AS supplier_match
           FROM orders o
             JOIN bills b ON b.org_id = o.org_id AND (o.supplier_xero_contact_id IS NOT NULL AND b.xero_contact_id = o.supplier_xero_contact_id OR b.contact_key IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM unnest(ARRAY[o.name_key, o.record_key]) k(key)
                  WHERE k.key IS NOT NULL AND (k.key = b.contact_key OR length(k.key) >= 3 AND POSITION(((' '::text || k.key) || ' '::text) IN ((' '::text || b.contact_key) || ' '::text)) > 0 OR length(b.contact_key) >= 3 AND POSITION(((' '::text || b.contact_key) || ' '::text) IN ((' '::text || k.key) || ' '::text)) > 0))))
        ), bill_texts AS MATERIALIZED (
         SELECT b.xero_invoice_id,
            upper(concat_ws('
'::text, b.invoice_number, b.reference, ( SELECT string_agg(l.value ->> 'Description'::text, '
'::text ORDER BY l.n) AS string_agg
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(b.line_items) = 'array'::text THEN b.line_items
                            ELSE '[]'::jsonb
                        END) WITH ORDINALITY l(value, n)))) AS bill_text
           FROM bills b
          WHERE (b.xero_invoice_id IN ( SELECT sp.xero_invoice_id
                   FROM supplier_pairs sp))
        ), pairs AS (
         SELECT sp.order_kind,
            sp.order_id,
            sp.org_id,
            sp.job_id,
            sp.job_number,
            sp.supplier_id,
            sp.supplier_name,
            sp.order_status,
            sp.ordered_at,
            sp.job_pattern,
            sp.job_digits,
            sp.xero_invoice_id,
            sp.invoice_number,
            sp.bill_contact_name,
            sp.bill_status,
            sp.bill_date,
            sp.bill_sub_total,
            sp.supplier_match,
            bt.bill_text
           FROM supplier_pairs sp
             JOIN bill_texts bt ON bt.xero_invoice_id = sp.xero_invoice_id
        ), named AS (
         SELECT p.order_kind,
            p.order_id,
            p.org_id,
            p.job_id,
            p.job_number,
            p.supplier_id,
            p.supplier_name,
            p.order_status,
            p.ordered_at,
            p.job_pattern,
            p.job_digits,
            p.xero_invoice_id,
            p.invoice_number,
            p.bill_contact_name,
            p.bill_status,
            p.bill_date,
            p.bill_sub_total,
            p.supplier_match,
            p.bill_text,
            ref.ref AS matched_ref,
            ref.linked_via AS ref_saved_via,
            p.job_pattern IS NOT NULL AND POSITION((p.job_digits) IN (p.bill_text)) > 0 AND p.bill_text ~ p.job_pattern AS names_job
           FROM pairs p
             LEFT JOIN LATERAL ( SELECT r.ref,
                    r.linked_via
                   FROM dispatch_v2_supplier_order_refs r
                  WHERE p.order_kind = 'dispatch_v2_email'::text AND r.order_id = p.order_id AND r.ref ~ '^[A-Z0-9/-]{3,24}$'::text AND r.ref ~ '[0-9].*[0-9].*[0-9]'::text AND POSITION(("substring"(r.ref, '[0-9]+'::text)) IN (p.bill_text)) > 0 AND p.bill_text ~ (('(?<![A-Z0-9])'::text || regexp_replace(r.ref, '[-/]'::text, '[-/ ]?'::text, 'g'::text)) || '(?![A-Z0-9])'::text)
                  ORDER BY r.created_at, r.ref
                 LIMIT 1) ref ON true
        ), hits AS (
         SELECT n.order_kind,
            n.order_id,
            n.org_id,
            n.job_id,
            n.job_number,
            n.supplier_id,
            n.supplier_name,
            n.order_status,
            n.ordered_at,
            n.job_pattern,
            n.job_digits,
            n.xero_invoice_id,
            n.invoice_number,
            n.bill_contact_name,
            n.bill_status,
            n.bill_date,
            n.bill_sub_total,
            n.supplier_match,
            n.bill_text,
            n.matched_ref,
            n.ref_saved_via,
            n.names_job
           FROM named n
          WHERE n.matched_ref IS NOT NULL OR n.names_job
        ), per_bill AS (
         SELECT h.xero_invoice_id,
            count(*) AS orders_named,
            count(*) FILTER (WHERE h.matched_ref IS NOT NULL) AS ref_orders,
            count(DISTINCT h.job_id) FILTER (WHERE h.names_job) AS jobs_named,
            count(*) FILTER (WHERE h.names_job) AS job_orders
           FROM hits h
          GROUP BY h.xero_invoice_id
        ), judged AS (
         SELECT h.order_kind,
            h.order_id,
            h.org_id,
            h.job_id,
            h.job_number,
            h.supplier_id,
            h.supplier_name,
            h.order_status,
            h.ordered_at,
            h.job_pattern,
            h.job_digits,
            h.xero_invoice_id,
            h.invoice_number,
            h.bill_contact_name,
            h.bill_status,
            h.bill_date,
            h.bill_sub_total,
            h.supplier_match,
            h.bill_text,
            h.matched_ref,
            h.ref_saved_via,
            h.names_job,
            pb.orders_named,
                CASE
                    WHEN pb.ref_orders > 1 THEN 'several_saved_refs'::text
                    WHEN pb.ref_orders = 1 AND h.matched_ref IS NULL THEN 'other_order_ref'::text
                    WHEN pb.ref_orders = 1 AND pb.jobs_named > 0 AND NOT (pb.jobs_named = 1 AND h.names_job) THEN 'job_disagrees'::text
                    WHEN pb.ref_orders = 1 THEN NULL::text
                    WHEN pb.jobs_named > 1 THEN 'several_jobs_named'::text
                    WHEN pb.job_orders > 1 THEN 'several_orders_on_job'::text
                    ELSE NULL::text
                END AS not_linked_reason
           FROM hits h
             JOIN per_bill pb ON pb.xero_invoice_id = h.xero_invoice_id
        )
 SELECT order_kind,
    order_id,
    org_id,
    job_id,
    job_number,
    supplier_id,
    supplier_name,
    order_status,
    ordered_at,
    xero_invoice_id,
    invoice_number,
    bill_contact_name,
    bill_status,
    bill_date,
    bill_sub_total,
    supplier_match,
        CASE
            WHEN matched_ref IS NOT NULL AND names_job THEN 'supplier_ref+job_number'::text
            WHEN matched_ref IS NOT NULL THEN 'supplier_ref'::text
            ELSE 'job_number'::text
        END AS rule,
    matched_ref,
    ref_saved_via,
        CASE
            WHEN names_job THEN job_number
            ELSE NULL::text
        END AS matched_job_number,
    not_linked_reason IS NULL AS linked,
    not_linked_reason,
    orders_named::integer AS orders_named
   FROM judged j;$old$;
  v text := md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
BEGIN
  IF md5(v_old) <> 'b383b75b2c114c37758060a5e5493f3f' THEN
    RAISE EXCEPTION 'the embedded 20261104010000 definition is not the one guarded (md5 %)', md5(v_old);
  END IF;
  IF v = 'b383b75b2c114c37758060a5e5493f3f' THEN
    RAISE NOTICE 'v_dispatch_order_bills is already the 20261104010000 definition';
    RETURN;
  END IF;
  IF v <> 'e55fe723cb6efdfd96c4e06ebb026f2f' THEN
    RAISE EXCEPTION 'v_dispatch_order_bills is not the 20261104040000 definition (md5 %); refusing', v;
  END IF;
  DROP VIEW public.v_dispatch_order_bills;
  EXECUTE 'CREATE VIEW public.v_dispatch_order_bills AS ' || v_old;
  IF md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true)) <> 'b383b75b2c114c37758060a5e5493f3f' THEN
    RAISE EXCEPTION 'v_dispatch_order_bills after the rollback is not the 20261104010000 definition (md5 %)',
      md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
  END IF;
  EXECUTE $c$COMMENT ON VIEW public.v_dispatch_order_bills IS 'B4 20261104010000: each live supplier bill (ACCPAY, AUTHORISED or PAID) of a Dispatch order''s supplier that carries (a) a supplier ref saved for that order or (b) the order''s job number, with the rule (supplier_ref, job_number, supplier_ref+job_number) and whether it links. linked: the bill names this order only (a saved ref picks one order when the job agrees); otherwise not_linked_reason (several_saved_refs, other_order_ref, job_disagrees, several_jobs_named, several_orders_on_job). Linked by rule, never by a person; places no bill and adds no money. Read only; service role only.'$c$;
  REVOKE ALL ON public.v_dispatch_order_bills FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.v_dispatch_order_bills TO service_role;
END $down$;
