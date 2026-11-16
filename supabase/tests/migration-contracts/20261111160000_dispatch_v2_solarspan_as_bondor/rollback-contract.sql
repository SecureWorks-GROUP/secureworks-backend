-- Rollback contract for 20261111160000_dispatch_v2_solarspan_as_bondor: after
-- supabase/rollbacks/20261111160000_dispatch_v2_solarspan_as_bondor_down.sql the recognise-only column is gone, the
-- Solarspan entry is active again, Bondor's To and CC are as they were, and context_not_job_sender reads To and CC
-- only (no longer naming also_known_emails), still answers, keeps its grants and has its old comment back.

\set ON_ERROR_STOP on

DO $$
DECLARE r record; v_def text; got text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'dispatch_approved_supplier_emails'
               AND column_name = 'also_known_emails') THEN
    RAISE EXCEPTION 'Solarspan as Bondor rollback: also_known_emails is still there';
  END IF;
  IF NOT (SELECT active FROM public.dispatch_approved_supplier_emails WHERE id = '5b1a0000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'Solarspan as Bondor rollback: the Solarspan entry is not active again';
  END IF;
  SELECT to_emails, cc_emails, active INTO r FROM public.dispatch_approved_supplier_emails
  WHERE id = '5b1a0000-0000-4000-8000-000000000001';
  IF r.to_emails IS DISTINCT FROM ARRAY['wa@bondor.com.au']::text[] OR r.cc_emails IS DISTINCT FROM ARRAY[]::text[]
     OR NOT r.active THEN
    RAISE EXCEPTION 'Solarspan as Bondor rollback: Bondor''s entry changed (to %, cc %, active %)',
      r.to_emails, r.cc_emails, r.active;
  END IF;
  v_def := pg_get_functiondef('public.context_not_job_sender(public.business_events)'::regprocedure);
  IF position('also_known_emails' IN v_def) > 0
     OR position('unnest(s.to_emails || coalesce(s.cc_emails, ARRAY[]::text[])) a(x)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Solarspan as Bondor rollback: context_not_job_sender is not the To and CC read again';
  END IF;
  IF position('(20261111160000)' IN coalesce(obj_description(
       'public.context_not_job_sender(public.business_events)'::regprocedure, 'pg_proc'), '')) > 0 THEN
    RAISE EXCEPTION 'Solarspan as Bondor rollback: context_not_job_sender''s comment still names this migration';
  END IF;
  IF has_function_privilege('anon', 'public.context_not_job_sender(public.business_events)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_not_job_sender(public.business_events)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Solarspan as Bondor rollback: context_not_job_sender grants changed';
  END IF;
  -- The Solarspan entry is back, so a Solarspan sender is a supplier through it again.
  got := public.context_not_job_sender(jsonb_populate_record(NULL::public.business_events,
    '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"wasales@solarspan.com.au","subject":"Order received"}}'::jsonb))->>'reason';
  IF got IS DISTINCT FROM 'supplier_no_ref' THEN
    RAISE EXCEPTION 'Solarspan as Bondor rollback: a Solarspan sender is %, not supplier_no_ref', coalesce(got, 'null');
  END IF;
END $$;
