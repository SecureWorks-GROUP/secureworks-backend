-- B4 follow-up (CIO decisions 3 Nov 2026 09:44Z and 10:26Z, under the owner's authority; DSP-05 extended): two
-- more ways a supplier bill links to a Dispatch order, on top of 20261104010000's (a) a supplier ref saved for the
-- order and (b) our job number:
--   (c) po_number: our own PO number on the bill (its number, reference or lines) or on the supplier's PDF of the
--       bill when we hold its text. Purchase orders only: a Dispatch v2 order email has no order number. Read the
--       way bill_prematch.ts reads a PO named on a bill: the PO number as whole words ("PO-298035", "PO 298035"),
--       or its letters and digits with up to three of space, #, :, . or - between ("PO298035", "PO#298035"); never
--       the digits alone; a PO number shorter than 5 characters or without a digit is never read.
--   (d) site_address: the job's site address in the bill's own number, reference or lines, or on the supplier's
--       PDF of the bill, keyed as the context placer keys an address (context_address_key on the job's site
--       address, context_address_mentions on the text, typed street addresses only), when it matches exactly one
--       open order of that supplier (an order in v_dispatch_orders: sent, or a purchase order not draft or
--       cancelled).
-- Not allowed (decided): the same supplier and the same amount alone.
--
-- "The supplier's PDF of the bill": a PDF that came in by email from that supplier (context_email_attachments:
-- its email inbound, never one we sent or sent each other, and its sender's address carrying a word of 5 or more
-- letters of the supplier's name, as perth.metroll.com.au does), whose file name and text both carry the bill's
-- number (its longest run of 5 or more digits, leading zeros dropped), and whose text names the bill's supplier
-- (the supplier name key, whole words). Its text is what our document readers already extracted: the text layer
-- (context_document_texts) or, for a scan, the vision read (context_document_vision_reads), both written as
-- document.text_extracted events. A scan neither reader could read has no text, and its bill waits. On 3 Nov 2026
-- the only such PDF for a bill on a Dispatch order (Metroll 1059031) is a scan neither reader could read; 1496 of
-- the 2315 read PDFs are ones we sent, so those never count. The suppliers table's email is not used: it is not
-- the supplier's address for every supplier.
--
-- Every link still names one order: a bill naming two orders, by any rule, links to neither. An order's own
-- number (a saved ref or a PO number) picks its order when nothing else on the bill points at another job; two
-- such numbers refuse (several_order_numbers, which replaces several_saved_refs). Two orders matched by job
-- number or site address refuse (several_orders_on_job, several_jobs_named). rule lists every rule that matched,
-- joined by +, in the order supplier_ref, job_number, po_number, site_address; earlier values are unchanged.
-- New columns, appended: matched_po_number, matched_site_address (the address key), matched_in (bill,
-- supplier_pdf or bill+supplier_pdf).
--
-- Replaces one view: v_dispatch_order_bills, guarded on its 20261104010000 definition (md5 of
-- pg_get_viewdef(..., true) b383b75b2c114c37758060a5e5493f3f, the same on production PostgreSQL 17.6 and the
-- contract stack's 17.11). Nothing else changes: v_dispatch_orders, the two functions, every bill placement and
-- every money figure stay as they are. Running it again is safe.
--
-- Rollback: supabase/rollbacks/20261104040000_dispatch_order_bill_more_rules_down.sql (restores the
-- 20261104010000 definition byte for byte).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  v text := md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
BEGIN
  IF v NOT IN ('b383b75b2c114c37758060a5e5493f3f', '4bb5ce8ad2c5a57cf3d34df0e3c8bfd6') THEN
    RAISE EXCEPTION 'v_dispatch_order_bills is not the 20261104010000 definition (md5 %); refusing', v;
  END IF;
END $guard$;

CREATE OR REPLACE VIEW public.v_dispatch_order_bills AS
-- orders, bills and the text CTEs are worked out once per read, never once per pair.
WITH orders AS MATERIALIZED (
  SELECT o.*,
         public.dispatch_supplier_name_key(o.supplier_name) AS name_key,
         public.dispatch_supplier_name_key(o.supplier_record_name) AS record_key,
         public.dispatch_job_number_pattern(o.job_number) AS job_pattern,
         -- The job number's digits: a bill whose text lacks them cannot name the job, so no pattern is run.
         substring(upper(o.job_number) FROM '^SW(?:MS|[A-Z])-([0-9]{4,6})$') AS job_digits,
         -- (c) a purchase order's number as words, and as its letters and digits run together or punctuated.
         CASE WHEN o.order_kind = 'purchase_order' AND length(btrim(coalesce(o.order_label, ''))) >= 5
                   AND o.order_label ~ '[0-9]'
              THEN ' ' || btrim(regexp_replace(upper(o.order_label), '[^A-Z0-9]+', ' ', 'g')) || ' ' END AS po_words,
         CASE WHEN o.order_kind = 'purchase_order' AND length(btrim(coalesce(o.order_label, ''))) >= 5 AND pm.m IS NOT NULL
              THEN '(?<![A-Z0-9])' || pm.m[1] || '[ #:.-]{0,3}' || pm.m[2] || '(?![A-Z0-9])' END AS po_pattern,
         -- (d) the job's site address, keyed as the context placer keys it.
         (SELECT public.context_address_key(j.site_address) FROM public.jobs j WHERE j.id = o.job_id) AS site_key
    FROM public.v_dispatch_orders o
    CROSS JOIN LATERAL (
      SELECT regexp_match(upper(btrim(coalesce(o.order_label, ''))), '^([A-Z]+)[ #:.-]*([0-9]+)$') AS m
    ) pm
), bills AS MATERIALIZED (
  SELECT x.xero_invoice_id, x.org_id, x.invoice_number, x.reference, x.line_items, x.xero_contact_id, x.contact_name,
         x.status, x.invoice_date, x.sub_total,
         public.dispatch_supplier_name_key(x.contact_name) AS contact_key
    FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY' AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'PAID')
), supplier_pairs AS (
  -- Each order with each live bill of the same supplier.
  SELECT o.order_kind, o.order_id, o.org_id, o.job_id, o.job_number, o.supplier_id, o.supplier_name, o.order_status,
         o.ordered_at, o.job_pattern, o.job_digits, o.order_label, o.po_words, o.po_pattern, o.site_key,
         b.xero_invoice_id, b.invoice_number, b.contact_name AS bill_contact_name, b.status AS bill_status,
         b.invoice_date AS bill_date, b.sub_total AS bill_sub_total, b.contact_key, o.name_key, o.record_key,
         CASE WHEN o.supplier_xero_contact_id IS NOT NULL AND b.xero_contact_id = o.supplier_xero_contact_id
              THEN 'xero_contact' ELSE 'supplier_name' END AS supplier_match
    FROM orders o
    JOIN bills b ON b.org_id = o.org_id AND (
           (o.supplier_xero_contact_id IS NOT NULL AND b.xero_contact_id = o.supplier_xero_contact_id)
        OR (b.contact_key IS NOT NULL AND EXISTS (
              SELECT 1 FROM unnest(ARRAY[o.name_key, o.record_key]) k(key)
               WHERE k.key IS NOT NULL
                 AND (k.key = b.contact_key
                      OR (length(k.key) >= 3 AND position(' ' || k.key || ' ' IN ' ' || b.contact_key || ' ') > 0)
                      OR (length(b.contact_key) >= 3 AND position(' ' || b.contact_key || ' ' IN ' ' || k.key || ' ') > 0)))))
), bill_texts AS MATERIALIZED (
  -- What each paired bill carries: its number, its reference and every line's text, upper case, one per line;
  -- the same as words; and the bill's document key (its longest run of 5 or more digits, leading zeros dropped).
  SELECT t.xero_invoice_id, t.bill_text,
         ' ' || btrim(regexp_replace(t.bill_text, '[^A-Z0-9]+', ' ', 'g')) || ' ' AS bill_words,
         t.bill_key
    FROM (
      SELECT b.xero_invoice_id,
             upper(concat_ws(E'\n', b.invoice_number, b.reference, (
               SELECT string_agg(l.value ->> 'Description', E'\n' ORDER BY l.n)
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.line_items) = 'array' THEN b.line_items ELSE '[]'::jsonb END)
                      WITH ORDINALITY l(value, n)))) AS bill_text,
             NULLIF((SELECT ltrim(r.m[1], '0') FROM regexp_matches(coalesce(b.invoice_number, ''), '([0-9]{5,})', 'g') r(m)
                      ORDER BY length(r.m[1]) DESC, r.m[1] LIMIT 1), '') AS bill_key
        FROM bills b
       WHERE b.xero_invoice_id IN (SELECT sp.xero_invoice_id FROM supplier_pairs sp)
    ) t
), pdf_docs AS MATERIALIZED (
  -- PDFs that came in by email and that we hold text for, keyed by each run of 5 or more digits in the file name
  -- (leading zeros dropped). A PDF we sent (our quote, order or invoice) is never a supplier's.
  SELECT d.event_id, ltrim(k.m[1], '0') AS doc_key,
         regexp_replace(lower(coalesce(m.payload ->> 'from', m.payload ->> 'from_email', '')), '[^a-z0-9]+', '', 'g') AS sender
    FROM (SELECT t.source_id, t.event_id FROM public.context_document_texts t
           WHERE t.source_kind = 'email_attachment' AND t.outcome = 'saved' AND t.event_id IS NOT NULL
          UNION
          SELECT v.source_id, v.event_id FROM public.context_document_vision_reads v
           WHERE v.source_kind = 'email_attachment' AND v.outcome = 'saved' AND v.event_id IS NOT NULL) d
    JOIN public.context_email_attachments c ON c.id = d.source_id
    JOIN public.business_events m ON m.id = c.business_event_id AND m.direction = 'inbound'
    CROSS JOIN LATERAL regexp_matches(coalesce(c.file_name, ''), '([0-9]{5,})', 'g') k(m)
), supplier_names AS MATERIALIZED (
  -- Each paired bill's supplier, as words: its Xero contact and the paired orders' supplier names, keyed.
  SELECT DISTINCT sp.xero_invoice_id, upper(k.key) AS name_words
    FROM supplier_pairs sp
    CROSS JOIN LATERAL unnest(ARRAY[sp.contact_key, sp.name_key, sp.record_key]) k(key)
   WHERE length(k.key) >= 3
), supplier_words AS MATERIALIZED (
  -- The same names' words of 5 or more letters, which the supplier's own email address carries.
  SELECT DISTINCT n.xero_invoice_id, lower(w.word) AS word
    FROM supplier_names n
    CROSS JOIN LATERAL regexp_split_to_table(n.name_words, ' ') w(word)
   WHERE length(w.word) >= 5 AND w.word ~ '^[A-Z]+$'
), pdf_found AS MATERIALIZED (
  -- Each such PDF of a paired bill sent by that supplier: its file name carries the bill's key and so does its text.
  SELECT t.xero_invoice_id, t.event_id, t.doc_text,
         ' ' || btrim(regexp_replace(t.doc_text, '[^A-Z0-9]+', ' ', 'g')) || ' ' AS doc_words
    FROM (
      SELECT DISTINCT bt.xero_invoice_id, pd.event_id, upper(e.payload ->> 'text') AS doc_text
        FROM bill_texts bt
        JOIN pdf_docs pd ON pd.doc_key = bt.bill_key
        JOIN public.business_events e ON e.id = pd.event_id
       WHERE bt.bill_key IS NOT NULL
         AND (e.payload ->> 'text') ~ ('(?<![0-9])0*' || bt.bill_key || '(?![0-9])')
         AND EXISTS (SELECT 1 FROM supplier_words w
                      WHERE w.xero_invoice_id = bt.xero_invoice_id AND position(w.word IN pd.sender) > 0)
    ) t
), pdf_texts AS MATERIALIZED (
  -- The supplier's PDF of each paired bill: one of those whose text names the bill's supplier.
  SELECT f.xero_invoice_id, string_agg(f.doc_text, E'\n' ORDER BY f.event_id) AS pdf_text,
         string_agg(f.doc_words, '' ORDER BY f.event_id) AS pdf_words
    FROM pdf_found f
   WHERE EXISTS (SELECT 1 FROM supplier_names n
                  WHERE n.xero_invoice_id = f.xero_invoice_id
                    AND position(' ' || n.name_words || ' ' IN f.doc_words) > 0)
   GROUP BY f.xero_invoice_id
), bill_sites AS MATERIALIZED (
  -- (d) every typed street address in the bill's own number, reference and lines, keyed as the context placer keys it.
  SELECT bt.xero_invoice_id, array_agg(DISTINCT m.address_key) AS site_keys
    FROM bill_texts bt
    CROSS JOIN LATERAL public.context_address_mentions(bt.bill_text) m
   WHERE m.typed AND m.address_key IS NOT NULL
   GROUP BY bt.xero_invoice_id
), pdf_sites AS MATERIALIZED (
  -- (d) every typed street address on the bill's PDF, keyed as the context placer keys it.
  SELECT p.xero_invoice_id, array_agg(DISTINCT m.address_key) AS site_keys
    FROM pdf_texts p
    CROSS JOIN LATERAL public.context_address_mentions(p.pdf_text) m
   WHERE m.typed AND m.address_key IS NOT NULL
   GROUP BY p.xero_invoice_id
), pairs AS (
  SELECT sp.*, bt.bill_text, bt.bill_words, bs.site_keys AS bill_site_keys, pt.pdf_text, pt.pdf_words, ps.site_keys
    FROM supplier_pairs sp
    JOIN bill_texts bt ON bt.xero_invoice_id = sp.xero_invoice_id
    LEFT JOIN bill_sites bs ON bs.xero_invoice_id = sp.xero_invoice_id
    LEFT JOIN pdf_texts pt ON pt.xero_invoice_id = sp.xero_invoice_id
    LEFT JOIN pdf_sites ps ON ps.xero_invoice_id = sp.xero_invoice_id
), named AS (
  -- What the bill carries for that order: (a) a saved ref, (b) its job number, (c) its PO number, (d) its site.
  SELECT p.*,
         ref.ref AS matched_ref,
         ref.linked_via AS ref_saved_via,
         coalesce(p.job_pattern IS NOT NULL AND position(p.job_digits IN p.bill_text) > 0 AND p.bill_text ~ p.job_pattern, false) AS names_job,
         coalesce(p.po_words IS NOT NULL AND (position(p.po_words IN p.bill_words) > 0
                                      OR (p.po_pattern IS NOT NULL AND p.bill_text ~ p.po_pattern)), false) AS po_on_bill,
         coalesce(p.po_words IS NOT NULL AND p.pdf_text IS NOT NULL AND (position(p.po_words IN p.pdf_words) > 0
                                      OR (p.po_pattern IS NOT NULL AND p.pdf_text ~ p.po_pattern)), false) AS po_on_pdf,
         -- Every rule test is true or false, never unknown: an unknown would let a disagreeing bill through.
         coalesce(p.site_key IS NOT NULL AND p.site_key = ANY (p.bill_site_keys), false) AS site_on_bill,
         coalesce(p.site_key IS NOT NULL AND p.site_key = ANY (p.site_keys), false) AS site_on_pdf
    FROM pairs p
    LEFT JOIN LATERAL (
      SELECT r.ref, r.linked_via
        FROM public.dispatch_v2_supplier_order_refs r
       WHERE p.order_kind = 'dispatch_v2_email'
         AND r.order_id = p.order_id
         AND r.ref ~ '^[A-Z0-9/-]{3,24}$'
         AND r.ref ~ '[0-9].*[0-9].*[0-9]'
         AND position(substring(r.ref FROM '[0-9]+') IN p.bill_text) > 0
         AND p.bill_text ~ ('(?<![A-Z0-9])' || regexp_replace(r.ref, '[-/]', '[-/ ]?', 'g') || '(?![A-Z0-9])')
       ORDER BY r.created_at, r.ref
       LIMIT 1
    ) ref ON true
), hits AS (
  SELECT n.*,
         (n.matched_ref IS NOT NULL OR n.po_on_bill OR n.po_on_pdf) AS picks,
         (n.names_job OR n.site_on_bill OR n.site_on_pdf) AS places
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
  SELECT h.*, pb.orders_named,
         CASE
           WHEN pb.pick_orders > 1 THEN 'several_order_numbers'
           WHEN pb.pick_orders = 1 AND NOT h.picks THEN 'other_order_ref'
           WHEN pb.pick_orders = 1 AND pb.place_jobs > 0 AND NOT (pb.place_jobs = 1 AND h.places) THEN 'job_disagrees'
           WHEN pb.pick_orders = 1 THEN NULL
           WHEN pb.place_jobs > 1 THEN 'several_jobs_named'
           WHEN pb.place_orders > 1 THEN 'several_orders_on_job'
           ELSE NULL
         END AS not_linked_reason
    FROM hits h
    JOIN per_bill pb ON pb.xero_invoice_id = h.xero_invoice_id
)
SELECT j.order_kind,
       j.order_id,
       j.org_id,
       j.job_id,
       j.job_number,
       j.supplier_id,
       j.supplier_name,
       j.order_status,
       j.ordered_at,
       j.xero_invoice_id,
       j.invoice_number,
       j.bill_contact_name,
       j.bill_status,
       j.bill_date,
       j.bill_sub_total,
       j.supplier_match,
       concat_ws('+', CASE WHEN j.matched_ref IS NOT NULL THEN 'supplier_ref' END,
                      CASE WHEN j.names_job THEN 'job_number' END,
                      CASE WHEN j.po_on_bill OR j.po_on_pdf THEN 'po_number' END,
                      CASE WHEN j.site_on_bill OR j.site_on_pdf THEN 'site_address' END) AS rule,
       j.matched_ref,
       j.ref_saved_via,
       CASE WHEN j.names_job THEN j.job_number END AS matched_job_number,
       j.not_linked_reason IS NULL AS linked,
       j.not_linked_reason,
       j.orders_named::integer AS orders_named,
       CASE WHEN j.po_on_bill OR j.po_on_pdf THEN j.order_label END AS matched_po_number,
       CASE WHEN j.site_on_bill OR j.site_on_pdf THEN j.site_key END AS matched_site_address,
       concat_ws('+', CASE WHEN j.matched_ref IS NOT NULL OR j.names_job OR j.po_on_bill OR j.site_on_bill THEN 'bill' END,
                      CASE WHEN j.po_on_pdf OR j.site_on_pdf THEN 'supplier_pdf' END) AS matched_in
  FROM judged j;
COMMENT ON VIEW public.v_dispatch_order_bills IS
  'B4 20261104010000, rules (c) and (d) 20261104040000: each live supplier bill (ACCPAY, AUTHORISED or PAID) of a Dispatch order''s supplier that carries, for that order, (a) a supplier ref saved for it, (b) its job number, (c) its PO number (bill or supplier PDF) or (d) its job''s site address on the bill or the supplier PDF (context_address_key). rule lists what matched (supplier_ref, job_number, po_number, site_address, joined by +). linked: the bill names this order only (an order''s own number picks it when the job agrees); otherwise not_linked_reason (several_order_numbers, other_order_ref, job_disagrees, several_jobs_named, several_orders_on_job). Never same supplier and amount alone. Linked by rule, never by a person; places no bill and adds no money. Read only; service role only.';

DO $after$
DECLARE
  v text := md5(pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true));
BEGIN
  IF v <> '4bb5ce8ad2c5a57cf3d34df0e3c8bfd6' THEN
    RAISE EXCEPTION 'v_dispatch_order_bills after the change is not the reviewed definition (md5 %)', v;
  END IF;
END $after$;

REVOKE ALL ON public.v_dispatch_order_bills FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_dispatch_order_bills TO service_role;
