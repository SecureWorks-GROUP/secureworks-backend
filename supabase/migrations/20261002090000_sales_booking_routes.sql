-- Booking routes: who books which lead, into which GHL calendar.
--
-- Owner ask (2 Oct 2026): who gets which leads, which calendar, and simple
-- filters (lead source such as Stratco, patios vs fencing) are his to change
-- without code. One row per rule; enabled rules are read in `position` order
-- and the first match wins. The matching itself is owned by
-- supabase/functions/ops-api/sales_booking_routes.ts.
--
-- Additive only: two new tables, one write function, one guard trigger, and
-- the owner's 28 Sep 2026 mapping as seed rows. No existing table, column,
-- function or policy is touched. The seed keeps STRATCO FENCING
-- (dEQKVKHthsjSYaen1fiE) as the Stratco calendar, so Stratco booking is
-- unchanged on merge.
--
--   * sales_booking_routes: the rules. Closed to anon and authenticated; the
--     service role may only READ it. Every change goes through
--     sales_booking_route_write, which writes the rule and its audit row in
--     one transaction.
--   * sales_booking_route_changes: append-only audit (who, when, before,
--     after, why). No update, no delete.
-- Rollback: supabase/rollbacks/20261002090000_sales_booking_routes_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.sales_booking_routes (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 10000),
  enabled boolean NOT NULL DEFAULT true,
  label text CHECK (label IS NULL OR length(label) <= 200),
  match_trade text CHECK (match_trade IN ('fencing', 'patio')),
  match_lead_source text CHECK (match_lead_source IN ('stratco', 'normal')),
  match_tag text CHECK (
    match_tag IS NULL OR length(btrim(match_tag)) BETWEEN 1 AND 100
  ),
  match_pipeline_id text CHECK (
    match_pipeline_id IS NULL OR match_pipeline_id ~ '^[A-Za-z0-9]{6,64}$'
  ),
  person text NOT NULL CHECK (person ~ '^[a-z][a-z0-9_]{0,31}$'),
  calendar_id text NOT NULL CHECK (calendar_id ~ '^[A-Za-z0-9]{6,64}$'),
  calendar_name text CHECK (calendar_name IS NULL OR length(calendar_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_email text NOT NULL CHECK (length(btrim(updated_by_email)) > 0)
);

CREATE TABLE IF NOT EXISTS public.sales_booking_route_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  -- Deliberately no foreign key: a deleted rule keeps its history.
  route_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('seed', 'create', 'update', 'delete')),
  before jsonb,
  after jsonb,
  changed_by_user_id uuid,
  changed_by_email text NOT NULL CHECK (length(btrim(changed_by_email)) > 0),
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  CHECK ((op IN ('seed', 'create')) = (before IS NULL)),
  CHECK ((op = 'delete') = (after IS NULL))
);

CREATE INDEX IF NOT EXISTS sales_booking_route_changes_route_idx
  ON public.sales_booking_route_changes (route_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.sales_booking_route_changes_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales_booking_route_changes is append-only';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sales_booking_route_changes'
      AND t.tgname = 'sales_booking_route_changes_append_only'
      AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER sales_booking_route_changes_append_only
      BEFORE UPDATE OR DELETE ON public.sales_booking_route_changes
      FOR EACH ROW
      EXECUTE FUNCTION public.sales_booking_route_changes_append_only();
  END IF;
END $$;

-- One audited change. `p_route` is the whole rule (create, update); the
-- caller (ops-api, owner-gated) validates people and ids. An update or delete
-- must name the `updated_at` it read, so two edits never silently overwrite
-- each other. Raises with a named message; writes nothing on any refusal.
CREATE OR REPLACE FUNCTION public.sales_booking_route_write(
  p_op text,
  p_route_id text,
  p_route jsonb,
  p_expected_updated_at timestamptz,
  p_actor_user_id uuid,
  p_actor_email text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old_row public.sales_booking_routes%ROWTYPE;
  new_row public.sales_booking_routes%ROWTYPE;
  found_old boolean;
  change_id bigint;
BEGIN
  IF p_op IS NULL OR p_op NOT IN ('create', 'update', 'delete') THEN
    RAISE EXCEPTION 'route_op_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_actor_email IS NULL OR length(btrim(p_actor_email)) = 0 THEN
    RAISE EXCEPTION 'route_actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_op IN ('create', 'update') AND (
    p_route IS NULL OR jsonb_typeof(p_route) <> 'object'
  ) THEN
    RAISE EXCEPTION 'route_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO old_row FROM public.sales_booking_routes
  WHERE id = p_route_id FOR UPDATE;
  found_old := FOUND;

  IF p_op = 'create' THEN
    IF found_old THEN
      RAISE EXCEPTION 'route_exists' USING ERRCODE = '23505';
    END IF;
    INSERT INTO public.sales_booking_routes (
      id, position, enabled, label, match_trade, match_lead_source, match_tag,
      match_pipeline_id, person, calendar_id, calendar_name, updated_by_email
    ) VALUES (
      p_route_id,
      (p_route->>'position')::integer,
      (p_route->>'enabled')::boolean,
      p_route->>'label',
      p_route->>'match_trade',
      p_route->>'match_lead_source',
      p_route->>'match_tag',
      p_route->>'match_pipeline_id',
      p_route->>'person',
      p_route->>'calendar_id',
      p_route->>'calendar_name',
      btrim(p_actor_email)
    ) RETURNING * INTO new_row;
  ELSE
    IF NOT found_old THEN
      RAISE EXCEPTION 'route_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF p_expected_updated_at IS NULL
       OR old_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'route_changed_since_read' USING ERRCODE = '40001';
    END IF;
    IF p_op = 'update' THEN
      UPDATE public.sales_booking_routes SET
        position = (p_route->>'position')::integer,
        enabled = (p_route->>'enabled')::boolean,
        label = p_route->>'label',
        match_trade = p_route->>'match_trade',
        match_lead_source = p_route->>'match_lead_source',
        match_tag = p_route->>'match_tag',
        match_pipeline_id = p_route->>'match_pipeline_id',
        person = p_route->>'person',
        calendar_id = p_route->>'calendar_id',
        calendar_name = p_route->>'calendar_name',
        updated_at = clock_timestamp(),
        updated_by_email = btrim(p_actor_email)
      WHERE id = p_route_id
      RETURNING * INTO new_row;
    ELSE
      DELETE FROM public.sales_booking_routes WHERE id = p_route_id;
    END IF;
  END IF;

  INSERT INTO public.sales_booking_route_changes (
    route_id, op, before, after, changed_by_user_id, changed_by_email, reason
  ) VALUES (
    p_route_id,
    p_op,
    CASE WHEN found_old THEN to_jsonb(old_row) END,
    CASE WHEN p_op = 'delete' THEN NULL ELSE to_jsonb(new_row) END,
    p_actor_user_id,
    btrim(p_actor_email),
    p_reason
  ) RETURNING id INTO change_id;

  RETURN jsonb_build_object(
    'change_id', change_id,
    'op', p_op,
    'route_id', p_route_id,
    'before', CASE WHEN found_old THEN to_jsonb(old_row) END,
    'after', CASE WHEN p_op = 'delete' THEN NULL ELSE to_jsonb(new_row) END
  );
END $$;

-- Seed: the owner's 28 Sep 2026 mapping. A rule that already exists (a
-- re-apply, or an owner edit) is left exactly as it is.
DO $$
DECLARE
  seed jsonb;
  inserted public.sales_booking_routes%ROWTYPE;
