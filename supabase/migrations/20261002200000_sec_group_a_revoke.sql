-- Close Group A to the public key: the definer functions that no screen, app,
-- edge function or agent calls with the anon key or a signed-in session.
--
-- A read-only production check on 2 Oct 2026 found the 28 signatures below
-- still executable by anon and authenticated (all SECURITY DEFINER). They
-- include an email sender (send_outlook_email_b64), the Telegram proposal
-- dispatcher, the paid batch intelligence trigger, the SES invoice void chain,
-- the SES money seal, a job's profit and loss read, and old Jarvis memory
-- helpers that return customer data. Every caller found runs as the owner
-- (pg_cron jobs, all run as postgres; definer chains; triggers) or with the
-- service role (ops-api, the Jarvis runtime). Callers per function are in the
-- merge request that adds this file.
--
-- The other ten Group A names (_sw_service_key, sw_service_key,
-- process_outbound_queue, send_ghl_email, send_ghl_sms, both send_outlook_email
-- overloads and the four trigger_* wrappers) were already closed to anon and
-- authenticated on 2 Oct. This migration does not change their grants; the
-- post-check holds them closed.
--
-- Privileges only. No function is dropped and no body is touched.
--   * Before changing anything it snapshots each function's current ACL into
--     public.function_grant_snapshots, so the rollback restores the exact
--     pre-apply grants instead of guessing them.
--   * EXECUTE is revoked from PUBLIC, anon and authenticated.
--   * EXECUTE is granted explicitly to service_role and postgres, so neither
--     loses a grant it held only through PUBLIC.
--   * The post-check, by name so an unlisted overload cannot slip through,
--     fails the whole apply if anon or authenticated can still execute any
--     overload of any Group A name, or if service_role or postgres lost
--     EXECUTE on a function this file revoked.
--
-- Revoking EXECUTE on the three trigger functions does not stop their
-- triggers: Postgres checks EXECUTE on a trigger function only when the
-- trigger is created, not when it fires.
--
-- A signature absent from the database (fresh migration-only provisioning) is
-- skipped with a NOTICE. Rollback, only on the owner's word:
-- supabase/rollbacks/20261002200000_sec_group_a_revoke_down.sql.

CREATE TABLE IF NOT EXISTS public.function_grant_snapshots (
  migration text NOT NULL,
  signature text NOT NULL,
  owner_name text NOT NULL,
  proacl aclitem[],
  taken_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration, signature)
);
COMMENT ON TABLE public.function_grant_snapshots IS
  'Pre-apply EXECUTE ACLs of functions whose grants a security migration narrowed, keyed by migration version, so its rollback restores the exact prior grants. Owner and service_role only.';
ALTER TABLE public.function_grant_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.function_grant_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.function_grant_snapshots TO service_role;

DO $group_a_revoke$
DECLARE
  v_sig text;
  v_fn regprocedure;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    -- sends and network triggers
    'public.send_outlook_email_b64(text,text,text,text,text,text,text)',
    'public.deliver_proposed_actions()',
    'public.batch_compute_intelligence()',
    'public.check_response(bigint)',
    -- send and payment-link rate-limit slots
    'public.claim_sms_slot(text,text,uuid)',
    'public.claim_payment_link_slot(uuid)',
    -- scheduled writers (pg_cron)
    'public.generate_smart_nudges()',
    'public.convert_nudges_to_actions()',
    'public.mark_overdue_commitments()',
    'public.expire_stale_confirmations()',
    -- money: SES invoice void chain and the SES money seal
    'public.commit_ses_invoice_void_revision_v1(uuid,uuid,uuid,text,uuid,text,text,text,text,text)',
    'public.approve_ses_invoice_void_revision_v1(uuid,text,text)',
    'public.begin_ses_invoice_void_execution_v1(uuid,text)',
    'public.confirm_ses_invoice_void_execution_v1(uuid,text,text,jsonb,text)',
    'public.seal_makesafe_job_v1(uuid,text)',
    'public.seal_makesafe_child_job_v1()',
    'public.seal_makesafe_case_jobs_v1()',
    -- server-only writers and reads (ops-api, service role)
    'public.refresh_makesafe_status_shadow(jsonb)',
    'public.enqueue_ses_report_trigger_run()',
    'public.get_job_financials(uuid)',
    -- old Jarvis memory and authority helpers (service role, mostly dead code)
    'public.check_authority(uuid,text,text,text)',
    'public.count_intentions_today(uuid,uuid,text)',
    'public.is_flag_enabled(uuid,text)',
    'public.is_shadow_mode(uuid,text)',
    'public.find_or_create_entity(uuid,text,text)',
    'public.get_entity_memory(uuid)',
    'public.search_entities(uuid,text,text,integer)',
    'public.get_recent_corrections(uuid,integer)'
  ]
  LOOP
    v_fn := to_regprocedure(v_sig);
    IF v_fn IS NULL THEN
      RAISE NOTICE 'group A revoke: % not present, skipped', v_sig;
      CONTINUE;
    END IF;
    INSERT INTO public.function_grant_snapshots (migration, signature, owner_name, proacl)
    SELECT '20261002200000', v_sig, p.proowner::regrole::text, p.proacl
    FROM pg_proc p
    WHERE p.oid = v_fn
    ON CONFLICT (migration, signature) DO NOTHING;
    RAISE NOTICE 'group A revoke: % proacl before = %',
      v_fn, (SELECT proacl FROM pg_proc WHERE oid = v_fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres', v_fn);
  END LOOP;
END
$group_a_revoke$;

DO $group_a_post_check$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        -- revoked by this file
        'send_outlook_email_b64', 'deliver_proposed_actions', 'batch_compute_intelligence',
        'check_response', 'claim_sms_slot', 'claim_payment_link_slot',
        'generate_smart_nudges', 'convert_nudges_to_actions', 'mark_overdue_commitments',
        'expire_stale_confirmations',
        'commit_ses_invoice_void_revision_v1', 'approve_ses_invoice_void_revision_v1',
        'begin_ses_invoice_void_execution_v1', 'confirm_ses_invoice_void_execution_v1',
        'seal_makesafe_job_v1', 'seal_makesafe_child_job_v1', 'seal_makesafe_case_jobs_v1',
        'refresh_makesafe_status_shadow', 'enqueue_ses_report_trigger_run', 'get_job_financials',
        'check_authority', 'count_intentions_today', 'is_flag_enabled', 'is_shadow_mode',
        'find_or_create_entity', 'get_entity_memory', 'search_entities', 'get_recent_corrections',
        -- already closed on 2 Oct; must stay closed
        '_sw_service_key', 'sw_service_key', 'process_outbound_queue', 'send_ghl_email',
        'send_ghl_sms', 'send_outlook_email', 'trigger_batch_intelligence',
        'trigger_daily_digest', 'trigger_generate_nudges', 'trigger_monitor_inbox')
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A post-check: anon can still execute %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A post-check: authenticated can still execute %', v_fn;
    END IF;
  END LOOP;

  FOR v_fn IN
    SELECT to_regprocedure(s.signature)
    FROM public.function_grant_snapshots s
    WHERE s.migration = '20261002200000' AND to_regprocedure(s.signature) IS NOT NULL
  LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A post-check: service_role lost execute on %', v_fn;
    END IF;
    IF NOT has_function_privilege('postgres', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A post-check: postgres (pg_cron) lost execute on %', v_fn;
    END IF;
  END LOOP;
END
$group_a_post_check$;
