INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'xero_unlinked_match_on_change_v1', false,
  'The unlinked invoice matcher runs only when an invoice changed, or hourly'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'xero_unlinked_match_on_change_v1'
);
