BEGIN;
\ir ../../../migrations/20261118114119_supplier_credit_drafts.sql

DO $$
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'supplier_credit_drafts_v1')
      IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'supplier_credit_switch_not_off';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.supplier_credit_drafts'::regclass)
      OR EXISTS (SELECT FROM pg_policy WHERE polrelid = 'public.supplier_credit_drafts'::regclass)
      OR has_table_privilege('anon', 'public.supplier_credit_drafts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege('authenticated', 'public.supplier_credit_drafts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege('service_role', 'public.supplier_credit_drafts', 'DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'supplier_credit_privileges_incorrect';
  END IF;
END $$;

UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'supplier_credit_drafts_v1';
SET LOCAL ROLE service_role;
DO $$
DECLARE
  tenant uuid := gen_random_uuid();
  refused_amount numeric;
  draft public.supplier_credit_drafts%ROWTYPE;
BEGIN
  INSERT INTO public.supplier_credit_drafts (org_id, supplier_name, credit_number)
  VALUES (tenant, 'Supplier', 'CN-1') RETURNING * INTO draft;
  IF draft.amount_ex IS NOT NULL OR draft.amount_inc IS NOT NULL OR draft.state <> 'proposed'
      OR draft.match_reasons <> '[]'::jsonb THEN
    RAISE EXCEPTION 'supplier_credit_defaults_incorrect';
  END IF;
  FOREACH refused_amount IN ARRAY ARRAY[0, -0.01, 'NaN'::numeric] LOOP
    BEGIN
      UPDATE public.supplier_credit_drafts SET amount_ex = refused_amount WHERE id = draft.id;
      RAISE EXCEPTION 'supplier_credit_invalid_amount_ex_accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.supplier_credit_drafts SET amount_inc = refused_amount WHERE id = draft.id;
      RAISE EXCEPTION 'supplier_credit_invalid_amount_inc_accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  UPDATE public.supplier_credit_drafts SET amount_ex = 0.01, amount_inc = 0.01 WHERE id = draft.id;
  BEGIN
    INSERT INTO public.supplier_credit_drafts (org_id, supplier_name, credit_number)
    VALUES (tenant, 'SUPPLIER', 'CN-1');
    RAISE EXCEPTION 'supplier_credit_duplicate_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.supplier_credit_drafts (org_id, supplier_name, credit_number)
  VALUES (gen_random_uuid(), 'SUPPLIER', 'CN-1');
  BEGIN
    UPDATE public.supplier_credit_drafts SET state = 'drafted' WHERE id = draft.id;
    RAISE EXCEPTION 'supplier_credit_missing_xero_id_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.supplier_credit_drafts SET xero_credit_note_id = 'ZZTEST' WHERE id = draft.id;
    RAISE EXCEPTION 'supplier_credit_unexpected_xero_id_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.supplier_credit_drafts SET state = 'drafted', xero_credit_note_id = 'ZZTEST'
    WHERE id = draft.id AND state = 'proposed';
  IF NOT FOUND THEN RAISE EXCEPTION 'supplier_credit_corrected_retry_failed'; END IF;
END $$;
RESET ROLE;
\ir ../../../migrations/20261118114119_supplier_credit_drafts.sql
DO $$
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'supplier_credit_drafts_v1')
      IS DISTINCT FROM true OR NOT EXISTS (SELECT FROM public.supplier_credit_drafts
        WHERE state = 'drafted' AND xero_credit_note_id = 'ZZTEST') THEN
    RAISE EXCEPTION 'supplier_credit_reapply_changed_state';
  END IF;
END $$;
ROLLBACK;
