-- Pre-migration state for 20261002200000_sec_group_a_revoke, matching the
-- 2 Oct 2026 read-only production check.
--   * The 28 open Group A signatures: SECURITY DEFINER, owned by the
--     migrating role, EXECUTE held by anon, authenticated and service_role;
--     PUBLIC too, except the four SES void functions, seal_makesafe_job_v1
--     and refresh_makesafe_status_shadow, whose migrations revoked PUBLIC only.
--   * The ten already-closed Group A names: closed to PUBLIC, anon and
--     authenticated, service_role kept.
-- A signature that an earlier registered case already created keeps its real
-- body; only absent ones get a stand-in that records the call and never
-- reaches the network.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.group_a_contract_calls (
  id bigserial PRIMARY KEY,
  fn text NOT NULL,
  called_as text NOT NULL DEFAULT current_user,
  session_role text NOT NULL DEFAULT session_user
);
REVOKE ALL ON TABLE public.group_a_contract_calls FROM PUBLIC, anon, authenticated, service_role;

DO $do$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('send_outlook_email_b64', 'p_to text, p_subject text, p_html_body text, p_attachment_b64 text, p_attachment_name text, p_from text, p_cc text', 'uuid'),
      ('deliver_proposed_actions', '', 'integer'),
      ('batch_compute_intelligence', '', 'integer'),
      ('check_response', 'p_request_id bigint', 'jsonb'),
      ('claim_sms_slot', 'p_contact_id text, p_message text, p_job_id uuid', 'boolean'),
      ('claim_payment_link_slot', 'p_job_id uuid', 'boolean'),
      ('generate_smart_nudges', '', 'integer'),
      ('convert_nudges_to_actions', '', 'integer'),
      ('mark_overdue_commitments', '', 'integer'),
      ('expire_stale_confirmations', '', 'integer'),
      ('commit_ses_invoice_void_revision_v1', 'p_id uuid, p_org_id uuid, p_job_id uuid, p_xero_invoice_id text, p_invoice_obligation_revision_id uuid, p_observed_status text, p_target_status text, p_reason text, p_content_hash text, p_created_by text', 'jsonb'),
      ('approve_ses_invoice_void_revision_v1', 'p_void_revision_id uuid, p_content_hash text, p_decided_by text', 'jsonb'),
      ('begin_ses_invoice_void_execution_v1', 'p_void_revision_id uuid, p_content_hash text', 'jsonb'),
      ('confirm_ses_invoice_void_execution_v1', 'p_void_revision_id uuid, p_content_hash text, p_final_status text, p_provider_digest jsonb, p_actor text', 'jsonb'),
      ('seal_makesafe_job_v1', 'p_job_id uuid, p_source text', 'void'),
      ('seal_makesafe_child_job_v1', '', 'trigger'),
      ('seal_makesafe_case_jobs_v1', '', 'trigger'),
      ('refresh_makesafe_status_shadow', 'p_rows jsonb', 'integer'),
      ('enqueue_ses_report_trigger_run', '', 'trigger'),
      ('get_job_financials', 'p_job_id uuid', 'jsonb'),
      ('check_authority', 'p_org_id uuid, p_role text, p_channel text, p_action text', 'jsonb'),
      ('count_intentions_today', 'p_org_id uuid, p_user_id uuid, p_action text', 'integer'),
      ('is_flag_enabled', 'p_org_id uuid, p_flag_key text', 'boolean'),
      ('is_shadow_mode', 'p_org_id uuid, p_flag_key text', 'boolean'),
      ('find_or_create_entity', 'p_org_id uuid, p_entity_type text, p_name text', 'uuid'),
      ('get_entity_memory', 'p_entity_id uuid', 'jsonb'),
      ('search_entities', 'p_org_id uuid, p_query text, p_entity_type text, p_limit integer', 'jsonb'),
      ('get_recent_corrections', 'p_org_id uuid, p_limit integer', 'jsonb'),
      -- already closed on 2 Oct
      ('_sw_service_key', '', 'text'),
      ('sw_service_key', '', 'text'),
      ('process_outbound_queue', '', 'integer'),
      ('send_ghl_email', 'p_contact_id text, p_subject text, p_html_body text, p_job_id uuid', 'uuid'),
      ('send_ghl_sms', 'p_contact_id text, p_message text, p_job_id uuid', 'uuid'),
      ('send_outlook_email', 'p_to text, p_subject text, p_html_body text, p_from text, p_cc text, p_attachment_url text, p_attachment_name text', 'uuid'),
      ('send_outlook_email', 'p_from_email text, p_to_email text, p_subject text, p_html_body text, p_cc text, p_attachment_urls jsonb', 'uuid'),
      ('trigger_batch_intelligence', '', 'void'),
      ('trigger_daily_digest', '', 'void'),
      ('trigger_generate_nudges', '', 'void'),
      ('trigger_monitor_inbox', '', 'void')
    ) AS t(name, args, rettype)
  LOOP
    IF to_regprocedure(format('public.%I(%s)', v.name,
         regexp_replace(v.args, '(^|, )p_\w+ ', '\1', 'g'))) IS NOT NULL THEN
      CONTINUE;
    END IF;
    IF v.rettype = 'trigger' THEN
      EXECUTE format($f$CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $b$
        BEGIN INSERT INTO public.group_a_contract_calls (fn) VALUES (%L); RETURN NEW; END $b$$f$, v.name, v.name);
    ELSIF v.rettype = 'void' THEN
      EXECUTE format($f$CREATE FUNCTION public.%I(%s) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $b$
        BEGIN INSERT INTO public.group_a_contract_calls (fn) VALUES (%L); END $b$$f$, v.name, v.args, v.name);
    ELSE
      EXECUTE format($f$CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER AS $b$
        BEGIN INSERT INTO public.group_a_contract_calls (fn) VALUES (%L); RETURN NULL; END $b$$f$,
        v.name, v.args, v.rettype, v.name);
    END IF;
  END LOOP;
END $do$;
-- Grants as found on 2 Oct.
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
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
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_fn);
    IF v_fn::text ~ '^(commit|approve|begin|confirm)_ses_invoice_void_|^seal_makesafe_job_v1\(|^refresh_makesafe_status_shadow\(' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', v_fn);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated, service_role', v_fn);
    END IF;
  END LOOP;

  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('_sw_service_key', 'sw_service_key', 'process_outbound_queue',
        'send_ghl_email', 'send_ghl_sms', 'send_outlook_email', 'trigger_batch_intelligence',
        'trigger_daily_digest', 'trigger_generate_nudges', 'trigger_monitor_inbox')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END $$;
