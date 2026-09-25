-- Marnin, Nithin and Khairo text approvals record; anyone else, and a row
-- whose snapshot names a different person, still refuse.
CREATE OR REPLACE FUNCTION pg_temp.approval(hash_char text, row_resource text, snap_resource text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.sales_booking_approvals (
    binding_hash, step, resource, week_start, state, reason, snapshot,
    approved_by_user_id, approved_by_email, approved_at, expires_at
  ) VALUES (
    repeat(hash_char, 64), 'message', row_resource, DATE '2026-09-21',
    'approved', NULL,
    jsonb_build_object(
      'schema', 'scope-booking-approval.v1', 'step', 'message',
      'resource', snap_resource, 'week_start', '2026-09-21',
      'content_hash', repeat('0', 64), 'content', '{}'::jsonb,
      'pack_revision', NULL, 'contact_id', 'contact-1'),
    '706c5258-70dd-483a-b36c-af6864b24498', 'marnin@secureworkswa.com.au',
    TIMESTAMPTZ '2026-09-24 10:00+08', TIMESTAMPTZ '2026-09-24 10:15+08'
  )
$$;

BEGIN;
SELECT pg_temp.approval('a', 'marnin', 'marnin');
SELECT pg_temp.approval('b', 'nithin', 'nithin');
SELECT pg_temp.approval('c', 'khairo', 'khairo');
DO $$
BEGIN
  IF (SELECT count(*) FROM public.sales_booking_approvals) <> 3 THEN
    RAISE EXCEPTION 'expected the three booking people to record';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.approval('d', 'hugo', 'hugo');
    RAISE EXCEPTION 'an approval for someone outside the three people was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.approval('e', 'khairo', 'marnin');
    RAISE EXCEPTION 'a row whose snapshot names another person was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
