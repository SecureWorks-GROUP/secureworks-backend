-- Contract: 20261016150000_dispatch_deliveries. Six nullable columns, a sighting always names a
-- person, both "by" columns point at users, existing orders are untouched, and nothing else is
-- added to purchase_orders (still one trigger).
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION pg_temp.dd_assert(ok boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(ok, false) THEN
 RAISE EXCEPTION 'dispatch deliveries contract: %', message; END IF; END $$;

SELECT pg_temp.dd_assert((SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND is_nullable = 'YES'
    AND column_default IS NULL
    AND (column_name, data_type) IN (('confirmed_delivery_set_at', 'timestamp with time zone'),
                                     ('confirmed_delivery_set_by', 'uuid'),
                                     ('confirmed_delivery_set_by_email', 'text'),
                                     ('delivery_sighted_at', 'timestamp with time zone'),
                                     ('delivery_sighted_by', 'uuid'),
                                     ('delivery_sighted_by_email', 'text'))) = 6,
 'purchase_orders must carry the six nullable slice 6 columns with no default');
SELECT pg_temp.dd_assert((SELECT count(*) FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.conrelid = 'public.purchase_orders'::regclass AND c.contype = 'f'
    AND c.confrelid = 'public.users'::regclass AND cardinality(c.conkey) = 1
    AND a.attname IN ('confirmed_delivery_set_by', 'delivery_sighted_by')) = 2,
 'both set_by and sighted_by must reference users(id)');
SELECT pg_temp.dd_assert((SELECT count(*) FROM pg_trigger
  WHERE tgrelid = 'public.purchase_orders'::regclass AND NOT tgisinternal) = 1,
 'purchase_orders must still carry exactly one trigger');

BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
 ('00000000-0000-4000-8000-0000000006a1', '00000000-0000-4000-8000-0000000006f0', 'Contract Person')
 ON CONFLICT (id) DO NOTHING;
INSERT INTO public.purchase_orders (id, po_number, delivery_date, confirmed_delivery_date, delivery_confirmed_at)
 VALUES ('00000000-0000-4000-8000-0000000006b1', 'PO-DD-1', '2026-04-07', '2026-04-09', '2026-04-07T05:09:00Z');
-- An order made before slice 6 reads exactly as it did: the new columns are null.
SELECT pg_temp.dd_assert((SELECT confirmed_delivery_set_at IS NULL AND delivery_sighted_at IS NULL
   AND delivery_date = '2026-04-07' AND confirmed_delivery_date = '2026-04-09'
   AND delivery_confirmed_at = '2026-04-07T05:09:00Z'
  FROM public.purchase_orders WHERE id = '00000000-0000-4000-8000-0000000006b1'),
 'an existing order must keep every value it had');
-- A named sighting lands; delivery_confirmed_at is not touched by it.
UPDATE public.purchase_orders SET delivery_sighted_at = now(),
  delivery_sighted_by = '00000000-0000-4000-8000-0000000006a1', delivery_sighted_by_email = 'person@example.test'
 WHERE id = '00000000-0000-4000-8000-0000000006b1';
SELECT pg_temp.dd_assert((SELECT delivery_sighted_at IS NOT NULL AND delivery_confirmed_at = '2026-04-07T05:09:00Z'
  FROM public.purchase_orders WHERE id = '00000000-0000-4000-8000-0000000006b1'),
 'a named sighting must land and leave delivery_confirmed_at alone');
-- A sighting with no person is refused, and so is a name with no time.
DO $$
BEGIN
 BEGIN
  UPDATE public.purchase_orders SET delivery_sighted_by_email = NULL
   WHERE id = '00000000-0000-4000-8000-0000000006b1';
  RAISE EXCEPTION 'dispatch deliveries contract: a sighting with no person must be refused';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  UPDATE public.purchase_orders SET delivery_sighted_at = NULL
   WHERE id = '00000000-0000-4000-8000-0000000006b1';
  RAISE EXCEPTION 'dispatch deliveries contract: a sighter with no time must be refused';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
-- A sighter who is not a user is refused.
DO $$
BEGIN
 BEGIN
  UPDATE public.purchase_orders SET delivery_sighted_by = '00000000-0000-4000-8000-0000000006ff'
   WHERE id = '00000000-0000-4000-8000-0000000006b1';
  RAISE EXCEPTION 'dispatch deliveries contract: a sighter who is not a user must be refused';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
ROLLBACK;
