DO $$
BEGIN
  ASSERT to_regclass('public.scope_job_draft_sets') IS NOT NULL, 'undo retains draft sets';
  ASSERT to_regclass('public.scope_job_draft_invoices') IS NOT NULL, 'undo retains local invoices';
  ASSERT to_regprocedure('public.prepare_scope_job_drafts(uuid,uuid,uuid)') IS NULL, 'undo removes prepare';
  ASSERT to_regprocedure('public.release_scope_job_drafts(uuid,uuid,boolean)') IS NULL, 'undo removes release';
  ASSERT NOT has_table_privilege('authenticated','public.scope_job_draft_invoices','SELECT'), 'undo keeps money private';
END $$;
