BEGIN;
DO $$
DECLARE
  v_actor uuid := '00000000-0000-0000-0000-000000000061';
  v_field text;
  v_value text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_pay_settings WHERE repayment_account_code IS NOT NULL OR not_job_work_account_code IS NOT NULL) THEN
    RAISE EXCEPTION 'pay settings contract: new accounts must start empty';
  END IF;
  UPDATE public.trade_pay_settings SET pay_run_approver_user_ids = ARRAY[v_actor], tax_set_aside_percent = NULL WHERE id = 1;
  BEGIN
    PERFORM public.set_trade_pay_setting('tax_set_aside_percent', '20.00', '00000000-0000-0000-0000-000000000062');
    RAISE EXCEPTION 'pay settings contract: non-approver accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'pay_setting_not_approver' THEN RAISE; END IF;
  END;
  PERFORM public.set_trade_pay_setting('tax_set_aside_percent', '20.00', v_actor);
  IF (SELECT tax_set_aside_percent FROM public.trade_pay_settings WHERE id = 1) IS DISTINCT FROM 20.00
     OR (SELECT count(*) FROM public.trade_pay_settings_changes WHERE field = 'tax_set_aside_percent' AND from_value IS NULL AND to_value = '20.00' AND changed_by = v_actor) <> 1 THEN
    RAISE EXCEPTION 'pay settings contract: percent and audit do not agree';
  END IF;
  FOREACH v_value IN ARRAY ARRAY['61', '-1', '20.001', 'NaN', ''] LOOP
    BEGIN
      PERFORM public.set_trade_pay_setting('tax_set_aside_percent', v_value, v_actor);
      RAISE EXCEPTION 'pay settings contract: invalid percent accepted';
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM <> 'pay_setting_value_invalid' THEN RAISE; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.set_trade_pay_setting('inclusive_super_from', NULL, v_actor);
    RAISE EXCEPTION 'pay settings contract: start date accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'pay_setting_field_not_allowed' THEN RAISE; END IF;
  END;
  FOREACH v_field IN ARRAY ARRAY['reimbursement_account_code', 'repayment_account_code', 'not_job_work_account_code'] LOOP
    PERFORM public.set_trade_pay_setting(v_field, 'ZZTEST-ACCOUNT', v_actor);
    EXECUTE format('SELECT %I FROM public.trade_pay_settings WHERE id = 1', v_field) INTO v_value;
    IF v_value IS DISTINCT FROM 'ZZTEST-ACCOUNT' THEN RAISE EXCEPTION 'pay settings contract: account not stored'; END IF;
    PERFORM public.set_trade_pay_setting(v_field, NULL, v_actor);
    IF NOT EXISTS (SELECT 1 FROM public.trade_pay_settings_changes WHERE field = v_field AND from_value = 'ZZTEST-ACCOUNT' AND to_value IS NULL AND changed_by = v_actor) THEN
      RAISE EXCEPTION 'pay settings contract: account clear not audited';
    END IF;
  END LOOP;
  BEGIN
    PERFORM public.set_trade_pay_setting('repayment_account_code', repeat('Z', 21), v_actor);
    RAISE EXCEPTION 'pay settings contract: long account accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'pay_setting_value_invalid' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.trade_pay_settings_changes SET to_value = 'ZZTEST-EDIT';
    RAISE EXCEPTION 'pay settings contract: audit update accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'pay_setting_changes_append_only' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.trade_pay_settings_changes;
    RAISE EXCEPTION 'pay settings contract: audit delete accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'pay_setting_changes_append_only' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.trade_pay_settings_changes) <> 7 THEN
    RAISE EXCEPTION 'pay settings contract: rejected writes changed audit';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trade_pay_settings_changes'::regclass)
     OR has_table_privilege('service_role', 'public.trade_pay_settings', 'UPDATE')
     OR has_table_privilege('service_role', 'public.trade_pay_settings_changes', 'UPDATE,DELETE,TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.trade_pay_settings_changes', 'SELECT,INSERT')
     OR has_function_privilege('authenticated', 'public.set_trade_pay_setting(text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_trade_pay_setting(text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.set_trade_pay_setting(text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'pay settings contract: privileges widened';
  END IF;
END $$;
ROLLBACK;
