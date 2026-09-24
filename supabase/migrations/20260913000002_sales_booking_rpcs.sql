-- Production reducers for Sales Booking. booking_test is a transport to prove these.
-- Provider ingestion/cursors remain CIO-owned. These keys are workflow consumption only.

CREATE OR REPLACE FUNCTION sales_booking_claim_slot(
  p_claim_id text,
  p_resource_id text,
  p_start_iso text,
  p_end_iso text,
  p_case_id text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  conflict int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sales_booking_slot:' || p_resource_id));
  SELECT COUNT(*) INTO conflict
  FROM sales_booking_slot_claims
  WHERE resource_id = p_resource_id
    AND withdrawn = false
    AND tstzrange(start_iso::timestamptz, end_iso::timestamptz, '[)')
        && tstzrange(p_start_iso::timestamptz, p_end_iso::timestamptz, '[)');
  IF conflict > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'slot_overlap');
  END IF;
  INSERT INTO sales_booking_slot_claims (claim_id, resource_id, start_iso, end_iso, case_id, status, withdrawn)
  VALUES (p_claim_id, p_resource_id, p_start_iso, p_end_iso, p_case_id, 'held', false);
  RETURN jsonb_build_object('ok', true, 'claim_id', p_claim_id);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_acquire_lease(
  p_lease_id text,
  p_case_id text,
  p_action_kind text,
  p_token text,
  p_owner text,
  p_ttl_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  live text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sales_booking_lease:' || p_case_id));
  SELECT token INTO live
  FROM sales_booking_leases
  WHERE case_id = p_case_id
    AND action_kind = p_action_kind
    AND released = false
    AND expires_at > now()
  LIMIT 1;
  IF live IS NOT NULL AND live <> p_token THEN
    RETURN jsonb_build_object('ok', false, 'code', 'lease_held', 'token', live);
  END IF;
  INSERT INTO sales_booking_leases (lease_id, case_id, action_kind, token, owner, expires_at, released)
  VALUES (p_lease_id, p_case_id, p_action_kind, p_token, p_owner, now() + make_interval(secs => p_ttl_seconds), false)
  ON CONFLICT (lease_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, owner = EXCLUDED.owner, released = false;
  RETURN jsonb_build_object('ok', true, 'token', p_token, 'lease_id', p_lease_id);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_cas_case(
  p_id text,
  p_expected_version text,
  p_next_version text,
  p_status text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  n int;
BEGIN
  UPDATE sales_booking_cases
  SET source_version = p_next_version,
      status = COALESCE(p_status, status),
      updated_at = now()
  WHERE id = p_id
    AND source_version IS NOT DISTINCT FROM p_expected_version;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cas_conflict');
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'source_version', p_next_version);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_ingest_event(p_event_key text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO sales_booking_seen_events (event_key) VALUES (p_event_key);
  RETURN jsonb_build_object('ok', true, 'duplicate', false);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', true, 'duplicate', true);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_put_consumption_cursor(p_key text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_key NOT LIKE 'consume:%' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_consumption_cursor');
  END IF;
  INSERT INTO sales_booking_cursors (key, payload, updated_at)
  VALUES (p_key, p_payload, now())
  ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now();
  RETURN jsonb_build_object('ok', true, 'key', p_key);
END;
$$;
