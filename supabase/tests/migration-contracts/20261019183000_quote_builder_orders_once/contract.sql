-- Contract: 20261019183000_quote_builder_orders_once. One set of purchase orders and one work
-- order per quote builder version, held by the database: a seq on every version-linked PO, a
-- unique (version, seq) key, a CHECK that a linked PO carries its seq, a lasting order marker per
-- version and kind (RLS on), and the purchase order press's own switch seeded off. Existing linked
-- orders are numbered and marked; plain orders are untouched.
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.qo_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'quote builder orders once contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.qo_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation THEN
 RETURN true;
END $$;

-- Pre-existing rows: numbered 1, 2 in PO number order; the plain order untouched; markers back-filled.
SELECT pg_temp.qo_assert((SELECT array_agg(quote_builder_po_seq ORDER BY po_number) FROM public.purchase_orders
  WHERE quote_builder_version_id = '9b000000-0000-4000-8000-0000000000a1') = ARRAY[1, 2]::smallint[],
 'existing linked purchase orders must be numbered 1, 2 by PO number');
SELECT pg_temp.qo_assert((SELECT quote_builder_po_seq IS NULL FROM public.purchase_orders
  WHERE id = '9b000000-0000-4000-8000-0000000000b9'), 'a plain purchase order must get no seq');
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.quote_builder_order_marks
  WHERE quote_builder_version_id = '9b000000-0000-4000-8000-0000000000a1') = 2,
 'existing orders must be marked, one marker per kind');

-- The switch is seeded off.
SELECT pg_temp.qo_assert((SELECT enabled = false FROM public.feature_flags
  WHERE flag_name = 'quote_builder_purchase_orders_v1'), 'the purchase order switch must be seeded off');

-- The marker table is closed to clients.
SELECT pg_temp.qo_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.quote_builder_order_marks'::regclass),
 'row level security must be on for the order markers');
SELECT pg_temp.qo_assert(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
  AND tablename = 'quote_builder_order_marks'), 'the order markers must have no policy');

BEGIN;
-- One set per version: a second row with the same seq is refused.
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 INSERT INTO public.purchase_orders (job_id, po_number, quote_builder_version_id, quote_builder_po_seq)
 VALUES ('9b000000-0000-4000-8000-000000000001', 'PO-9B-X', '9b000000-0000-4000-8000-0000000000a1', 1)
$q$), 'a second purchase order with the same version and seq must be refused');
-- A linked order without its seq, a seq of 0, and a seq without a version are refused.
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 INSERT INTO public.purchase_orders (job_id, po_number, quote_builder_version_id)
 VALUES ('9b000000-0000-4000-8000-000000000001', 'PO-9B-Y', '9b000000-0000-4000-8000-0000000000a1')
$q$), 'a version-linked purchase order without a seq must be refused');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 INSERT INTO public.purchase_orders (job_id, po_number, quote_builder_version_id, quote_builder_po_seq)
 VALUES ('9b000000-0000-4000-8000-000000000001', 'PO-9B-Z', '9b000000-0000-4000-8000-0000000000a1', 0)
$q$), 'a seq of 0 must be refused');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 INSERT INTO public.purchase_orders (job_id, po_number, quote_builder_po_seq)
 VALUES ('9b000000-0000-4000-8000-000000000001', 'PO-9B-W', 1)
$q$), 'a seq without a version must be refused');
-- The next seq is accepted, and a plain order still needs neither.
INSERT INTO public.purchase_orders (job_id, po_number, quote_builder_version_id, quote_builder_po_seq)
VALUES ('9b000000-0000-4000-8000-000000000001', 'PO-9B-3', '9b000000-0000-4000-8000-0000000000a1', 3);
INSERT INTO public.purchase_orders (job_id, po_number) VALUES ('9b000000-0000-4000-8000-000000000001', 'PO-9B-PLAIN');
-- One marker per version and kind.
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 INSERT INTO public.quote_builder_order_marks (quote_builder_version_id, kind)
 VALUES ('9b000000-0000-4000-8000-0000000000a1', 'purchase_orders')
$q$), 'a second purchase order marker for a version must be refused');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 INSERT INTO public.quote_builder_order_marks (quote_builder_version_id, kind)
 VALUES ('9b000000-0000-4000-8000-0000000000a1', 'invoice')
$q$), 'an unknown marker kind must be refused');
ROLLBACK;
