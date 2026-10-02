-- Group A is closed to the public key: every overload of every Group A name
-- refuses anon and authenticated, the 28 functions this migration closed
-- still run for service_role and postgres (pg_cron), a postgres-owned definer
-- chain still reaches them, a trigger on a revoked trigger function still
-- fires for a signed-in writer, and the pre-apply ACLs were snapshotted.

CREATE TEMP TABLE group_a_revoked(sig text PRIMARY KEY) ON COMMIT PRESERVE ROWS;
INSERT INTO group_a_revoked VALUES
  ('public.send_outlook_email_b64(text,text,text,text,text,text,text)'),
  ('public.deliver_proposed_actions()'),
  ('public.batch_compute_intelligence()'),
  ('public.check_response(bigint)'),
  ('public.claim_sms_slot(text,text,uuid)'),
  ('public.claim_payment_link_slot(uuid)'),
  ('public.generate_smart_nudges()'),
  ('public.convert_nudges_to_actions()'),
  ('public.mark_overdue_commitments()'),
  ('public.expire_stale_confirmations()'),
  ('public.commit_ses_invoice_void_revision_v1(uuid,uuid,uuid,text,uuid,text,text,text,text,text)'),
  ('public.approve_ses_invoice_void_revision_v1(uuid,text,text)'),
  ('public.begin_ses_invoice_void_execution_v1(uuid,text)'),
  ('public.confirm_ses_invoice_void_execution_v1(uuid,text,text,jsonb,text)'),
  ('public.seal_makesafe_job_v1(uuid,text)'),
  ('public.seal_makesafe_child_job_v1()'),
  ('public.seal_makesafe_case_jobs_v1()'),
  ('public.refresh_makesafe_status_shadow(jsonb)'),
  ('public.enqueue_ses_report_trigger_run()'),
  ('public.get_job_financials(uuid)'),
  ('public.check_authority(uuid,text,text,text)'),
  ('public.count_intentions_today(uuid,uuid,text)'),
  ('public.is_flag_enabled(uuid,text)'),
  ('public.is_shadow_mode(uuid,text)'),
  ('public.find_or_create_entity(uuid,text,text)'),
  ('public.get_entity_memory(uuid)'),
  ('public.search_entities(uuid,text,text,integer)'),
  ('public.get_recent_corrections(uuid,integer)');
GRANT SELECT ON group_a_revoked TO anon, authenticated, service_role;

-- A NULL-argument call of a function, for probing privilege.
CREATE FUNCTION pg_temp.group_a_call_sql(p_fn regprocedure) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format('SELECT %s(%s)', p.oid::regproc,
    coalesce((SELECT string_agg(format('NULL::%s', format_type(t.typ, NULL)), ', ' ORDER BY t.ord)
              FROM unnest(p.proargtypes) WITH ORDINALITY AS t(typ, ord)), ''))
  FROM pg_proc p WHERE p.oid = p_fn
$$;
GRANT EXECUTE ON FUNCTION pg_temp.group_a_call_sql(regprocedure) TO anon, authenticated, service_role;

