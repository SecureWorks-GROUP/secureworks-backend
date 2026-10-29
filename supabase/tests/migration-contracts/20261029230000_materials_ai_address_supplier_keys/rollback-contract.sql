-- After the down: materials_ai_hard_keys is 20261029093000's body byte for
-- byte with that migration's comments on it, the agreed_keys and key_evidence
-- columns and the view; an audit row written with the new keys is kept; and a
-- second run of the down changes nothing.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.materials_ai_hard_keys(text,uuid)'))
     IS DISTINCT FROM '2ef85da40004fb45adc42ea2488e8947' THEN
    RAISE EXCEPTION 'rollback: materials_ai_hard_keys is not 20261029093000''s body';
  END IF;
  IF obj_description('public.materials_ai_hard_keys(text,uuid)'::regprocedure, 'pg_proc') NOT LIKE 'AI bill two keys (20261029093000): the hard clues%'
     OR obj_description('public.materials_ai_hard_keys(text,uuid)'::regprocedure, 'pg_proc') LIKE '%20261029230000%'
     OR col_description('public.materials_ai_placements'::regclass,
          (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.materials_ai_placements'::regclass AND attname = 'agreed_keys')) LIKE '%20261029230000%'
     OR col_description('public.materials_ai_placements'::regclass,
          (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.materials_ai_placements'::regclass AND attname = 'key_evidence')) LIKE '%20261029230000%'
     OR obj_description('public.v_materials_ai_placed_without_key'::regclass, 'pg_class') LIKE '%20261029230000%'
     OR obj_description('public.v_materials_ai_placed_without_key'::regclass, 'pg_class') NOT LIKE 'AI bill two keys (20261029093000)%' THEN
    RAISE EXCEPTION 'rollback: a comment was not restored';
  END IF;
  IF has_function_privilege('anon', 'public.materials_ai_hard_keys(text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.materials_ai_hard_keys(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback: grants';
  END IF;
  IF (SELECT agreed_keys FROM public.materials_ai_placements WHERE xero_invoice_id = 'AK-RB-KEYED')
     IS DISTINCT FROM ARRAY['ai_confidence', 'site_address', 'same_supplier'] THEN
    RAISE EXCEPTION 'rollback: an audit row with the new keys moved';
  END IF;
END $$;
\ir ../../../rollbacks/20261029230000_materials_ai_address_supplier_keys_down.sql
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.materials_ai_hard_keys(text,uuid)'))
     IS DISTINCT FROM '2ef85da40004fb45adc42ea2488e8947' THEN
    RAISE EXCEPTION 'rollback: a second down moved materials_ai_hard_keys';
  END IF;
END $$;
