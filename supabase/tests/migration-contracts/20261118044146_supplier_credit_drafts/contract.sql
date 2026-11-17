\set ON_ERROR_STOP on
\ir ../../../migrations/20261118044146_supplier_credit_drafts.sql
BEGIN;
SET LOCAL statement_timeout = '30s';
DO $contract$
DECLARE v_org uuid := '00000000-0000-4000-8000-000000000001'; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT FROM public.feature_flags WHERE flag_name='supplier_credit_drafts_v1' AND NOT enabled) THEN
    RAISE EXCEPTION 'new switch must be off';
  END IF;
  INSERT INTO public.supplier_credit_drafts(org_id,supplier_name,credit_number)
  VALUES(v_org,'ZZTEST supplier','CN-1001') RETURNING id INTO v_id;
  IF NOT EXISTS(SELECT FROM public.supplier_credit_drafts WHERE id=v_id
      AND amount_ex IS NULL AND amount_inc IS NULL AND state='proposed') THEN
    RAISE EXCEPTION 'unknown amounts must remain null';
  END IF;
  BEGIN
    INSERT INTO public.supplier_credit_drafts(org_id,supplier_name,credit_number)
    VALUES(v_org,'zztest SUPPLIER','CN-1001');
    RAISE EXCEPTION 'case-insensitive duplicate accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.supplier_credit_drafts(org_id,supplier_name,credit_number,state)
    VALUES(v_org,'ZZTEST supplier','CN-1002','drafted');
    RAISE EXCEPTION 'draft accepted without Xero identity';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.supplier_credit_drafts SET xero_credit_note_id='zztest-credit' WHERE id=v_id;
    RAISE EXCEPTION 'Xero identity accepted without drafted state';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- Corrected retry after the refusal succeeds and hand edits remain readable.
  INSERT INTO public.supplier_credit_drafts(org_id,supplier_name,credit_number,state,xero_credit_note_id,amount_inc)
  VALUES(v_org,'ZZTEST supplier','CN-1002','drafted','zztest-credit',220);
  UPDATE public.supplier_credit_drafts SET names_bill_number='INV-5002' WHERE id=v_id;
  IF (SELECT names_bill_number FROM public.supplier_credit_drafts WHERE id=v_id) <> 'INV-5002' THEN
    RAISE EXCEPTION 'office edit lost';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.supplier_credit_drafts'::regclass)
     OR EXISTS(SELECT FROM pg_policy WHERE polrelid='public.supplier_credit_drafts'::regclass)
     OR has_table_privilege('anon','public.supplier_credit_drafts','SELECT')
     OR has_table_privilege('authenticated','public.supplier_credit_drafts','INSERT')
     OR NOT has_table_privilege('service_role','public.supplier_credit_drafts','SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'private service-role-only table contract failed';
  END IF;
END $contract$;
ROLLBACK;
\echo PASS supplier_credit_drafts: duplicate, state, null money, corrected retry, office edit, private access, switch off
