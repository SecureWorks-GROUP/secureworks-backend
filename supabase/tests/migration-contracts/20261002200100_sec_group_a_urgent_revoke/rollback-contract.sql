-- After the rollback both functions carry exactly the grants setup.sql gave
-- them (the pre-apply production state), and this migration's snapshot rows are gone.
DO $$
DECLARE
  v_sig text;
  v_fn regprocedure;
  v_got text;
  v_left bigint;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.send_outlook_email_b64(text,text,text,text,text,text,text)',
    'public.deliver_proposed_actions()'
  ]
  LOOP
    v_fn := to_regprocedure(v_sig);
    SELECT string_agg(e, ',' ORDER BY e COLLATE "C")
      INTO v_got
    FROM (
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
             || ':' || a.privilege_type AS e
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = v_fn AND a.grantee <> p.proowner
    ) entries;
    IF v_got IS DISTINCT FROM 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE' THEN
      RAISE EXCEPTION 'group A urgent rollback: % grants are %', v_sig, v_got;
    END IF;
    IF NOT has_function_privilege('anon', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent rollback: % not reopened to anon and authenticated', v_sig;
    END IF;
  END LOOP;
  -- The table is dropped once empty; if another migration's rows keep it,
  -- none of this migration's rows may remain.
  IF to_regclass('public.function_grant_snapshots') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.function_grant_snapshots WHERE migration = $1'
      INTO v_left USING '20261002200100';
    IF v_left > 0 THEN
      RAISE EXCEPTION 'group A urgent rollback: snapshot rows left behind';
    END IF;
  END IF;
END $$;
