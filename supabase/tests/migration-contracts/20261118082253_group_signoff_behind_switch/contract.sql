-- P1-13.2: with the sign-off switch off (or its row missing) a group freezes,
-- a share line binds and a release reads ready without a customer signature.
-- With the switch on, every refusal is main's group_client_signoff_counts.
-- The first check is the break target.
BEGIN;
\ir fixture.sql
DO $$
DECLARE fn text; body text; /* block */ BEGIN
  FOREACH fn IN ARRAY ARRAY['public.group_work_order_write_split(uuid,boolean)',
    'public.trade_invoice_lines_group_share_snapshot()','public.group_work_order_release_state(uuid)'] LOOP
    SELECT p.prosrc INTO body FROM pg_proc p WHERE p.oid = fn::regprocedure;
    IF (length(body) - length(replace(body,'public.group_client_signoff_gate_passes(','')))
         / length('public.group_client_signoff_gate_passes(') <> 1
       OR strpos(body,'group_client_signoff_counts(') > 0 THEN
      RAISE EXCEPTION 'P1-13.2: % does not read the switch-aware gate', fn;
    END IF;
  END LOOP;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.group_client_signoff_counts(uuid)'::regprocedure)
       IS DISTINCT FROM '7a756ebcdbdbefa195177e43761bb45c' THEN
    RAISE EXCEPTION 'P1-13.2: group_client_signoff_counts changed';
  END IF;
  IF has_function_privilege('anon','public.group_client_signoff_gate_passes(uuid)','execute')
     OR has_function_privilege('authenticated','public.group_client_signoff_gate_passes(uuid)','execute')
     OR NOT has_function_privilege('service_role','public.group_client_signoff_gate_passes(uuid)','execute')
     OR (SELECT prosecdef FROM pg_proc WHERE oid='public.group_client_signoff_gate_passes(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'P1-13.2: gate access changed';
  END IF;
END $$;

DO $$
DECLARE
  g1 record; g2 record; g3 record; g4 record;
  state jsonb; refused text; inv uuid;
/* block */ BEGIN
  PERFORM pg_temp.zztest_p1132_users();
  g1 := pg_temp.zztest_p1132_group(1);
  g2 := pg_temp.zztest_p1132_group(2);
  g3 := pg_temp.zztest_p1132_group(3);
  g4 := pg_temp.zztest_p1132_group(4);

  -- Switch off: no signature, the split freezes, a share line binds and the
  -- release does not wait for a sign-off.
  PERFORM pg_temp.zztest_p1132_switch(false);
  IF public.group_client_signoff_counts(g1.job) THEN
    RAISE EXCEPTION 'P1-13.2: fixture already has a counting sign-off';
  END IF;
  refused := NULL;
  BEGIN PERFORM public.freeze_group_work_order_split(g1.grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS NOT NULL THEN
    RAISE EXCEPTION 'P1-13.2: switch off freeze refused: %', refused;
  END IF;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id=g1.grp) IS NULL THEN
    RAISE EXCEPTION 'P1-13.2: switch off freeze left no marker';
  END IF;
  state := public.group_work_order_release_state(g1.grp);
  IF state->'reasons' ? 'signoff_not_current' THEN
    RAISE EXCEPTION 'P1-13.2: switch off release waits for a sign-off: %', state->'reasons';
  END IF;
  inv := pg_temp.zztest_p1132_share_line(g1.job, 1);
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv AND group_share_id IS NOT NULL) THEN
    RAISE EXCEPTION 'P1-13.2: switch off share line was not bound';
  END IF;

  -- Switch on: the same frozen group now waits for a sign-off, as on main.
  PERFORM pg_temp.zztest_p1132_switch(true);
  state := public.group_work_order_release_state(g1.grp);
  IF NOT (state->'reasons' ? 'signoff_not_current') THEN
    RAISE EXCEPTION 'P1-13.2: switch on release did not wait for a sign-off: %', state->'reasons';
  END IF;
  refused := NULL;
  BEGIN PERFORM pg_temp.zztest_p1132_share_line(g1.job, 2);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_client_signoff_required' THEN
    RAISE EXCEPTION 'P1-13.2: switch on share line without sign-off said %', refused;
  END IF;

  -- Switch on: no signature refuses the freeze and writes nothing; the retry
  -- after a drawn happy sign-off newer than the hours freezes.
  refused := NULL;
  BEGIN PERFORM public.freeze_group_work_order_split(g2.grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_client_signoff_required' THEN
    RAISE EXCEPTION 'P1-13.2: switch on freeze without sign-off said %', refused;
  END IF;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id=g2.grp) IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.group_work_order_shares WHERE group_id=g2.grp) THEN
    RAISE EXCEPTION 'P1-13.2: refused freeze wrote shares';
  END IF;
  PERFORM pg_temp.zztest_p1132_drawn(g2.job);
  refused := NULL;
  BEGIN PERFORM public.freeze_group_work_order_split(g2.grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS NOT NULL OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id=g2.grp) IS NULL THEN
    RAISE EXCEPTION 'P1-13.2: switch on freeze after a drawn sign-off refused: %', refused;
  END IF;

  -- Switch on: a reasoned office waiver on a new freeze still refuses (main's
  -- rule, director ruling B).
  INSERT INTO public.job_client_signoffs(job_id,method,waiver_reason,captured_by_actor,created_at)
    VALUES(g3.job,'office_waiver','ZZTEST office waived','user:f1132000-0000-4000-8000-000000000001',clock_timestamp()+interval '1 day');
  refused := NULL;
  BEGIN PERFORM public.freeze_group_work_order_split(g3.grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_client_signoff_required' THEN
    RAISE EXCEPTION 'P1-13.2: switch on office waiver freeze said %', refused;
  END IF;

  -- A missing switch row is the switch off.
  DELETE FROM public.feature_flags WHERE flag_name='trade_invoice_requires_client_signoff_v1';
  IF NOT public.group_client_signoff_gate_passes(g4.job) THEN
    RAISE EXCEPTION 'P1-13.2: a missing switch row gated the group';
  END IF;
  refused := NULL;
  BEGIN PERFORM public.freeze_group_work_order_split(g4.grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS NOT NULL THEN
    RAISE EXCEPTION 'P1-13.2: missing switch row freeze refused: %', refused;
  END IF;
END $$;
SELECT 'PASS P1-13.2: group sign-off behind the switch' AS result;
ROLLBACK;
