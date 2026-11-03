-- B4 (finish line, 3 Nov 2026): a Dispatch order and its supplier bill link to each other by themselves.
--
-- The owner's rule (decided 3 Nov 2026): a supplier bill links to a Dispatch order when the bill's supplier is
-- the order's supplier AND the bill carries either
--   (a) the supplier's own order, quote or invoice number already saved for that order
--       (dispatch_v2_supplier_order_refs, written by the supplier reply matcher), or
--   (b) our job number for that order's job (the order email's subject is "Material Order Ref <job number>").
-- No price goes on the order; the bill carries the money.
--
-- What this adds (read only; nothing here writes a row):
--   v_dispatch_orders       one row per Dispatch order: every Dispatch v2 supplier order email that went out
--                           (sent, or send_unknown) and every purchase order on a job that is not a draft and
--                           not cancelled.
--   v_dispatch_order_bills  one row per supplier bill (Xero ACCPAY, AUTHORISED or PAID) of that order's supplier
--                           that carries (a) or (b) for the order, with the rule that matched (rule, matched_ref,
--                           matched_job_number) and whether it links (linked). A bill links to one order only:
--                           when it names more than one order, none is linked and not_linked_reason says why.
--   dispatch_supplier_name_key(text), dispatch_job_number_pattern(text): the two pieces of the rule.
--
-- "The bill's supplier is the order's supplier": the order's supplier record has the bill's Xero contact, or
-- the two names agree once company words are dropped (Pty, Ltd, WA, Trust and the like): one name's words are
-- a whole-word run of the other's ("Metroll" and "Metroll Perth", "CMI" and "CMI (Combined Metal Industries /
-- CMI WA)", "R&R Fencing" and "R&R FENCING"). Most Dispatch v2 suppliers have no Xero contact on their record.
-- "Carries": the bill's number, its reference or any line's text holds the saved ref or the job number as a
-- whole word (a job number written the ways bill_prematch.ts reads it: SWP-261309, SWP261309, SWP 261309).
-- Purchase orders have no saved supplier refs, so for them only (b) applies.
--
-- Nothing else changes: no bill placement (job_materials_facts, materials_reconciliation_queue,
-- xero_invoices.job_id), no Job Profit view (v_job_cost_events, v_job_profit) and no money total. Job Profit's
-- ops-api job_profit read shows these views per order ("ordered, billed, not billed"); see
-- docs/job-profit-read-contract.md. This migration replaces no view or function: every object is new, and the
-- guard refuses if an object of the same name exists that is not this migration's (its comment carries
-- "B4 20261104010000"). Running it again is safe.
--
-- Rollback: supabase/rollbacks/20261104010000_dispatch_order_bill_links_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  o record;
BEGIN
  FOR o IN
    SELECT 'public.v_dispatch_orders' AS name, to_regclass('public.v_dispatch_orders')::oid AS oid, 'pg_class' AS cat
    UNION ALL SELECT 'public.v_dispatch_order_bills', to_regclass('public.v_dispatch_order_bills')::oid, 'pg_class'
    UNION ALL SELECT 'public.dispatch_supplier_name_key(text)', to_regprocedure('public.dispatch_supplier_name_key(text)')::oid, 'pg_proc'
    UNION ALL SELECT 'public.dispatch_job_number_pattern(text)', to_regprocedure('public.dispatch_job_number_pattern(text)')::oid, 'pg_proc'
  LOOP
    IF o.oid IS NOT NULL AND coalesce(obj_description(o.oid, o.cat), '') NOT LIKE '%B4 20261104010000%' THEN
      RAISE EXCEPTION '% already exists and is not this migration''s; refusing', o.name;
    END IF;
  END LOOP;
END $guard$;

-- A supplier name without company words, lower case, words split by one space. NULL when nothing is left.
-- Built-ins are named with pg_catalog. instead of a SET search_path clause, so the planner can inline the
-- function into the view (a SET clause stops that: rehearsed on production, 2.1 s a read against 0.2 s).
CREATE OR REPLACE FUNCTION public.dispatch_supplier_name_key(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(pg_catalog.lower(COALESCE(p_name, '')), '[^a-z0-9]+', ' ', 'g'),
           '\m(pty|ltd|limited|proprietary|inc|co|company|corp|group|the|australia|aust|wa|trust|trustee|for|atf|and)\M',
           ' ', 'g'), '\s+', ' ', 'g')), '')
