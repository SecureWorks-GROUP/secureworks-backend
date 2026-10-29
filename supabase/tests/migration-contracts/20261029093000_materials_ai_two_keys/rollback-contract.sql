-- After the down: the five functions are 20261028173000's bodies byte for
-- byte, the held bill is left for a person, the keyed placement stays placed,
-- the view, helpers, columns and constraints are gone, and because two bills
-- two keys held are still open (the restored batch would read them again and
-- could place them on one key) the AI bill reader is off.
\set ON_ERROR_STOP on
DO $$
DECLARE x record; live text;
BEGIN
  FOR x IN SELECT * FROM (VALUES
    ('public.materials_ai_bill_batch(integer)', '0307862b6c8dcb905048b2fa54004fe3'),
    ('public.materials_ai_apply(uuid,text,jsonb)', 'c5e9cf83e42c718ef2a0e02aa04859b7'),
    ('public.materials_ai_second_check_due(integer)', '79f05c206f49019b5c8362cef2f05004'),
    ('public.materials_ai_record_second_check(uuid,jsonb)', 'fafe795a871710881f881d1863b64083'),
    ('public.materials_ai_status()', 'cbba1fe0ef404e5a6a363ba25175194b')) v(sig, md5) LOOP
    SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
    IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'rollback: % md5 %', x.sig, live; END IF;
  END LOOP;
  IF to_regprocedure('public.materials_ai_hard_keys(text,uuid)') IS NOT NULL
     OR to_regprocedure('public.materials_ai_placed_without_key_count()') IS NOT NULL
     OR to_regclass('public.v_materials_ai_placed_without_key') IS NOT NULL
     OR to_regclass('public.materials_ai_placements_held_uidx') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: two keys objects remain';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.materials_ai_placements'::regclass
              AND attname IN ('agreed_keys', 'key_evidence', 'held_at') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'rollback: columns remain';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.materials_ai_placements'::regclass
                            AND conname = 'materials_ai_placements_outcome_check')) LIKE '%held_for_check%' THEN
    RAISE EXCEPTION 'rollback: held_for_check still allowed';
  END IF;
  IF (SELECT outcome FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-RB-HELD') <> 'left_for_person'
     OR (SELECT second_check_status FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-RB-HELD') <> 'not_needed' THEN
    RAISE EXCEPTION 'rollback: held row not left for a person';
  END IF;
  IF (SELECT outcome FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-RB-KEYED') <> 'placed' THEN
    RAISE EXCEPTION 'rollback: keyed placement moved';
  END IF;
  IF (SELECT enabled FROM public.materials_ai_settings WHERE id)
     OR (SELECT updated_by FROM public.materials_ai_settings WHERE id) IS DISTINCT FROM 'rollback:20261029093000' THEN
    RAISE EXCEPTION 'rollback: the reader is still on with held bills open';
  END IF;
  IF (SELECT outcome FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-RB-DIS') <> 'left_for_person'
     OR (SELECT second_check_status FROM public.materials_ai_placements WHERE xero_invoice_id = 'TK-RB-DIS') <> 'disagreed' THEN
    RAISE EXCEPTION 'rollback: disagreed row changed';
  END IF;
  -- With the reader off, no call can be reserved, so nothing reads the held bills.
  IF public.materials_ai_reserve_call('place', 'test-model', 6) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: a call was reserved with the reader off';
  END IF;
  PERFORM public.materials_ai_status();
  PERFORM public.materials_ai_second_check_due(5);
END $$;