BEGIN
  FOR seed IN SELECT * FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object(
      'id', 'stratco-fencing-marnin', 'position', 10,
      'label', 'Stratco fencing leads: Marnin',
      'match_trade', 'fencing', 'match_lead_source', 'stratco',
      'person', 'marnin', 'calendar_id', 'dEQKVKHthsjSYaen1fiE',
      'calendar_name', 'STRATCO FENCING'),
    jsonb_build_object(
      'id', 'normal-fencing-khairo', 'position', 20,
      'label', 'Other fencing leads: Khairo',
      'match_trade', 'fencing', 'match_lead_source', 'normal',
      'person', 'khairo', 'calendar_id', 'i6j9vaCy6c94n3i93cir',
      'calendar_name', 'Fencing Scope'),
    jsonb_build_object(
      'id', 'patio-nithin', 'position', 30,
      'label', 'Patio leads: Nithin',
      'match_trade', 'patio', 'match_lead_source', NULL,
      'person', 'nithin', 'calendar_id', 'RSQnT8cQdEE8azb5Chlq',
      'calendar_name', 'Nithin''s scope calendar')
  ))
  LOOP
    INSERT INTO public.sales_booking_routes (
      id, position, enabled, label, match_trade, match_lead_source,
      person, calendar_id, calendar_name, updated_by_email
    ) VALUES (
      seed->>'id', (seed->>'position')::integer, true, seed->>'label',
      seed->>'match_trade', seed->>'match_lead_source', seed->>'person',
      seed->>'calendar_id', seed->>'calendar_name',
      'migration:20261002090000_sales_booking_routes'
    ) ON CONFLICT (id) DO NOTHING
    RETURNING * INTO inserted;
    IF FOUND THEN
      INSERT INTO public.sales_booking_route_changes (
        route_id, op, before, after, changed_by_email, reason
      ) VALUES (
        inserted.id, 'seed', NULL, to_jsonb(inserted),
        'migration:20261002090000_sales_booking_routes',
        'Owner mapping of 28 Sep 2026'
      );
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.sales_booking_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_booking_route_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_booking_routes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.sales_booking_route_changes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sales_booking_routes TO service_role;
GRANT SELECT ON public.sales_booking_route_changes TO service_role;
REVOKE ALL ON FUNCTION public.sales_booking_route_write(
  text, text, jsonb, timestamptz, uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_booking_route_write(
  text, text, jsonb, timestamptz, uuid, text, text
) TO service_role;
REVOKE ALL ON FUNCTION public.sales_booking_route_changes_append_only() FROM PUBLIC;
COMMENT ON TABLE public.sales_booking_routes IS
  'Booking routes: first enabled matching rule (by position) names the person and GHL calendar. Owner-edited through sales_booking_route_write only.';
COMMENT ON TABLE public.sales_booking_route_changes IS
  'Append-only audit of every booking route change: who, when, before, after, why.';
