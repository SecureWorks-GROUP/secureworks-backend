BEGIN;

-- 1. Shape: columns, unique grain, Monday week_start, closed resource/kind lists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sales_booking_packs'
  ) THEN
    RAISE EXCEPTION 'contract: sales_booking_packs table is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_booking_packs'
      AND column_name = 'payload' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'contract: sales_booking_packs.payload is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sales_booking_packs'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%(resource, week_start, kind, as_of)%'
  ) THEN
    RAISE EXCEPTION 'contract: unique (resource, week_start, kind, as_of) is missing';
  END IF;
END $$;

-- 2. A Sunday week_start is refused; Monday Perth is accepted.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload, published_by)
    VALUES ('marnin', '2026-09-13', 'pack', '2026-09-16T07:48:47Z', '{}'::jsonb, 'contract');
    RAISE EXCEPTION 'contract: Sunday week_start was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload, published_by)
VALUES
  ('marnin', '2026-09-14', 'pack', '2026-09-16T07:00:00Z', '{"as_of":"old"}'::jsonb, 'contract'),
  ('marnin', '2026-09-14', 'pack', '2026-09-16T08:00:00Z', '{"as_of":"new"}'::jsonb, 'contract'),
  ('marnin', '2026-09-14', 'stamp', '2026-09-16T09:00:00Z', '{"approved":[]}'::jsonb, 'contract');

-- 3. Latest pack is greatest as_of; stamp is a separate kind.
DO $$
DECLARE
  latest jsonb;
  n integer;
BEGIN
  SELECT payload INTO latest
  FROM public.sales_booking_packs
  WHERE resource = 'marnin' AND week_start = '2026-09-14' AND kind = 'pack'
  ORDER BY as_of DESC
  LIMIT 1;
  IF latest->>'as_of' <> 'new' THEN
    RAISE EXCEPTION 'contract: latest pack is not the greatest as_of: %', latest;
  END IF;
  SELECT count(*) INTO n FROM public.sales_booking_packs
  WHERE resource = 'marnin' AND week_start = '2026-09-14';
  IF n <> 3 THEN
    RAISE EXCEPTION 'contract: expected 3 rows (2 packs + 1 stamp), got %', n;
  END IF;
END $$;

-- 4. Duplicate (resource, week_start, kind, as_of) is refused.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload, published_by)
    VALUES ('marnin', '2026-09-14', 'pack', '2026-09-16T08:00:00Z', '{"dup":true}'::jsonb, 'contract');
    RAISE EXCEPTION 'contract: duplicate as_of was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

-- 5. Closed lists: unknown resource and unknown kind refuse.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload)
    VALUES ('khairo', '2026-09-14', 'pack', now(), '{}'::jsonb);
    RAISE EXCEPTION 'contract: unknown resource was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload)
    VALUES ('marnin', '2026-09-14', 'send', now(), '{}'::jsonb);
    RAISE EXCEPTION 'contract: unknown kind was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

-- 6. Server-owned: RLS on, browser roles hold no privilege, no client policies.
DO $$
DECLARE
  policies integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_booking_packs'::regclass) THEN
    RAISE EXCEPTION 'contract: row level security is not enabled on sales_booking_packs';
  END IF;
  IF has_table_privilege('anon', 'public.sales_booking_packs', 'SELECT')
     OR has_table_privilege('anon', 'public.sales_booking_packs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.sales_booking_packs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sales_booking_packs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.sales_booking_packs', 'UPDATE') THEN
    RAISE EXCEPTION 'contract: browser roles still hold privileges on sales_booking_packs';
  END IF;
  SELECT count(*) INTO policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'sales_booking_packs';
  IF policies <> 0 THEN
    RAISE EXCEPTION 'contract: sales_booking_packs must have no client policies, got %', policies;
  END IF;
END $$;

ROLLBACK;
