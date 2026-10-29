-- Prerequisites for 20261029230000_materials_ai_address_supplier_keys. The AI
-- bill reader (20261028173000), two keys (20261029093000), the B0 address rule
-- (20260924183000) and the job picture (20261029200000) build everything this
-- reads. This adds nothing; it fails closed if one of them is gone.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.materials_ai_hard_keys(text,uuid)', 'public.materials_ai_apply(uuid,text,jsonb)',
                           'public.context_address_key(text)', 'public.context_address_mentions(text)',
                           'public.context_job_picture(uuid[],text[],text[])'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'address and supplier keys setup: % missing from the registered stack', f;
    END IF;
  END LOOP;
END $$;
