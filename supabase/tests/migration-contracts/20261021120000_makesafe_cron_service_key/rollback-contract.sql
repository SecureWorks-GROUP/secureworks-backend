-- After the down migration both triggers read vault.decrypted_secrets raw again,
-- as production held them before 20261021120000, keep the gate, and stay closed
-- to the browser roles.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.prosrc
      FROM pg_proc p
     WHERE p.oid IN (to_regprocedure('public.trigger_makesafe_reconcile(text)'),
                     to_regprocedure('public.trigger_makesafe_status_canary()'))
  LOOP
    IF position('FROM vault.decrypted_secrets' in f.prosrc) = 0
       OR position('sw_service_key' in f.prosrc) > 0 THEN
      RAISE EXCEPTION 'rollback: % was not restored to the vault read', f.sig;
    END IF;
    IF position('IF NOT public.makesafe_cron_enabled() THEN' in f.prosrc) = 0 THEN
      RAISE EXCEPTION 'rollback: % lost the makesafe_cron_enabled() gate', f.sig;
    END IF;
    IF has_function_privilege('anon', f.sig::oid, 'EXECUTE')
       OR has_function_privilege('authenticated', f.sig::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'rollback: % is executable by anon or authenticated', f.sig;
    END IF;
  END LOOP;
END $$;