$fn$;
COMMENT ON FUNCTION public.dispatch_supplier_name_key(text) IS
  'B4 20261104010000: a supplier name without company words (Pty, Ltd, WA, Trust, ...), lower case, single spaced. Two names agree when one key is a whole-word run of the other. Used by v_dispatch_order_bills.';

-- The pattern (upper case text) that finds one job number written as bill_prematch.ts reads it: the hyphen
-- form always, and with 5 or 6 digits also run together or spaced. NULL for a job number not of that shape.
CREATE OR REPLACE FUNCTION public.dispatch_job_number_pattern(p_job_number text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN t.m IS NULL THEN NULL
              ELSE '(?<![A-Z0-9])SW' OPERATOR(pg_catalog.||) t.m[1]
                   OPERATOR(pg_catalog.||) CASE WHEN pg_catalog.length(t.m[2]) OPERATOR(pg_catalog.>=) 5
                                                THEN '(?:-|[ \t]?-?[ \t]?)' ELSE '-' END
                   OPERATOR(pg_catalog.||) t.m[2] OPERATOR(pg_catalog.||) '(?![A-Z0-9])' END
  FROM (SELECT pg_catalog.regexp_match(pg_catalog.upper(pg_catalog.btrim(COALESCE(p_job_number, ''))),
                                       '^SW(MS|[A-Z])-([0-9]{4,6})$') AS m) t
$fn$;
COMMENT ON FUNCTION public.dispatch_job_number_pattern(text) IS
  'B4 20261104010000: the regular expression (for upper case text) that finds this job number on a supplier bill: SWP-261309, and with 5 or 6 digits SWP261309 or SWP 261309, never inside a longer word or number. Used by v_dispatch_order_bills.';

CREATE OR REPLACE VIEW public.v_dispatch_orders AS
SELECT 'dispatch_v2_email'::text AS order_kind,
       o.id AS order_id,
       o.org_id,
       o.job_id,
       j.job_number,
       o.supplier_id,
       o.supplier_name,
       s.name AS supplier_record_name,
       s.xero_contact_id AS supplier_xero_contact_id,
       o.status AS order_status,
       o.sent_at AS ordered_at,
       o.subject AS order_label
  FROM public.dispatch_supplier_order_emails o
  JOIN public.jobs j ON j.id = o.job_id
  LEFT JOIN public.suppliers s ON s.id = o.supplier_id
 WHERE o.status IN ('sent', 'send_unknown')
UNION ALL
SELECT 'purchase_order'::text,
       p.id,
       p.org_id,
       p.job_id,
       j.job_number,
       p.supplier_id,
       p.supplier_name,
       s.name,
       coalesce(p.xero_contact_id, s.xero_contact_id),
       p.status,
       coalesce(p.last_sent_at, p.created_at),
       p.po_number
  FROM public.purchase_orders p
  JOIN public.jobs j ON j.id = p.job_id
  LEFT JOIN public.suppliers s ON s.id = p.supplier_id
 WHERE lower(coalesce(p.status, '')) <> ALL (ARRAY['draft', 'cancelled', 'canceled', 'void', 'voided', 'deleted']);
COMMENT ON VIEW public.v_dispatch_orders IS
  'B4 20261104010000: one row per Dispatch order: each Dispatch v2 supplier order email that went out (sent or send_unknown; one email = one order) and each purchase order on a job that is not a draft or cancelled. order_label is the email subject or the PO number. Read only; service role only.';

CREATE OR REPLACE VIEW public.v_dispatch_order_bills AS
-- orders, bills and bill_texts are worked out once per read (a dozen orders, about 2,400 live bills, the text of
-- the bills that pair with an order), never once per pair.
WITH orders AS MATERIALIZED (
  SELECT o.*,
         public.dispatch_supplier_name_key(o.supplier_name) AS name_key,
         public.dispatch_supplier_name_key(o.supplier_record_name) AS record_key,
         public.dispatch_job_number_pattern(o.job_number) AS job_pattern,
         -- The job number's digits: a bill whose text lacks them cannot name the job, so no pattern is run.
         substring(upper(o.job_number) FROM '^SW(?:MS|[A-Z])-([0-9]{4,6})$') AS job_digits
    FROM public.v_dispatch_orders o
), bills AS MATERIALIZED (
  SELECT x.xero_invoice_id, x.org_id, x.invoice_number, x.reference, x.line_items, x.xero_contact_id, x.contact_name,
         x.status, x.invoice_date, x.sub_total,
         public.dispatch_supplier_name_key(x.contact_name) AS contact_key
    FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY' AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'PAID')
), supplier_pairs AS (
  -- Each order with each live bill of the same supplier.
  SELECT o.order_kind, o.order_id, o.org_id, o.job_id, o.job_number, o.supplier_id, o.supplier_name, o.order_status,
         o.ordered_at, o.job_pattern, o.job_digits,
         b.xero_invoice_id, b.invoice_number, b.contact_name AS bill_contact_name, b.status AS bill_status,
         b.invoice_date AS bill_date, b.sub_total AS bill_sub_total,
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
  -- What each paired bill carries: its number, its reference and every line's text, upper case, one per line.
  SELECT b.xero_invoice_id,
         upper(concat_ws(E'\n', b.invoice_number, b.reference, (
           SELECT string_agg(l.value ->> 'Description', E'\n' ORDER BY l.n)
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.line_items) = 'array' THEN b.line_items ELSE '[]'::jsonb END)
                  WITH ORDINALITY l(value, n)))) AS bill_text
    FROM bills b
   WHERE b.xero_invoice_id IN (SELECT sp.xero_invoice_id FROM supplier_pairs sp)
), pairs AS (
  SELECT sp.*, bt.bill_text FROM supplier_pairs sp JOIN bill_texts bt ON bt.xero_invoice_id = sp.xero_invoice_id
), named AS (
  -- The pairs where the bill carries (a) a saved ref of that order or (b) that order's job number.
  SELECT p.*,
         ref.ref AS matched_ref,
         ref.linked_via AS ref_saved_via,
         (p.job_pattern IS NOT NULL AND position(p.job_digits IN p.bill_text) > 0 AND p.bill_text ~ p.job_pattern) AS names_job
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
  SELECT n.* FROM named n WHERE n.matched_ref IS NOT NULL OR n.names_job
), per_bill AS (
  SELECT h.xero_invoice_id,
         count(*) AS orders_named,
         count(*) FILTER (WHERE h.matched_ref IS NOT NULL) AS ref_orders,
         count(DISTINCT h.job_id) FILTER (WHERE h.names_job) AS jobs_named,
         count(*) FILTER (WHERE h.names_job) AS job_orders
    FROM hits h
   GROUP BY h.xero_invoice_id
), judged AS (
  SELECT h.*, pb.orders_named,
         CASE
           WHEN pb.ref_orders > 1 THEN 'several_saved_refs'
           WHEN pb.ref_orders = 1 AND h.matched_ref IS NULL THEN 'other_order_ref'
           WHEN pb.ref_orders = 1 AND pb.jobs_named > 0 AND NOT (pb.jobs_named = 1 AND h.names_job) THEN 'job_disagrees'
           WHEN pb.ref_orders = 1 THEN NULL
           WHEN pb.jobs_named > 1 THEN 'several_jobs_named'
           WHEN pb.job_orders > 1 THEN 'several_orders_on_job'
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
       CASE WHEN j.matched_ref IS NOT NULL AND j.names_job THEN 'supplier_ref+job_number'
            WHEN j.matched_ref IS NOT NULL THEN 'supplier_ref'
            ELSE 'job_number' END AS rule,
       j.matched_ref,
       j.ref_saved_via,
       CASE WHEN j.names_job THEN j.job_number END AS matched_job_number,
       j.not_linked_reason IS NULL AS linked,
       j.not_linked_reason,
       j.orders_named::integer AS orders_named
  FROM judged j;
COMMENT ON VIEW public.v_dispatch_order_bills IS
  'B4 20261104010000: each live supplier bill (ACCPAY, AUTHORISED or PAID) of a Dispatch order''s supplier that carries (a) a supplier ref saved for that order or (b) the order''s job number, with the rule (supplier_ref, job_number, supplier_ref+job_number) and whether it links. linked: the bill names this order only (a saved ref picks one order when the job agrees); otherwise not_linked_reason (several_saved_refs, other_order_ref, job_disagrees, several_jobs_named, several_orders_on_job). Linked by rule, never by a person; places no bill and adds no money. Read only; service role only.';

REVOKE ALL ON public.v_dispatch_orders, public.v_dispatch_order_bills FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_dispatch_orders, public.v_dispatch_order_bills TO service_role;
REVOKE ALL ON FUNCTION public.dispatch_supplier_name_key(text), public.dispatch_job_number_pattern(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_supplier_name_key(text), public.dispatch_job_number_pattern(text) TO service_role;
