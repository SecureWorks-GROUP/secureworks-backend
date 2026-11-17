DO $contract$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
      WHERE flag_name = 'xero_unlinked_match_on_change_v1') THEN
    RAISE EXCEPTION 'rollback must remove the unlinked matcher switch';
  END IF;
END;
$contract$;
