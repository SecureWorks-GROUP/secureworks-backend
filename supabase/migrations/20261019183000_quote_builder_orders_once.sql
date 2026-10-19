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
-- A version-linked row without a seq is refused (IS NOT NULL is spelt out:
-- a bare ">= 1" on NULL is UNKNOWN and would pass), so an older writer that
-- does not set the seq cannot slip past the key. Rollout: the older writer
-- only runs while quote_builder_orders_v1 is on (off live, 19 Oct 2026); ship
-- the ops-api that sets the seq with or before this migration, and keep the
-- switch off until both are live.
--
-- Locks: one ALTER, one UPDATE over the version-linked rows and one index
-- build on purchase_orders, under a 5s lock timeout. If the lock cannot be
-- had, the migration fails and nothing changes.
--
-- Rollback: supabase/rollbacks/20261019183000_quote_builder_orders_once_down.sql.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS quote_builder_po_seq smallint NULL;

-- Number every version-linked row still without a seq, after the version's
-- highest seq so far, so mixed or re-run states never collide and the CHECK
-- below always validates.
UPDATE public.purchase_orders po
   SET quote_builder_po_seq = numbered.seq
  FROM (
    SELECT u.id,
           COALESCE((SELECT max(x.quote_builder_po_seq)
                       FROM public.purchase_orders x
                      WHERE x.quote_builder_version_id = u.quote_builder_version_id), 0)
           + row_number() OVER (
               PARTITION BY u.quote_builder_version_id ORDER BY u.po_number, u.created_at, u.id
             ) AS seq
      FROM public.purchase_orders u
     WHERE u.quote_builder_version_id IS NOT NULL
       AND u.quote_builder_po_seq IS NULL
  ) numbered
 WHERE po.id = numbered.id;

ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_quote_builder_seq_with_version;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_quote_builder_seq_with_version CHECK (
    (quote_builder_version_id IS NULL AND quote_builder_po_seq IS NULL)
    OR (quote_builder_version_id IS NOT NULL AND quote_builder_po_seq IS NOT NULL
        AND quote_builder_po_seq >= 1)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_quote_builder_version_seq
  ON public.purchase_orders (quote_builder_version_id, quote_builder_po_seq)
  WHERE quote_builder_version_id IS NOT NULL;

COMMENT ON COLUMN public.purchase_orders.quote_builder_po_seq IS
  'Set only by quote_builder_make_purchase_orders with quote_builder_version_id: the supplier group''s place in the issued version. Unique per version, so a version makes one set of POs.';

-- The lasting record that a version's orders were made: one row per version
-- and kind, written by ops-api BEFORE the orders and never removed by it. Only
-- the press that writes it makes the orders; every other press reads back. A
-- version whose orders were all removed by hand is then refused, not re-made:
-- the removed orders may already be with the supplier. A marker left by a make
-- that failed part way also refuses (the safe side); staff make any order by
-- hand. Same access as quote_builder_versions: RLS on, no policy, ops-api only.
CREATE TABLE IF NOT EXISTS public.quote_builder_order_marks (
  quote_builder_version_id uuid NOT NULL
    REFERENCES public.quote_builder_versions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('work_order', 'purchase_orders')),
  made_at timestamptz NOT NULL DEFAULT now(),
  made_by uuid NULL,
  CONSTRAINT quote_builder_order_marks_pkey PRIMARY KEY (quote_builder_version_id, kind)
);
ALTER TABLE public.quote_builder_order_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quote_builder_order_marks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.quote_builder_order_marks TO service_role;
COMMENT ON TABLE public.quote_builder_order_marks IS
  'One row per quote builder version and order kind once its orders were made (docs/quote-builder-contract.md section 6). Written before the orders; ops-api deletes it only when its own make failed with nothing written.';

-- Orders made before this table existed get their marker.
INSERT INTO public.quote_builder_order_marks (quote_builder_version_id, kind)
SELECT DISTINCT quote_builder_version_id, 'purchase_orders' FROM public.purchase_orders
 WHERE quote_builder_version_id IS NOT NULL
UNION
SELECT DISTINCT quote_builder_version_id, 'work_order' FROM public.work_orders
 WHERE quote_builder_version_id IS NOT NULL
ON CONFLICT DO NOTHING;
