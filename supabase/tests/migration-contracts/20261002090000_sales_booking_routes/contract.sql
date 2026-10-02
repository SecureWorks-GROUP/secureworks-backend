-- Booking routes: the owner's 28 Sep seed, one audited write per change,
-- no silent overwrite, append-only history, closed to the API roles.
BEGIN;

CREATE FUNCTION pg_temp.expect_refusal(sql text, expected text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'sales_booking_routes contract: % raised "%" not "%"', sql, SQLERRM, expected;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'sales_booking_routes contract: expected refusal "%" for: %', expected, sql;
END;
$$;

-- The seed is exactly the owner's mapping; Stratco keeps STRATCO FENCING.
DO $$
DECLARE
  got text;
BEGIN
  SELECT string_agg(
    concat_ws('|', id, position, enabled, match_trade,
      coalesce(match_lead_source, '-'), coalesce(match_tag, '-'),
      coalesce(match_pipeline_id, '-'), person, calendar_id),
    ',' ORDER BY position)
  INTO got FROM public.sales_booking_routes;
  IF got IS DISTINCT FROM
    'stratco-fencing-marnin|10|t|fencing|stratco|-|-|marnin|dEQKVKHthsjSYaen1fiE,' ||
    'normal-fencing-khairo|20|t|fencing|normal|-|-|khairo|i6j9vaCy6c94n3i93cir,' ||
    'patio-nithin|30|t|patio|-|-|-|nithin|RSQnT8cQdEE8azb5Chlq' THEN
    RAISE EXCEPTION 'sales_booking_routes contract: seed is %', got;
  END IF;
  IF (SELECT count(*) FROM public.sales_booking_route_changes
      WHERE op = 'seed' AND before IS NULL AND after IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'sales_booking_routes contract: seed is not audited';
  END IF;
END $$;

-- A create writes the rule and its audit row together.
SELECT public.sales_booking_route_write(
  'create', 'vip-fencing-marnin',
  '{"position": 5, "enabled": true, "label": "VIP tag", "match_trade": "fencing",
    "match_tag": "vip", "person": "marnin", "calendar_id": "dEQKVKHthsjSYaen1fiE",
    "calendar_name": "STRATCO FENCING"}'::jsonb,
  NULL, '00000000-0000-4000-8000-0000000000aa', 'marnin@secureworkswa.com.au',
  'contract create');
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sales_booking_route_changes
    WHERE route_id = 'vip-fencing-marnin' AND op = 'create' AND before IS NULL
      AND after->>'match_tag' = 'vip'
      AND changed_by_email = 'marnin@secureworkswa.com.au'
      AND changed_by_user_id = '00000000-0000-4000-8000-0000000000aa'
      AND reason = 'contract create'
  ) THEN
    RAISE EXCEPTION 'sales_booking_routes contract: create not audited';
  END IF;
END $$;

-- A second create of the same id, an unknown op and no actor all refuse.
SELECT pg_temp.expect_refusal($q$
  SELECT public.sales_booking_route_write('create', 'vip-fencing-marnin',
    '{"position": 6, "enabled": true, "person": "marnin", "calendar_id": "dEQKVKHthsjSYaen1fiE"}'::jsonb,
    NULL, NULL, 'marnin@secureworkswa.com.au', NULL)
$q$, 'route_exists');
SELECT pg_temp.expect_refusal($q$
  SELECT public.sales_booking_route_write('replace', 'patio-nithin', '{}'::jsonb,
    NULL, NULL, 'marnin@secureworkswa.com.au', NULL)
$q$, 'route_op_invalid');
SELECT pg_temp.expect_refusal($q$
  SELECT public.sales_booking_route_write('delete', 'patio-nithin', NULL,
    now(), NULL, ' ', NULL)
$q$, 'route_actor_required');
-- A malformed calendar id never lands.
SELECT pg_temp.expect_refusal($q$
  SELECT public.sales_booking_route_write('create', 'bad-calendar',
    '{"position": 7, "enabled": true, "person": "marnin", "calendar_id": "not a calendar"}'::jsonb,
    NULL, NULL, 'marnin@secureworkswa.com.au', NULL)
$q$, 'sales_booking_routes_calendar_id_check');

-- An update must name the version it read; a stale one changes nothing.
SELECT pg_temp.expect_refusal($q$
  SELECT public.sales_booking_route_write('update', 'patio-nithin',
    '{"position": 30, "enabled": false, "match_trade": "patio", "person": "nithin",
      "calendar_id": "RSQnT8cQdEE8azb5Chlq"}'::jsonb,
    '2000-01-01T00:00:00Z', NULL, 'marnin@secureworkswa.com.au', NULL)
