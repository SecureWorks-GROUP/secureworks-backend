-- EM1 rollback contract: F1b's stub is back byte for byte (so F1b's own
-- rollback recognises it), every EM1 object is gone, the T7 draft table is back as it was, inbox_events is its
-- legacy shape with RLS on, and the flag row is gone.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_email_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
  OR obj_description(to_regprocedure('public.context_email_capture_status()'),'pg_proc') NOT LIKE 'F1b stub.%'
 THEN RAISE EXCEPTION 'em1 rollback: F1b stub not restored'; END IF;
 IF has_function_privilege('anon','public.context_email_capture_status()','execute')
 THEN RAISE EXCEPTION 'em1 rollback: stub executable by anon'; END IF;
 IF to_regclass('public.monitored_mailbox_changes') IS NOT NULL
  OR to_regprocedure('public.set_monitored_mailbox(text,boolean,text,text,text)') IS NOT NULL
  OR to_regprocedure('public.context_email_capture_policy()') IS NOT NULL
  OR to_regprocedure('public.context_email_capture_status_at(timestamptz)') IS NOT NULL
 THEN RAISE EXCEPTION 'em1 rollback: an EM1 object survived'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.inbox_events'::regclass AND attname IN ('business_event_id','provider_message_id','folder_kind') AND NOT attisdropped)
 THEN RAISE EXCEPTION 'em1 rollback: sighting columns survived'; END IF;
 IF to_regclass('public.inbox_events') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.inbox_events'::regclass)
 THEN RAISE EXCEPTION 'em1 rollback: inbox_events lost or its RLS changed'; END IF;
 -- The T7 draft table, empty, exactly as production had it: its 17 columns
  -- (last_polled_at re-added last), draft checks, policies, grants and index,
 -- so the migration's own guard accepts it again.
 IF (SELECT string_agg(attname,',' ORDER BY attname) FROM pg_attribute WHERE attrelid='public.monitored_mailboxes'::regclass AND attnum>0 AND NOT attisdropped)
   IS DISTINCT FROM 'created_at,display_name,email,enabled,graph_app_credential_id,graph_subscription_id,id,last_error,last_error_at,last_message_at,last_polled_at,org_id,poll_interval_seconds,privacy_classification,scope_label,status,updated_at'
  OR EXISTS(SELECT 1 FROM public.monitored_mailboxes)
  OR (SELECT string_agg(policyname::text,',' ORDER BY policyname) FROM pg_policies WHERE schemaname='public' AND tablename='monitored_mailboxes') IS DISTINCT FROM 'authenticated_select,service_role_all'
  OR NOT has_table_privilege('authenticated','public.monitored_mailboxes','select')
  OR to_regclass('public.idx_monitored_mailboxes_enabled') IS NULL
  OR (SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef WHERE adrelid='public.monitored_mailboxes'::regclass
      AND adnum=(SELECT attnum FROM pg_attribute WHERE attrelid='public.monitored_mailboxes'::regclass AND attname='enabled'))<>'true'
 THEN RAISE EXCEPTION 'em1 rollback: the draft monitored_mailboxes was not restored'; END IF;
 BEGIN
  INSERT INTO public.monitored_mailboxes(email,scope_label) VALUES('x@secureworkswa.com.au','ses');
  RAISE EXCEPTION 'em1 rollback: the draft scope_label check was not restored';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_capture_v2') THEN RAISE EXCEPTION 'em1 rollback: flag row survived'; END IF;
 IF public.context_pipeline_status()->'email_capture' <> 'null'::jsonb THEN RAISE EXCEPTION 'em1 rollback: composer block not null'; END IF;
END $$;
