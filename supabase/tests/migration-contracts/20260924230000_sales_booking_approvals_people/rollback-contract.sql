-- After the rollback only Marnin's approvals record again.
BEGIN;
DO $$
BEGIN
  INSERT INTO public.sales_booking_approvals (
    binding_hash, step, resource, week_start, state, reason, snapshot,
    approved_by_user_id, approved_by_email, approved_at, expires_at
  ) VALUES (
    repeat('f', 64), 'message', 'nithin', DATE '2026-09-21', 'approved', NULL,
    jsonb_build_object(
      'schema', 'scope-booking-approval.v1', 'step', 'message',
      'resource', 'nithin', 'week_start', '2026-09-21',
      'content_hash', repeat('0', 64), 'content', '{}'::jsonb,
      'pack_revision', NULL, 'contact_id', 'contact-1'),
    '706c5258-70dd-483a-b36c-af6864b24498', 'marnin@secureworkswa.com.au',
    TIMESTAMPTZ '2026-09-24 10:00+08', TIMESTAMPTZ '2026-09-24 10:15+08');
  RAISE EXCEPTION 'rollback left Nithin approvals accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
ROLLBACK;
