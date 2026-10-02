-- After the rollback every one of the 28 functions carries exactly the grants
-- setup.sql gave it (the 2 Oct production state, PUBLIC included or not), the
-- already-closed names stay closed, and this migration's snapshot rows are gone.
DO $$
DECLARE
  r record;
  v_got text;
  v_want text;
  v_left bigint;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.proowner
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('send_outlook_email_b64', 'deliver_proposed_actions', 'batch_compute_intelligence',
        'check_response', 'claim_sms_slot', 'claim_payment_link_slot', 'generate_smart_nudges',
        'convert_nudges_to_actions', 'mark_overdue_commitments', 'expire_stale_confirmations',
        'commit_ses_invoice_void_revision_v1', 'approve_ses_invoice_void_revision_v1',
        'begin_ses_invoice_void_execution_v1', 'confirm_ses_invoice_void_execution_v1',
        'seal_makesafe_job_v1', 'seal_makesafe_child_job_v1', 'seal_makesafe_case_jobs_v1',
        'refresh_makesafe_status_shadow', 'enqueue_ses_report_trigger_run', 'get_job_financials',
        'check_authority', 'count_intentions_today', 'is_flag_enabled', 'is_shadow_mode',
        'find_or_create_entity', 'get_entity_memory', 'search_entities', 'get_recent_corrections')
  LOOP
    SELECT string_agg(e, ',' ORDER BY e COLLATE "C") INTO v_got
    FROM (
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
             || ':' || a.privilege_type AS e
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = r.fn AND a.grantee <> r.proowner
    ) entries;
    v_want := CASE
      WHEN r.fn::text ~ '^(commit|approve|begin|confirm)_ses_invoice_void_|^seal_makesafe_job_v1\(|^refresh_makesafe_status_shadow\('
        THEN 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE'
      ELSE 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE'
    END;
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'group A rollback: % grants are %, expected %', r.fn, v_got, v_want;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public._sw_service_key()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sw_service_key()', 'EXECUTE') THEN
    RAISE EXCEPTION 'group A rollback: reopened a service-key function it never closed';
  END IF;

  -- The table is dropped once empty; if another migration's rows keep it,
  -- none of this migration's rows may remain.
  IF to_regclass('public.function_grant_snapshots') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.function_grant_snapshots WHERE migration = $1'
      INTO v_left USING '20261002200000';
    IF v_left > 0 THEN
      RAISE EXCEPTION 'group A rollback: snapshot rows left behind';
    END IF;
  END IF;
END $$;
