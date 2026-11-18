-- After the rollback each caller is main's body again, the gate is gone, and
-- with the switch off a group without a signature is refused as on main.
BEGIN;
\ir fixture.sql
DO $$
DECLARE g record; refused text; /* block */ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.group_work_order_write_split(uuid,boolean)'::regprocedure)
       IS DISTINCT FROM '49c6e1a2f1c06a608f650734295da85b'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trade_invoice_lines_group_share_snapshot()'::regprocedure)
       IS DISTINCT FROM 'ed7d8968a07b481d2f05721b08985edc'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.group_work_order_release_state(uuid)'::regprocedure)
       IS DISTINCT FROM 'e3439e346dd94d76fee489af7a9d755c'
     OR to_regprocedure('public.group_client_signoff_gate_passes(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'P1-13.2 rollback did not restore main';
  END IF;
  PERFORM pg_temp.zztest_p1132_users();
  g := pg_temp.zztest_p1132_group(1);
  PERFORM pg_temp.zztest_p1132_switch(false);
  BEGIN PERFORM public.freeze_group_work_order_split(g.grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_client_signoff_required' THEN
    RAISE EXCEPTION 'P1-13.2 rollback: switch off freeze said %', refused;
  END IF;
END $$;
SELECT 'PASS P1-13.2 rollback: main sign-off rule restored' AS result;
ROLLBACK;
