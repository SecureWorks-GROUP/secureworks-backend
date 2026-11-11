-- After the down: the original check is back and the new one is gone.
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_order_documents_saved_has_document'),
    'original check restored';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_order_documents_saved_has_time'),
    'new check removed';
  ASSERT to_regclass('public.dispatch_v2_order_documents') IS NOT NULL, 'table remains';
END $$;
