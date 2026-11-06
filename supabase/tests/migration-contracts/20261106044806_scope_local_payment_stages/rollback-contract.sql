DO $$ BEGIN
  ASSERT to_regclass('public.scope_payment_plans') IS NOT NULL, 'undo retains sealed stage plans';
  ASSERT to_regclass('public.scope_payment_stage_drafts') IS NOT NULL, 'undo retains payment children';
  ASSERT to_regclass('public.scope_payment_signals') IS NOT NULL, 'undo retains pending event evidence';
  ASSERT to_regprocedure('public.consume_scope_council_payment_event(uuid,text)') IS NULL, 'undo removes council consumer';
  ASSERT NOT has_table_privilege('authenticated','public.scope_payment_stage_drafts','SELECT'), 'undo keeps money private';
END $$;
