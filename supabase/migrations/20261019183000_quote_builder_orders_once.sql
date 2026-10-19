-- Quote builder orders: one set of purchase orders per issued version, held
-- by the database, not only by ops-api's read-then-insert.
--
-- Contract: docs/quote-builder-contract.md (5.9). Writer: ops-api
-- quote_builder_make_purchase_orders (supabase/functions/ops-api/quote_builder.ts).
--
-- Why: the SQ-14 checklist run (19 Oct 2026, point 27) found that two presses
-- at the same instant could both read "no orders yet" and both insert, so a
-- version could get two sets of draft POs. Work orders already had
-- uq_work_orders_one_quote_builder_version (20261014140000); purchase orders
-- had a plain index only.
--
-- What: purchase_orders gains quote_builder_po_seq, the supplier group's place
-- (1, 2, ...) in the frozen version's material lines. ops-api sets it with
-- quote_builder_version_id on every row it makes, and a partial unique index
-- on (quote_builder_version_id, quote_builder_po_seq) refuses a second set:
-- the losing press's whole insert fails with 23505 and ops-api reads back the
-- winner's rows. The version id is the idempotency key; a renamed supplier
-- does not change the seq, so a rename never lets a second set in.
--
-- Additive only. Rows without a version link are untouched. Any version-linked
-- row already present is numbered first, in PO number order (none on 19 Oct
-- 2026: 0 rows, read by SELECT in the SQ-14 run), so the index always builds.
--
-- Rollback: supabase/rollbacks/20261019183000_quote_builder_orders_once_down.sql.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS quote_builder_po_seq smallint NULL;

UPDATE public.purchase_orders po
   SET quote_builder_po_seq = numbered.seq
  FROM (
    SELECT id, row_number() OVER (
      PARTITION BY quote_builder_version_id ORDER BY po_number, created_at, id
    ) AS seq
    FROM public.purchase_orders
    WHERE quote_builder_version_id IS NOT NULL
  ) numbered
 WHERE po.id = numbered.id
   AND po.quote_builder_po_seq IS NULL;

ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_quote_builder_seq_with_version;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_quote_builder_seq_with_version CHECK (
    (quote_builder_version_id IS NULL AND quote_builder_po_seq IS NULL)
    OR (quote_builder_version_id IS NOT NULL AND quote_builder_po_seq >= 1)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_quote_builder_version_seq
  ON public.purchase_orders (quote_builder_version_id, quote_builder_po_seq)
  WHERE quote_builder_version_id IS NOT NULL;

COMMENT ON COLUMN public.purchase_orders.quote_builder_po_seq IS
  'Set only by quote_builder_make_purchase_orders with quote_builder_version_id: the supplier group''s place in the issued version. Unique per version, so a version makes one set of POs.';