-- 1. Catalog: every Group A name is closed; the revoked 28 keep service_role
--    and postgres, carry no PUBLIC grant, and were snapshotted.
DO $$
DECLARE
  v_sig text;
  v_fn regprocedure;
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing FROM group_a_revoked WHERE to_regprocedure(sig) IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'group A contract: % revoked functions were dropped', v_missing;
  END IF;
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND (p.oid IN (SELECT to_regprocedure(sig) FROM group_a_revoked)
           OR p.proname IN ('_sw_service_key', 'sw_service_key', 'process_outbound_queue',
             'send_ghl_email', 'send_ghl_sms', 'send_outlook_email', 'trigger_batch_intelligence',
             'trigger_daily_digest', 'trigger_generate_nudges', 'trigger_monitor_inbox'))
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A contract: anon can still execute %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A contract: authenticated can still execute %', v_fn;
    END IF;
  END LOOP;
  FOR v_sig IN SELECT sig FROM group_a_revoked LOOP
    v_fn := to_regprocedure(v_sig);
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'group A contract: PUBLIC still holds execute on %', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A contract: service_role lost execute on %', v_fn;
    END IF;
    IF NOT has_function_privilege('postgres', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A contract: postgres lost execute on %', v_fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.function_grant_snapshots s
      WHERE s.migration = '20261002200000' AND to_regprocedure(s.signature) = v_fn
        AND EXISTS (SELECT 1 FROM aclexplode(s.proacl) a
                    WHERE a.grantee = 'anon'::regrole AND a.privilege_type = 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'group A contract: no pre-apply snapshot for %', v_fn;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.function_grant_snapshots', 'SELECT')
     OR has_table_privilege('authenticated', 'public.function_grant_snapshots', 'SELECT') THEN
    RAISE EXCEPTION 'group A contract: the grant snapshot table is readable by the public key';
  END IF;
  IF (SELECT count(*) FROM group_a_revoked r
      JOIN pg_proc p ON p.oid = to_regprocedure(r.sig)
      WHERE p.prorettype = 'trigger'::regtype) <> 3 THEN
    RAISE EXCEPTION 'group A contract: expected exactly three trigger functions in the revoked set';
  END IF;
END $$;

-- 2. Real calls: anon and authenticated are refused on every callable
--    function (trigger functions cannot be called directly by anyone).
BEGIN;
SET LOCAL ROLE anon;
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM group_a_revoked r JOIN pg_proc p ON p.oid = to_regprocedure(r.sig)
    WHERE p.prorettype <> 'trigger'::regtype
  LOOP
    BEGIN
      EXECUTE pg_temp.group_a_call_sql(v_fn);
      RAISE EXCEPTION 'group A contract: anon call of % was not refused', v_fn;
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE 'permission denied for function%' THEN
        RAISE EXCEPTION 'group A contract: anon call of % refused for another reason: %', v_fn, SQLERRM;
      END IF;
    END;
  END LOOP;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM group_a_revoked r JOIN pg_proc p ON p.oid = to_regprocedure(r.sig)
    WHERE p.prorettype <> 'trigger'::regtype
  LOOP
    BEGIN
      EXECUTE pg_temp.group_a_call_sql(v_fn);
      RAISE EXCEPTION 'group A contract: authenticated call of % was not refused', v_fn;
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE 'permission denied for function%' THEN
        RAISE EXCEPTION 'group A contract: authenticated call of % refused for another reason: %', v_fn, SQLERRM;
      END IF;
    END;
  END LOOP;
END $$;
ROLLBACK;

-- 3. service_role (ops-api, Jarvis) and postgres (pg_cron) still get past the
--    function privilege check on every callable function. A real body may
--    still refuse NULL input on its own terms; only a function-permission
--    refusal fails here.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM group_a_revoked r JOIN pg_proc p ON p.oid = to_regprocedure(r.sig)
    WHERE p.prorettype <> 'trigger'::regtype
  LOOP
    BEGIN
      EXECUTE pg_temp.group_a_call_sql(v_fn);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'permission denied for function%' THEN
        RAISE EXCEPTION 'group A contract: service_role refused on %: %', v_fn, SQLERRM;
      END IF;
    END;
  END LOOP;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM group_a_revoked r JOIN pg_proc p ON p.oid = to_regprocedure(r.sig)
    WHERE p.prorettype <> 'trigger'::regtype
  LOOP
    BEGIN
      EXECUTE pg_temp.group_a_call_sql(v_fn);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'permission denied for function%' THEN
        RAISE EXCEPTION 'group A contract: postgres refused on %: %', v_fn, SQLERRM;
      END IF;
    END;
  END LOOP;
END $$;
ROLLBACK;

-- 4. A postgres-owned SECURITY DEFINER chain reaches a revoked function when
--    its caller is service_role, because the inner call runs as the owner.
BEGIN;
CREATE FUNCTION public.group_a_contract_chain() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER AS $$ SELECT public.get_entity_memory(NULL::uuid) $$;
REVOKE ALL ON FUNCTION public.group_a_contract_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.group_a_contract_chain() TO service_role;
SET LOCAL ROLE service_role;
SELECT public.group_a_contract_chain();
ROLLBACK;

-- 5. A trigger whose function lost EXECUTE for anon and authenticated still
--    fires for a signed-in writer: EXECUTE is checked when a trigger is
--    created, never when it fires. Same grants as the three revoked trigger
--    functions.
BEGIN;
CREATE TABLE public.group_a_contract_trigger_rows (id int);
CREATE TABLE public.group_a_contract_trigger_fired (id int);
CREATE FUNCTION public.group_a_contract_trigger_fn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN INSERT INTO public.group_a_contract_trigger_fired VALUES (NEW.id); RETURN NEW; END $$;
CREATE TRIGGER group_a_contract_trigger AFTER INSERT ON public.group_a_contract_trigger_rows
  FOR EACH ROW EXECUTE FUNCTION public.group_a_contract_trigger_fn();
REVOKE EXECUTE ON FUNCTION public.group_a_contract_trigger_fn() FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.group_a_contract_trigger_rows TO authenticated;
SET LOCAL ROLE authenticated;
INSERT INTO public.group_a_contract_trigger_rows VALUES (7);
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.group_a_contract_trigger_fired WHERE id = 7) THEN
    RAISE EXCEPTION 'group A contract: trigger on a revoked trigger function did not fire for authenticated';
  END IF;
END $$;
ROLLBACK;

DROP TABLE group_a_revoked;
