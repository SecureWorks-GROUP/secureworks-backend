-- P1-13.3 supplies the claim schema and due index. No production function is replaced here.
DO $$ BEGIN
 IF to_regclass('public.group_work_orders') IS NULL THEN
  RAISE EXCEPTION 'ZZTEST claim flow prerequisites missing';
 END IF;
END $$;
-- Optional phase-2 dependency is absent on main at this slice's base.
-- If supplied by a later migration, preserve it. The contract rolls its replacement back.
DO $setup$ BEGIN
 IF to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL THEN
  EXECUTE $ddl$CREATE FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)
   RETURNS uuid LANGUAGE plpgsql AS $body$ BEGIN
    INSERT INTO pg_temp.zztest_claim_items VALUES($1,$2,$3,$4,$5,$6,$7);
    RETURN gen_random_uuid();
   END $body$$ddl$;
 END IF;
END $setup$;
