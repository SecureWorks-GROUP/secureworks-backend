DO $$
BEGIN
  ASSERT to_regprocedure('public.register_scope_payer_parties(uuid,uuid,uuid)') IS NULL, 'undo removes the registration function';
  ASSERT to_regprocedure('public.upsert_job_party(uuid,text,jsonb,text,uuid)') IS NOT NULL, 'undo keeps the one party writer';
END $$;