$q$, 'route_changed_since_read');
SELECT pg_temp.expect_refusal($q$
  SELECT public.sales_booking_route_write('update', 'no-such-rule',
    '{"position": 1, "enabled": true, "person": "nithin", "calendar_id": "RSQnT8cQdEE8azb5Chlq"}'::jsonb,
    now(), NULL, 'marnin@secureworkswa.com.au', NULL)
$q$, 'route_not_found');

DO $$
DECLARE
  read_at timestamptz;
  result jsonb;
BEGIN
  SELECT updated_at INTO read_at FROM public.sales_booking_routes
  WHERE id = 'patio-nithin';
  result := public.sales_booking_route_write('update', 'patio-nithin',
    '{"position": 30, "enabled": false, "label": "Patio leads: Nithin",
      "match_trade": "patio", "person": "nithin",
      "calendar_id": "RSQnT8cQdEE8azb5Chlq", "calendar_name": "Nithin''s scope calendar"}'::jsonb,
    read_at, NULL, 'marnin@secureworkswa.com.au', 'contract disable');
  IF (result->'before'->>'enabled')::boolean IS DISTINCT FROM true
     OR (result->'after'->>'enabled')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'sales_booking_routes contract: update result %', result;
  END IF;
  IF (SELECT enabled FROM public.sales_booking_routes WHERE id = 'patio-nithin') THEN
    RAISE EXCEPTION 'sales_booking_routes contract: update not written';
  END IF;
  -- The version it read is now stale.
  PERFORM pg_temp.expect_refusal(format($q$
    SELECT public.sales_booking_route_write('delete', 'patio-nithin', NULL,
      %L, NULL, 'marnin@secureworkswa.com.au', NULL)
  $q$, read_at), 'route_changed_since_read');
END $$;

-- A delete keeps the history.
DO $$
DECLARE
  read_at timestamptz;
BEGIN
  SELECT updated_at INTO read_at FROM public.sales_booking_routes
  WHERE id = 'vip-fencing-marnin';
  PERFORM public.sales_booking_route_write('delete', 'vip-fencing-marnin',
    NULL, read_at, NULL, 'marnin@secureworkswa.com.au', 'contract delete');
  IF EXISTS (SELECT 1 FROM public.sales_booking_routes WHERE id = 'vip-fencing-marnin') THEN
    RAISE EXCEPTION 'sales_booking_routes contract: delete not written';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sales_booking_route_changes
    WHERE route_id = 'vip-fencing-marnin' AND op = 'delete'
      AND before->>'match_tag' = 'vip' AND after IS NULL
  ) THEN
    RAISE EXCEPTION 'sales_booking_routes contract: delete not audited';
  END IF;
END $$;

-- The history is append-only.
SELECT pg_temp.expect_refusal($q$
  UPDATE public.sales_booking_route_changes SET reason = 'rewritten'
$q$, 'append-only');
SELECT pg_temp.expect_refusal($q$
  DELETE FROM public.sales_booking_route_changes
$q$, 'append-only');

-- Re-applying the migration keeps the owner's edit and adds no seed row.
\ir ../../../migrations/20261002090000_sales_booking_routes.sql
DO $$
BEGIN
  IF (SELECT enabled FROM public.sales_booking_routes WHERE id = 'patio-nithin') THEN
    RAISE EXCEPTION 'sales_booking_routes contract: re-apply overwrote an owner edit';
  END IF;
  IF (SELECT count(*) FROM public.sales_booking_route_changes WHERE op = 'seed') <> 3 THEN
    RAISE EXCEPTION 'sales_booking_routes contract: re-apply re-seeded';
  END IF;
END $$;

-- Closed to the API roles; the service role reads, and writes only through
-- the audited function.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.sales_booking_routes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sales_booking_routes', 'SELECT')
     OR has_table_privilege('anon', 'public.sales_booking_route_changes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sales_booking_route_changes', 'SELECT') THEN
    RAISE EXCEPTION 'sales_booking_routes contract: API roles can read';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sales_booking_routes', 'SELECT')
     OR has_table_privilege('service_role', 'public.sales_booking_routes', 'INSERT')
     OR has_table_privilege('service_role', 'public.sales_booking_routes', 'UPDATE')
     OR has_table_privilege('service_role', 'public.sales_booking_routes', 'DELETE')
     OR has_table_privilege('service_role', 'public.sales_booking_route_changes', 'INSERT') THEN
    RAISE EXCEPTION 'sales_booking_routes contract: service role writes around the audit';
  END IF;
  IF has_function_privilege('anon',
       'public.sales_booking_route_write(text, text, jsonb, timestamptz, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.sales_booking_route_write(text, text, jsonb, timestamptz, uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.sales_booking_route_write(text, text, jsonb, timestamptz, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'sales_booking_routes contract: write function grants';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_booking_routes'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sales_booking_route_changes'::regclass) THEN
    RAISE EXCEPTION 'sales_booking_routes contract: RLS off';
  END IF;
END $$;

ROLLBACK;
