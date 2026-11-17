-- After the down migration: the switch row is gone (read as off) and the
-- feature_flags table is still there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'dispatch_order_quote_ref_line_v1') THEN
    RAISE EXCEPTION 'rollback contract: the switch is still there';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: feature_flags was dropped';
  END IF;
END $$;
