-- Approved-send approvals: immutable content, one-way single-use status,
-- no deletes, append-only audit, closed to the API roles.
BEGIN;

CREATE FUNCTION pg_temp.expect_refusal(sql text, expected text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'approved_send contract: % raised "%" not "%"', sql, SQLERRM, expected;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'approved_send contract: expected refusal "%" for: %', expected, sql;
END;
$$;

INSERT INTO public.approved_send_approvals (
  id, schema_version, channel, approved_by, approved_at, approval_words,
  approval_source, recorded_by_actor, recorded_via, payload, payload_hash,
  seal, expires_at
) VALUES
  ('00000000-0000-4000-8000-000000000001', 'secureworks.approved-send.sms/v1', 'sms',
   'marnin', now() - interval '5 minutes', 'yes send it', 'contract',
   'seat:rayleigh', 'ops_agent_server_key', '{"message":"hi"}',
   'sha256:' || repeat('a', 64), 'hmac-sha256:' || repeat('b', 64), now() + interval '1 day'),
  ('00000000-0000-4000-8000-000000000002', 'secureworks.approved-send.sms/v1', 'sms',
   'marnin', now() - interval '2 days', 'yes send it', 'contract',
   'seat:rayleigh', 'ops_agent_server_key', '{"message":"old"}',
   'sha256:' || repeat('c', 64), 'hmac-sha256:' || repeat('d', 64), now() - interval '1 day');

-- A new approval must start unclaimed.
SELECT pg_temp.expect_refusal($q$
  INSERT INTO public.approved_send_approvals (
    id, schema_version, channel, approved_by, approved_at, approval_words,
    approval_source, recorded_by_actor, recorded_via, payload, payload_hash,
    seal, expires_at, status
  ) VALUES ('00000000-0000-4000-8000-000000000003', 's', 'sms', 'marnin', now(),
    'w', 'src', 'seat:rayleigh', 'service_role', '{}', 'sha256:' || repeat('e', 64),
    'hmac-sha256:' || repeat('f', 64), now() + interval '1 hour', 'sent')
$q$, 'must start unclaimed');

-- The approved content is immutable.
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET payload = '{"message":"changed"}'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'immutable');
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET expires_at = now() + interval '30 days'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'immutable');
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET approval_words = 'something else'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'immutable');

-- Straight to sent, skipping the claim, is refused.
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET status = 'sent'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'is not allowed');

-- A claim needs its token; an expired approval cannot be claimed.
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET status = 'sending'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'claimed_at and claim_token');
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals
  SET status = 'sending', claimed_at = now(), claim_token = '00000000-0000-4000-8000-0000000000aa'
  WHERE id = '00000000-0000-4000-8000-000000000002'
$q$, 'expired');

UPDATE public.approved_send_approvals
SET status = 'sending', claimed_at = now(), claim_token = '00000000-0000-4000-8000-0000000000bb'
WHERE id = '00000000-0000-4000-8000-000000000001' AND status = 'approved';

-- Single use: the claim cannot be undone.
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET status = 'approved'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'is not allowed');
-- A second compare-and-set claim finds nothing to claim.
DO $$
DECLARE claimed integer;
BEGIN
  UPDATE public.approved_send_approvals
  SET status = 'sending', claimed_at = now(), claim_token = '00000000-0000-4000-8000-0000000000cc'
  WHERE id = '00000000-0000-4000-8000-000000000001' AND status = 'approved';
  GET DIAGNOSTICS claimed = ROW_COUNT;
  IF claimed <> 0 THEN
    RAISE EXCEPTION 'approved_send contract: a used approval was claimed again';
  END IF;
END;
$$;

UPDATE public.approved_send_approvals
SET status = 'sent', outcome_at = now(), provider_message_id = 'ghl-1', provider_detail = '{}'
WHERE id = '00000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET status = 'sending'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'is not allowed');
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_approvals SET provider_message_id = 'other'
  WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'change only with status');
SELECT pg_temp.expect_refusal($q$
  DELETE FROM public.approved_send_approvals WHERE id = '00000000-0000-4000-8000-000000000001'
$q$, 'never deleted');

-- The audit is append-only.
INSERT INTO public.approved_send_audit (approval_id, event, code)
VALUES ('00000000-0000-4000-8000-000000000001', 'claimed', NULL);
SELECT pg_temp.expect_refusal($q$
  UPDATE public.approved_send_audit SET event = 'sent'
$q$, 'append-only');
SELECT pg_temp.expect_refusal($q$
  DELETE FROM public.approved_send_audit
$q$, 'append-only');

-- Closed to the API roles.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.approved_send_approvals'::regclass)
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.approved_send_audit'::regclass) THEN
    RAISE EXCEPTION 'approved_send contract: RLS is not enabled';
  END IF;
  IF has_table_privilege('anon', 'public.approved_send_approvals', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated', 'public.approved_send_approvals', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('anon', 'public.approved_send_audit', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated', 'public.approved_send_audit', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'approved_send contract: an API role can reach the approval tables';
  END IF;
END;
$$;

ROLLBACK;
