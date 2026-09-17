BEGIN;

-- 1. kind=roster is accepted; send is still refused.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload, published_by)
    VALUES (
      'marnin',
      '2026-09-14',
      'roster',
      '2026-09-17T08:00:00Z',
      '{"opportunities":[{"id":"opp-1"}],"exhausted":true,"pages_scanned":1,"total":1,"reason":null,"read_at":"2026-09-17T08:00:00Z"}'::jsonb,
      'contract'
    );
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'contract: roster kind was refused';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload)
    VALUES ('marnin', '2026-09-14', 'send', now(), '{}'::jsonb);
    RAISE EXCEPTION 'contract: unknown kind send was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

-- 2. Latest roster is greatest as_of for that resource and week.
INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload, published_by)
VALUES (
  'marnin',
  '2026-09-14',
  'roster',
  '2026-09-17T09:00:00Z',
  '{"opportunities":[{"id":"opp-2"}],"exhausted":true,"pages_scanned":2,"total":2,"reason":null,"read_at":"2026-09-17T09:00:00Z"}'::jsonb,
  'contract'
);

DO $$
DECLARE
  latest jsonb;
BEGIN
  SELECT payload INTO latest
  FROM public.sales_booking_packs
  WHERE resource = 'marnin' AND week_start = '2026-09-14' AND kind = 'roster'
  ORDER BY as_of DESC
  LIMIT 1;
  IF latest->>'read_at' <> '2026-09-17T09:00:00Z' THEN
    RAISE EXCEPTION 'contract: latest roster is not the greatest as_of: %', latest;
  END IF;
END $$;

-- 3. thread_facts remains accepted after the kind check is rewritten.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload, published_by)
    VALUES (
      'nithin',
      '1970-01-05',
      'thread_facts',
      '2026-09-17T09:00:00Z',
      '{"facts":{}}'::jsonb,
      'contract'
    );
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'contract: thread_facts kind was refused after roster widening';
  END;
END $$;

-- 4. Sunday week_start is still refused for roster.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload)
    VALUES ('marnin', '2026-09-13', 'roster', now(), '{}'::jsonb);
    RAISE EXCEPTION 'contract: Sunday week_start was accepted for roster';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

-- 5. Server-owned: RLS on, browser roles hold no privilege.
DO $$
DECLARE
  policies integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_booking_packs'::regclass) THEN
    RAISE EXCEPTION 'contract: row level security is not enabled on sales_booking_packs';
  END IF;
  IF has_table_privilege('anon', 'public.sales_booking_packs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sales_booking_packs', 'INSERT') THEN
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
