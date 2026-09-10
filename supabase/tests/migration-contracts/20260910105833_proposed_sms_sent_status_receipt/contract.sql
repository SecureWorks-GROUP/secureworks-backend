BEGIN;
DO $$
DECLARE
  allowed_status text;
  invalid_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ai_proposed_actions
      WHERE proposal_id = '11111111-1111-4111-8111-111111111111'
        AND status = 'approved' AND action_payload = '{"fixture":"unchanged"}'::jsonb AND sent_at IS NULL) THEN
    RAISE EXCEPTION 'migration_must_preserve_existing_proposal';
  END IF;
  FOREACH allowed_status IN ARRAY ARRAY['pending','auto_approved','approved','rejected','expired','sent'] LOOP
    UPDATE public.ai_proposed_actions SET status = allowed_status
      WHERE proposal_id = '11111111-1111-4111-8111-111111111111';
  END LOOP;
  FOREACH invalid_status IN ARRAY ARRAY['processing','failed','delivered','','SENT'] LOOP
    BEGIN
      UPDATE public.ai_proposed_actions SET status = invalid_status;
      RAISE EXCEPTION 'unexpected_status_was_accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE public.ai_proposed_actions SET status = NULL;
    RAISE EXCEPTION 'null_status_was_accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.ai_proposed_actions'::regclass
        AND conname = 'ai_proposed_actions_status_check' AND convalidated) THEN
    RAISE EXCEPTION 'status_constraint_must_remain_validated';
  END IF;
END;
$$;
ROLLBACK;
