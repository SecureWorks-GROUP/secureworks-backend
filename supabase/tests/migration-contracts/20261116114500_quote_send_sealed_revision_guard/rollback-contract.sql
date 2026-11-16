-- After the down: the switch and the document column are gone, the recorded
-- misses are kept and still append only.
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_send_sealed_revision_required_v1'),
    'down removes the switch';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'job_documents' AND column_name = 'scope_revision_id'),
    'down removes job_documents.scope_revision_id';
  ASSERT to_regclass('public.quote_send_sealed_revision_misses') IS NOT NULL, 'down keeps the recorded misses';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_quote_send_sealed_revision_misses_append_only'),
    'the kept misses stay append only';
END;
$$;
