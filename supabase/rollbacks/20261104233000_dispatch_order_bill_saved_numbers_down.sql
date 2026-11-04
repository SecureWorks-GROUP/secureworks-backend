-- Undo 20261104233000_dispatch_order_bill_saved_numbers: v_dispatch_order_bills goes back to its 20261104040000
-- definition (rules (a) to (d); md5 of pg_get_viewdef(..., true) 4bb5ce8ad2c5a57cf3d34df0e3c8bfd6), embedded below
-- exactly as pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true) returned it on production PostgreSQL
-- 17.6 on 3 Nov 2026 20:28Z (the contract stack's 17.11 gives the same text). Both definitions have the same
-- columns, so CREATE OR REPLACE puts it back. Nothing depends on the view. Refuses when the view is neither
-- definition; on the 20261104040000 definition it does nothing. Running it again is safe.
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
            "substring"(upper(o.job_number), '^SW(?:MS|[A-Z])-([0-9]{4,6})$'::text) AS job_digits,
                CASE
                    WHEN o.order_kind = 'purchase_order'::text AND length(btrim(COALESCE(o.order_label, ''::text))) >= 5 AND o.order_label ~ '[0-9]'::text THEN (' '::text || btrim(regexp_replace(upper(o.order_label), '[^A-Z0-9]+'::text, ' '::text, 'g'::text))) || ' '::text
                    ELSE NULL::text
                END AS po_words,
                CASE
                    WHEN o.order_kind = 'purchase_order'::text AND length(btrim(COALESCE(o.order_label, ''::text))) >= 5 AND pm.m IS NOT NULL THEN ((('(?<![A-Z0-9])'::text || pm.m[1]) || '[ #:.-]{0,3}'::text) || pm.m[2]) || '(?![A-Z0-9])'::text
                    ELSE NULL::text
                END AS po_pattern,
            ( SELECT context_address_key(j_1.site_address) AS context_address_key
                   FROM jobs j_1
                  WHERE j_1.id = o.job_id) AS site_key
           FROM v_dispatch_orders o
             CROSS JOIN LATERAL ( SELECT regexp_match(upper(btrim(COALESCE(o.order_label, ''::text))), '^([A-Z]+)[ #:.-]*([0-9]+)$'::text) AS m) pm
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
            o.order_label,
            o.po_words,
            o.po_pattern,
            o.site_key,
            b.xero_invoice_id,
            b.invoice_number,
            b.contact_name AS bill_contact_name,
            b.status AS bill_status,
            b.invoice_date AS bill_date,
            b.sub_total AS bill_sub_total,
            b.contact_key,
            o.name_key,
            o.record_key,
                CASE
                    WHEN o.supplier_xero_contact_id IS NOT NULL AND b.xero_contact_id = o.supplier_xero_contact_id THEN 'xero_contact'::text
                    ELSE 'supplier_name'::text
                END AS supplier_match
           FROM orders o
             JOIN bills b ON b.org_id = o.org_id AND (o.supplier_xero_contact_id IS NOT NULL AND b.xero_contact_id = o.supplier_xero_contact_id OR b.contact_key IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM unnest(ARRAY[o.name_key, o.record_key]) k(key)
                  WHERE k.key IS NOT NULL AND (k.key = b.contact_key OR length(k.key) >= 3 AND POSITION(((' '::text || k.key) || ' '::text) IN ((' '::text || b.contact_key) || ' '::text)) > 0 OR length(b.contact_key) >= 3 AND POSITION(((' '::text || b.contact_key) || ' '::text) IN ((' '::text || k.key) || ' '::text)) > 0))))
        ), bill_texts AS MATERIALIZED (
         SELECT t.xero_invoice_id,
            t.bill_text,
            (' '::text || btrim(regexp_replace(t.bill_text, '[^A-Z0-9]+'::text, ' '::text, 'g'::text))) || ' '::text AS bill_words,
            t.bill_key
           FROM ( SELECT b.xero_invoice_id,
                    upper(concat_ws('
'::text, b.invoice_number, b.reference, ( SELECT string_agg(l.value ->> 'Description'::text, '
'::text ORDER BY l.n) AS string_agg
                           FROM jsonb_array_elements(
                                CASE
                                    WHEN jsonb_typeof(b.line_items) = 'array'::text THEN b.line_items
                                    ELSE '[]'::jsonb
                                END) WITH ORDINALITY l(value, n)))) AS bill_text,
                    NULLIF(( SELECT ltrim(r.m[1], '0'::text) AS ltrim
                           FROM regexp_matches(COALESCE(b.invoice_number, ''::text), '([0-9]{5,})'::text, 'g'::text) r(m)
                          ORDER BY (length(r.m[1])) DESC, (r.m[1])
                         LIMIT 1), ''::text) AS bill_key
                   FROM bills b
                  WHERE (b.xero_invoice_id IN ( SELECT sp.xero_invoice_id
                           FROM supplier_pairs sp))) t
        ), pdf_docs AS MATERIALIZED (
         SELECT d.event_id,
            ltrim(k.m[1], '0'::text) AS doc_key,
            regexp_replace(lower(COALESCE(m.payload ->> 'from'::text, m.payload ->> 'from_email'::text, ''::text)), '[^a-z0-9]+'::text, ''::text, 'g'::text) AS sender
           FROM ( SELECT t.source_id,
                    t.event_id
                   FROM context_document_texts t
                  WHERE t.source_kind = 'email_attachment'::text AND t.outcome = 'saved'::text AND t.event_id IS NOT NULL
                UNION
                 SELECT v.source_id,
                    v.event_id
                   FROM context_document_vision_reads v
                  WHERE v.source_kind = 'email_attachment'::text AND v.outcome = 'saved'::text AND v.event_id IS NOT NULL) d
             JOIN context_email_attachments c ON c.id = d.source_id
             JOIN business_events m ON m.id = c.business_event_id AND m.direction = 'inbound'::text
             CROSS JOIN LATERAL regexp_matches(COALESCE(c.file_name, ''::text), '([0-9]{5,})'::text, 'g'::text) k(m)
        ), supplier_names AS MATERIALIZED (
         SELECT DISTINCT sp.xero_invoice_id,
            upper(k.key) AS name_words
           FROM supplier_pairs sp
             CROSS JOIN LATERAL unnest(ARRAY[sp.contact_key, sp.name_key, sp.record_key]) k(key)
          WHERE length(k.key) >= 3
        ), supplier_words AS MATERIALIZED (
         SELECT DISTINCT n.xero_invoice_id,
            lower(w.word) AS word
           FROM supplier_names n
             CROSS JOIN LATERAL regexp_split_to_table(n.name_words, ' '::text) w(word)
          WHERE length(w.word) >= 5 AND w.word ~ '^[A-Z]+$'::text
        ), pdf_found AS MATERIALIZED (
         SELECT t.xero_invoice_id,
            t.event_id,
            t.doc_text,
            (' '::text || btrim(regexp_replace(t.doc_text, '[^A-Z0-9]+'::text, ' '::text, 'g'::text))) || ' '::text AS doc_words
           FROM ( SELECT DISTINCT bt.xero_invoice_id,
                    pd.event_id,
                    upper(e.payload ->> 'text'::text) AS doc_text
                   FROM bill_texts bt
                     JOIN pdf_docs pd ON pd.doc_key = bt.bill_key
                     JOIN business_events e ON e.id = pd.event_id
                  WHERE bt.bill_key IS NOT NULL AND (e.payload ->> 'text'::text) ~ (('(?<![0-9])0*'::text || bt.bill_key) || '(?![0-9])'::text) AND (EXISTS ( SELECT 1
                           FROM supplier_words w
                          WHERE w.xero_invoice_id = bt.xero_invoice_id AND POSITION((w.word) IN (pd.sender)) > 0))) t
        ), pdf_texts AS MATERIALIZED (
         SELECT f.xero_invoice_id,
            string_agg(f.doc_text, '
'::text ORDER BY f.event_id) AS pdf_text,
            string_agg(f.doc_words, ''::text ORDER BY f.event_id) AS pdf_words
           FROM pdf_found f
          WHERE (EXISTS ( SELECT 1
                   FROM supplier_names n
                  WHERE n.xero_invoice_id = f.xero_invoice_id AND POSITION(((' '::text || n.name_words) || ' '::text) IN (f.doc_words)) > 0))
          GROUP BY f.xero_invoice_id
        ), bill_sites AS MATERIALIZED (
         SELECT bt.xero_invoice_id,
            array_agg(DISTINCT m.address_key) AS site_keys
           FROM bill_texts bt
             CROSS JOIN LATERAL context_address_mentions(bt.bill_text) m(address_key, loose_keys, typed, slash_form)
          WHERE m.typed AND m.address_key IS NOT NULL
          GROUP BY bt.xero_invoice_id
        ), pdf_sites AS MATERIALIZED (
         SELECT p.xero_invoice_id,
            array_agg(DISTINCT m.address_key) AS site_keys
           FROM pdf_texts p
             CROSS JOIN LATERAL context_address_mentions(p.pdf_text) m(address_key, loose_keys, typed, slash_form)
          WHERE m.typed AND m.address_key IS NOT NULL
          GROUP BY p.xero_invoice_id
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
            sp.order_label,
            sp.po_words,
            sp.po_pattern,
            sp.site_key,
            sp.xero_invoice_id,
            sp.invoice_number,
            sp.bill_contact_name,
            sp.bill_status,
            sp.bill_date,
            sp.bill_sub_total,
            sp.contact_key,
            sp.name_key,
            sp.record_key,
            sp.supplier_match,
            bt.bill_text,
            bt.bill_words,
            bs.site_keys AS bill_site_keys,
            pt.pdf_text,
            pt.pdf_words,
            ps.site_keys
           FROM supplier_pairs sp
             JOIN bill_texts bt ON bt.xero_invoice_id = sp.xero_invoice_id
             LEFT JOIN bill_sites bs ON bs.xero_invoice_id = sp.xero_invoice_id
             LEFT JOIN pdf_texts pt ON pt.xero_invoice_id = sp.xero_invoice_id
             LEFT JOIN pdf_sites ps ON ps.xero_invoice_id = sp.xero_invoice_id
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
            p.order_label,
            p.po_words,
            p.po_pattern,
            p.site_key,
            p.xero_invoice_id,
            p.invoice_number,
            p.bill_contact_name,
            p.bill_status,
            p.bill_date,
            p.bill_sub_total,
            p.contact_key,
            p.name_key,
            p.record_key,
            p.supplier_match,
            p.bill_text,
            p.bill_words,
            p.bill_site_keys,
            p.pdf_text,
            p.pdf_words,
            p.site_keys,
            ref.ref AS matched_ref,
            ref.linked_via AS ref_saved_via,
            COALESCE(p.job_pattern IS NOT NULL AND POSITION((p.job_digits) IN (p.bill_text)) > 0 AND p.bill_text ~ p.job_pattern, false) AS names_job,
            COALESCE(p.po_words IS NOT NULL AND (POSITION((p.po_words) IN (p.bill_words)) > 0 OR p.po_pattern IS NOT NULL AND p.bill_text ~ p.po_pattern), false) AS po_on_bill,
            COALESCE(p.po_words IS NOT NULL AND p.pdf_text IS NOT NULL AND (POSITION((p.po_words) IN (p.pdf_words)) > 0 OR p.po_pattern IS NOT NULL AND p.pdf_text ~ p.po_pattern), false) AS po_on_pdf,
            COALESCE(p.site_key IS NOT NULL AND (p.site_key = ANY (p.bill_site_keys)), false) AS site_on_bill,
            COALESCE(p.site_key IS NOT NULL AND (p.site_key = ANY (p.site_keys)), false) AS site_on_pdf
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
            n.order_label,
            n.po_words,
            n.po_pattern,
            n.site_key,
            n.xero_invoice_id,
            n.invoice_number,
            n.bill_contact_name,
            n.bill_status,
            n.bill_date,
            n.bill_sub_total,
            n.contact_key,
            n.name_key,
            n.record_key,
            n.supplier_match,
            n.bill_text,
            n.bill_words,
            n.bill_site_keys,
            n.pdf_text,
            n.pdf_words,
            n.site_keys,
            n.matched_ref,
            n.ref_saved_via,
            n.names_job,
            n.po_on_bill,
            n.po_on_pdf,
            n.site_on_bill,
            n.site_on_pdf,
            n.matched_ref IS NOT NULL OR n.po_on_bill OR n.po_on_pdf AS picks,
            n.names_job OR n.site_on_bill OR n.site_on_pdf AS places
           FROM named n
          WHERE n.matched_ref IS NOT NULL OR n.names_job OR n.po_on_bill OR n.po_on_pdf OR n.site_on_bill OR n.site_on_pdf
        ), per_bill AS (
         SELECT h.xero_invoice_id,
            count(*) AS orders_named,
            count(*) FILTER (WHERE h.picks) AS pick_orders,
            count(DISTINCT h.job_id) FILTER (WHERE h.places) AS place_jobs,
            count(*) FILTER (WHERE h.places) AS place_orders
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
            h.order_label,
            h.po_words,
            h.po_pattern,
            h.site_key,
            h.xero_invoice_id,
            h.invoice_number,
            h.bill_contact_name,
            h.bill_status,
            h.bill_date,
            h.bill_sub_total,
            h.contact_key,
            h.name_key,
            h.record_key,
            h.supplier_match,
            h.bill_text,
            h.bill_words,
            h.bill_site_keys,
            h.pdf_text,
            h.pdf_words,
            h.site_keys,
            h.matched_ref,
            h.ref_saved_via,
            h.names_job,
            h.po_on_bill,
            h.po_on_pdf,
            h.site_on_bill,
            h.site_on_pdf,
            h.picks,
            h.places,
            pb.orders_named,
                CASE
                    WHEN pb.pick_orders > 1 THEN 'several_order_numbers'::text
                    WHEN pb.pick_orders = 1 AND NOT h.picks THEN 'other_order_ref'::text
                    WHEN pb.pick_orders = 1 AND pb.place_jobs > 0 AND NOT (pb.place_jobs = 1 AND h.places) THEN 'job_disagrees'::text
                    WHEN pb.pick_orders = 1 THEN NULL::text
                    WHEN pb.place_jobs > 1 THEN 'several_jobs_named'::text
                    WHEN pb.place_orders > 1 THEN 'several_orders_on_job'::text
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
    concat_ws('+'::text,
        CASE
            WHEN matched_ref IS NOT NULL THEN 'supplier_ref'::text
            ELSE NULL::text
        END,
        CASE
            WHEN names_job THEN 'job_number'::text
            ELSE NULL::text
        END,
        CASE
            WHEN po_on_bill OR po_on_pdf THEN 'po_number'::text
            ELSE NULL::text
        END,
        CASE
            WHEN site_on_bill OR site_on_pdf THEN 'site_address'::text
            ELSE NULL::text
        END) AS rule,
    matched_ref,
    ref_saved_via,
        CASE
            WHEN names_job THEN job_number
            ELSE NULL::text
        END AS matched_job_number,
    not_linked_reason IS NULL AS linked,
    not_linked_reason,
    orders_named::integer AS orders_named,
        CASE
            WHEN po_on_bill OR po_on_pdf THEN order_label
            ELSE NULL::text
        END AS matched_po_number,
        CASE
            WHEN site_on_bill OR site_on_pdf THEN site_key
            ELSE NULL::text
        END AS matched_site_address,
    concat_ws('+'::text,
        CASE
            WHEN matched_ref IS NOT NULL OR names_job OR po_on_bill OR site_on_bill THEN 'bill'::text
            ELSE NULL::text
        END,
        CASE
            WHEN po_on_pdf OR site_on_pdf THEN 'supplier_pdf'::text
            ELSE NULL::text
        END) AS matched_in
   FROM judged j;$old$;
  v text := md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
BEGIN
  IF md5(v_old) <> '4bb5ce8ad2c5a57cf3d34df0e3c8bfd6' THEN
    RAISE EXCEPTION 'the embedded 20261104040000 definition is not the one guarded (md5 %)', md5(v_old);
  END IF;
  IF v = '4bb5ce8ad2c5a57cf3d34df0e3c8bfd6' THEN
    RAISE NOTICE 'v_dispatch_order_bills is already the 20261104040000 definition';
    RETURN;
  END IF;
  IF v <> '8f4d6f8fd3ad096dd39f4822913bb76a' THEN
    RAISE EXCEPTION 'v_dispatch_order_bills is not the 20261104233000 definition (md5 %); refusing', v;
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_dispatch_order_bills AS ' || v_old;
  IF md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true)) <> '4bb5ce8ad2c5a57cf3d34df0e3c8bfd6' THEN
    RAISE EXCEPTION 'v_dispatch_order_bills after the rollback is not the 20261104040000 definition (md5 %)',
      md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
  END IF;
  EXECUTE $c$COMMENT ON VIEW public.v_dispatch_order_bills IS 'B4 20261104010000, rules (c) and (d) 20261104040000: each live supplier bill (ACCPAY, AUTHORISED or PAID) of a Dispatch order''s supplier that carries, for that order, (a) a supplier ref saved for it, (b) its job number, (c) its PO number (bill or supplier PDF) or (d) its job''s site address on the bill or the supplier PDF (context_address_key). rule lists what matched (supplier_ref, job_number, po_number, site_address, joined by +). linked: the bill names this order only (an order''s own number picks it when the job agrees); otherwise not_linked_reason (several_order_numbers, other_order_ref, job_disagrees, several_jobs_named, several_orders_on_job). Never same supplier and amount alone. Linked by rule, never by a person; places no bill and adds no money. Read only; service role only.'$c$;
  REVOKE ALL ON public.v_dispatch_order_bills FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.v_dispatch_order_bills TO service_role;
END $down$;
