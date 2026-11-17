-- Reapply the real migration, then read back its only row.
\ir ../../../migrations/20261117160200_xero_unlinked_match_switch.sql
DO $contract$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags
      WHERE flag_name = 'xero_unlinked_match_on_change_v1') <> 1 THEN
    RAISE EXCEPTION 'unlinked matcher switch must exist exactly once after reapply';
  END IF;
  IF (SELECT enabled FROM public.feature_flags
      WHERE flag_name = 'xero_unlinked_match_on_change_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'unlinked matcher switch must be disabled';
  END IF;
END;
$contract$;
