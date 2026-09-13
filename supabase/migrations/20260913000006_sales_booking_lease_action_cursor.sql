-- Isolated booking_test only. Unique live leases, action fingerprints, tenant cursor keys.
ALTER TABLE sales_booking_actions ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS sales_booking_actions_idempotency
  ON sales_booking_actions (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

UPDATE sales_booking_leases SET released = true
  WHERE released = false AND expires_at <= now();

CREATE UNIQUE INDEX IF NOT EXISTS sales_booking_leases_live
  ON sales_booking_leases (org_id, case_id, action_kind)
  WHERE released = false;

ALTER TABLE sales_booking_cursors DROP CONSTRAINT IF EXISTS sales_booking_cursors_pkey;
ALTER TABLE sales_booking_cursors ADD PRIMARY KEY (org_id, key);

CREATE OR REPLACE FUNCTION sales_booking_acquire_lease(
  p_org_id uuid, p_lease_id text, p_case_id text, p_action_kind text, p_token text, p_owner text, p_ttl_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE live text;
DECLARE gen text;
BEGIN
  IF p_org_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'org_required'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('sales_booking_lease:' || p_org_id::text || ':' || p_case_id || ':' || p_action_kind));
  UPDATE sales_booking_leases
    SET released = true
    WHERE org_id = p_org_id AND case_id = p_case_id AND action_kind = p_action_kind
      AND released = false AND expires_at <= now();
  SELECT token INTO live FROM sales_booking_leases
    WHERE org_id = p_org_id AND case_id = p_case_id AND action_kind = p_action_kind
      AND released = false AND expires_at > now()
    LIMIT 1;
  IF live IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'lease_held', 'token', live);
  END IF;
  gen := gen_random_uuid()::text;
  INSERT INTO sales_booking_leases (lease_id, org_id, case_id, action_kind, token, owner, expires_at, released, generation)
  VALUES (p_lease_id, p_org_id, p_case_id, p_action_kind, p_token, p_owner, now() + make_interval(secs => p_ttl_seconds), false, gen);
  RETURN jsonb_build_object('ok', true, 'token', p_token, 'lease_id', p_lease_id, 'generation', gen);
END;
$$;

CREATE OR REPLACE FUNCTION sales_booking_release_lease(
  p_org_id uuid, p_lease_id text, p_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE sales_booking_leases
    SET released = true
    WHERE org_id = p_org_id AND lease_id = p_lease_id;
  RETURN jsonb_build_object('ok', true, 'lease_id', p_lease_id);
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
  ON CONFLICT (org_id, key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now();
  RETURN jsonb_build_object('ok', true, 'key', p_key);
END;
$$;

REVOKE ALL ON FUNCTION sales_booking_acquire_lease(uuid, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_booking_release_lease(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_booking_put_consumption_cursor(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sales_booking_acquire_lease(uuid, text, text, text, text, text, integer) TO service_role, marninstobbe;
GRANT EXECUTE ON FUNCTION sales_booking_release_lease(uuid, text, text) TO service_role, marninstobbe;
GRANT EXECUTE ON FUNCTION sales_booking_put_consumption_cursor(uuid, text, jsonb) TO service_role, marninstobbe;
GRANT ALL ON TABLE sales_booking_actions TO marninstobbe;
GRANT ALL ON TABLE sales_booking_leases TO marninstobbe;
GRANT ALL ON TABLE sales_booking_cursors TO marninstobbe;
