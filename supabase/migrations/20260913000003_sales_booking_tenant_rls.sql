-- Tenant-scope Booking workflow. Deny public roles. RPCs require org_id.
-- service_role BYPASSRLS: tenancy is enforced in RPCs and server queries, not only RLS.

ALTER TABLE sales_booking_cases ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_drafts ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_offers ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_actions ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_archives ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_assessments ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_cursors ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_seen_events ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_seen_events ADD COLUMN IF NOT EXISTS processed boolean NOT NULL DEFAULT false;
ALTER TABLE sales_booking_slot_claims ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_leases ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_leases ADD COLUMN IF NOT EXISTS generation text;
ALTER TABLE sales_booking_source_revisions ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE sales_booking_cases ADD COLUMN IF NOT EXISTS last_runner_at timestamptz;
ALTER TABLE sales_booking_drafts ADD COLUMN IF NOT EXISTS actor_id uuid;

DO $$ BEGIN
  ALTER TABLE sales_booking_seen_events DROP CONSTRAINT sales_booking_seen_events_pkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE sales_booking_seen_events ADD PRIMARY KEY (org_id, event_key);
EXCEPTION WHEN invalid_table_definition THEN NULL;
END $$;

ALTER TABLE sales_booking_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_seen_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_slot_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_booking_source_revisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE sales_booking_cases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_drafts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_offers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_actions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_archives FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_assessments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_cursors FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_seen_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_slot_claims FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_leases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE sales_booking_source_revisions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE sales_booking_cases TO service_role;
GRANT ALL ON TABLE sales_booking_drafts TO service_role;
GRANT ALL ON TABLE sales_booking_offers TO service_role;
GRANT ALL ON TABLE sales_booking_actions TO service_role;
GRANT ALL ON TABLE sales_booking_archives TO service_role;
GRANT ALL ON TABLE sales_booking_assessments TO service_role;
GRANT ALL ON TABLE sales_booking_cursors TO service_role;
GRANT ALL ON TABLE sales_booking_seen_events TO service_role;
GRANT ALL ON TABLE sales_booking_slot_claims TO service_role;
GRANT ALL ON TABLE sales_booking_leases TO service_role;
GRANT ALL ON TABLE sales_booking_source_revisions TO service_role;

DROP FUNCTION IF EXISTS sales_booking_claim_slot(text, text, text, text, text);
DROP FUNCTION IF EXISTS sales_booking_acquire_lease(text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS sales_booking_cas_case(text, text, text, text);
DROP FUNCTION IF EXISTS sales_booking_ingest_event(text);
DROP FUNCTION IF EXISTS sales_booking_put_consumption_cursor(text, jsonb);

CREATE OR REPLACE FUNCTION sales_booking_claim_slot(
  p_org_id uuid, p_claim_id text, p_resource_id text, p_start_iso text, p_end_iso text, p_case_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE conflict int;
BEGIN
  IF p_org_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'org_required'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('sales_booking_slot:' || p_org_id::text || ':' || p_resource_id));
  IF EXISTS (SELECT 1 FROM sales_booking_slot_claims WHERE org_id = p_org_id AND claim_id = p_claim_id AND withdrawn = false) THEN
    RETURN jsonb_build_object('ok', true, 'claim_id', p_claim_id, 'idempotent', true);
  END IF;
  SELECT COUNT(*) INTO conflict FROM sales_booking_slot_claims
  WHERE org_id = p_org_id AND resource_id = p_resource_id AND withdrawn = false AND claim_id <> p_claim_id
    AND tstzrange(start_iso::timestamptz, end_iso::timestamptz, '[)')
        && tstzrange(p_start_iso::timestamptz, p_end_iso::timestamptz, '[)');
  IF conflict > 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'slot_overlap'); END IF;
  INSERT INTO sales_booking_slot_claims (claim_id, org_id, resource_id, start_iso, end_iso, case_id, status, withdrawn)
  VALUES (p_claim_id, p_org_id, p_resource_id, p_start_iso, p_end_iso, p_case_id, 'held', false);
  RETURN jsonb_build_object('ok', true, 'claim_id', p_claim_id);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_acquire_lease(
  p_org_id uuid, p_lease_id text, p_case_id text, p_action_kind text, p_token text, p_owner text, p_ttl_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE live text;
DECLARE gen text;
BEGIN
  IF p_org_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'org_required'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('sales_booking_lease:' || p_org_id::text || ':' || p_case_id));
  SELECT token INTO live FROM sales_booking_leases
  WHERE org_id = p_org_id AND case_id = p_case_id AND action_kind = p_action_kind
    AND released = false AND expires_at > now() LIMIT 1;
  IF live IS NOT NULL AND live <> p_token THEN
    RETURN jsonb_build_object('ok', false, 'code', 'lease_held', 'token', live);
  END IF;
  gen := gen_random_uuid()::text;
  INSERT INTO sales_booking_leases (lease_id, org_id, case_id, action_kind, token, owner, expires_at, released, generation)
  VALUES (p_lease_id, p_org_id, p_case_id, p_action_kind, p_token, p_owner, now() + make_interval(secs => p_ttl_seconds), false, gen)
  ON CONFLICT (lease_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, owner = EXCLUDED.owner, released = false, token = EXCLUDED.token, generation = EXCLUDED.generation;
  RETURN jsonb_build_object('ok', true, 'token', p_token, 'lease_id', p_lease_id, 'generation', gen);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_cas_case(
  p_org_id uuid, p_id text, p_expected_version text, p_next_version text, p_status text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE n int;
BEGIN
  UPDATE sales_booking_cases
  SET source_version = p_next_version, status = COALESCE(p_status, status), updated_at = now()
  WHERE org_id = p_org_id AND id = p_id AND source_version IS NOT DISTINCT FROM p_expected_version;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'cas_conflict'); END IF;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'source_version', p_next_version);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_ingest_event(p_org_id uuid, p_event_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE was boolean;
BEGIN
  SELECT processed INTO was FROM sales_booking_seen_events WHERE org_id = p_org_id AND event_key = p_event_key;
  IF FOUND THEN
    IF was THEN RETURN jsonb_build_object('ok', true, 'duplicate', true, 'processed', true, 'retry', false); END IF;
    RETURN jsonb_build_object('ok', true, 'duplicate', false, 'processed', false, 'retry', true);
  END IF;
  INSERT INTO sales_booking_seen_events (org_id, event_key, processed) VALUES (p_org_id, p_event_key, false);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'processed', false, 'retry', false);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_mark_event_processed(p_org_id uuid, p_event_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE sales_booking_seen_events SET processed = true WHERE org_id = p_org_id AND event_key = p_event_key;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_put_consumption_cursor(p_org_id uuid, p_key text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_key NOT LIKE 'consume:%' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_consumption_cursor'); END IF;
  INSERT INTO sales_booking_cursors (org_id, key, payload, updated_at)
  VALUES (p_org_id, p_key, p_payload, now())
  ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), org_id = EXCLUDED.org_id;
  RETURN jsonb_build_object('ok', true, 'key', p_key);
END;
$$;

REVOKE ALL ON FUNCTION sales_booking_claim_slot(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_booking_acquire_lease(uuid, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_booking_cas_case(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_booking_ingest_event(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_booking_mark_event_processed(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_booking_put_consumption_cursor(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sales_booking_claim_slot(uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION sales_booking_acquire_lease(uuid, text, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION sales_booking_cas_case(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION sales_booking_ingest_event(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION sales_booking_mark_event_processed(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION sales_booking_put_consumption_cursor(uuid, text, jsonb) TO service_role;
