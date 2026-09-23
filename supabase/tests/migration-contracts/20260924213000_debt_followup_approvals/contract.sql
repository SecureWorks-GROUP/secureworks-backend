BEGIN;
DO $$
DECLARE
  prop jsonb := jsonb_build_object('contract','debt-followup-approval/v1','body_sha256',repeat('e',64));
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.debt_followup_approvals'::regclass) OR
     NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.debt_followup_executions'::regclass) THEN
    RAISE EXCEPTION 'debt follow-up ledgers require RLS';
  END IF;
  IF has_table_privilege('authenticated','public.debt_followup_approvals','SELECT') OR
     has_table_privilege('anon','public.debt_followup_executions','INSERT') OR
     has_table_privilege('service_role','public.debt_followup_approvals','UPDATE') OR
     has_table_privilege('service_role','public.debt_followup_approvals','DELETE') OR
     has_table_privilege('service_role','public.debt_followup_executions','DELETE') THEN
    RAISE EXCEPTION 'debt follow-up ledgers must be private, insert-only approvals, never deleted';
  END IF;
  IF NOT has_table_privilege('service_role','public.debt_followup_executions','SELECT,INSERT,UPDATE') OR
     NOT has_table_privilege('service_role','public.debt_followup_approvals','SELECT,INSERT') THEN
    RAISE EXCEPTION 'service adapter cannot record approvals and presses';
  END IF;

  INSERT INTO public.debt_followup_approvals
    (approval_id, binding_hash, contract, kind, channel, xero_invoice_ids, request, proposal,
     body_sha256, approved_by_email, approved_by_user_id, approved_at, expires_at)
  VALUES (repeat('a',64), repeat('b',64), 'debt-followup-approval/v1', 'chase_sms', 'sms',
     ARRAY['inv-1'], '{}'::jsonb, prop, repeat('e',64), 'captain@example.test',
     '706c5258-70dd-483a-b36c-af6864b24498', '2026-09-24T00:00Z', '2026-09-24T00:30Z');

  BEGIN
    INSERT INTO public.debt_followup_approvals
      (approval_id, binding_hash, contract, kind, channel, xero_invoice_ids, request, proposal,
       body_sha256, approved_by_email, approved_by_user_id, approved_at, expires_at)
    VALUES (repeat('c',64), repeat('b',64), 'debt-followup-approval/v1', 'chase_sms', 'sms',
       ARRAY['inv-1'], '{}'::jsonb, prop, repeat('f',64), 'captain@example.test',
       '706c5258-70dd-483a-b36c-af6864b24498', '2026-09-24T00:00Z', '2026-09-24T00:30Z');
    RAISE EXCEPTION 'approval whose body hash differs from its proposal was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE public.debt_followup_approvals SET expires_at = '2027-01-01T00:00Z' WHERE approval_id = repeat('a',64);
    RAISE EXCEPTION 'an approval was changed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%never changed or deleted%' THEN RAISE; END IF;
  END;

  -- Dry runs append freely, with or without an approval.
  INSERT INTO public.debt_followup_executions
    (approval_id, binding_hash, kind, channel, mode, outcome, reason, pressed_by, source_action, finished_at)
  VALUES (NULL, repeat('b',64), 'chase_sms', 'sms', 'dry_run', 'dry_run', 'approval_required', 'ops-api:api_key', 'send_chase_sms', now()),
         (repeat('a',64), repeat('b',64), 'chase_sms', 'sms', 'dry_run', 'dry_run', 'execute_switch_off', 'captain@example.test', 'debt_followup_execute', now()),
         (repeat('a',64), repeat('b',64), 'chase_sms', 'sms', 'dry_run', 'dry_run', 'execute_switch_off', 'captain@example.test', 'debt_followup_execute', now());

  BEGIN
    INSERT INTO public.debt_followup_executions
      (approval_id, binding_hash, kind, channel, mode, outcome, press_token, pressed_by, source_action)
    VALUES (NULL, repeat('b',64), 'chase_sms', 'sms', 'live', 'sending', gen_random_uuid(), 'captain@example.test', 'x');
    RAISE EXCEPTION 'live press without an approval was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO public.debt_followup_executions
      (approval_id, binding_hash, kind, channel, mode, outcome, pressed_by, source_action, finished_at)
    VALUES (repeat('a',64), repeat('b',64), 'chase_sms', 'sms', 'dry_run', 'sent', 'x', 'x', now());
    RAISE EXCEPTION 'dry run recorded as sent';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO public.debt_followup_executions
    (approval_id, binding_hash, kind, channel, mode, outcome, press_token, pressed_by, source_action)
  VALUES (repeat('a',64), repeat('b',64), 'chase_sms', 'sms', 'live', 'sending',
     '11111111-1111-4111-8111-111111111111', 'captain@example.test', 'debt_followup_execute');

  BEGIN
    INSERT INTO public.debt_followup_executions
      (approval_id, binding_hash, kind, channel, mode, outcome, press_token, pressed_by, source_action)
    VALUES (repeat('a',64), repeat('b',64), 'chase_sms', 'sms', 'live', 'sending',
       '22222222-2222-4222-8222-222222222222', 'captain@example.test', 'debt_followup_execute');
    RAISE EXCEPTION 'second live press on one approval was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    UPDATE public.debt_followup_executions
      SET outcome = 'sent', provider = 'ghl', provider_proof = '{}'::jsonb, finished_at = now()
      WHERE approval_id = repeat('a',64) AND mode = 'live';
    RAISE EXCEPTION 'SMS sent without a provider message id was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  UPDATE public.debt_followup_executions
    SET outcome = 'sent', provider = 'ghl', provider_message_id = 'msg-1',
        provider_proof = '{"message_id":"msg-1"}'::jsonb, finished_at = now()
    WHERE approval_id = repeat('a',64) AND mode = 'live' AND outcome = 'sending';

  BEGIN
    UPDATE public.debt_followup_executions SET outcome = 'unknown', provider_message_id = NULL
      WHERE approval_id = repeat('a',64) AND mode = 'live';
    RAISE EXCEPTION 'a settled send was changed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%settles once%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM public.debt_followup_executions WHERE mode = 'dry_run';
    RAISE EXCEPTION 'a press record was deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%never deleted%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
