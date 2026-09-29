-- The down migration removes exactly what the forward migration added.
DO $$
BEGIN
  IF to_regclass('public.approved_send_approvals') IS NOT NULL
    OR to_regclass('public.approved_send_audit') IS NOT NULL THEN
    RAISE EXCEPTION 'approved_send rollback: tables remain';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN (
    'approved_send_approvals_guard', 'approved_send_approvals_insert_guard',
    'approved_send_audit_append_only')) THEN
    RAISE EXCEPTION 'approved_send rollback: guard functions remain';
  END IF;
END;
$$;
