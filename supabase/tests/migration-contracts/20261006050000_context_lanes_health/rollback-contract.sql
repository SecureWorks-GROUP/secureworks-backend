-- After the rollback: the five pre-image bodies byte for byte with their
-- comments, EM2's six-status check and table comment, no error_code, the
-- grants as before.
DO $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_source_freshness_policy()','455f0ec0a3f6c60477a68044db10a448'),
  ('public.context_source_freshness()','b12cdb949edd17fbf636990c45c6345d'),
  ('public.context_email_capture_status_at(timestamptz)','78aefd4a54766e3e4967373e46fb934a'),
  ('public.context_ghl_capture_policy()','4deabf30725e64f01f5778d2e853c344'),
  ('public.context_ghl_capture_status()','ecdec7c3bc7f09cb3ea23d35ac096cd2')
 ) AS t(sig,want) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=x.sig::regprocedure)<>x.want THEN RAISE EXCEPTION 'lanes rollback body %',x.sig; END IF;
  IF has_function_privilege('anon',x.sig,'EXECUTE') OR has_function_privilege('authenticated',x.sig,'EXECUTE')
   OR NOT has_function_privilege('service_role',x.sig,'EXECUTE')
  THEN RAISE EXCEPTION 'lanes rollback grants %',x.sig; END IF;
 END LOOP;
 IF obj_description('public.context_source_freshness()'::regprocedure,'pg_proc') NOT LIKE '%Retired sources (transcribe-call) never alarm;%'
  OR obj_description('public.context_email_capture_status_at(timestamptz)'::regprocedure,'pg_proc')
     <>'context_email_capture_status() judged at p_now (null = now()). For tests and diagnosis; same output shape.'
  OR obj_description('public.context_ghl_capture_status()'::regprocedure,'pg_proc') LIKE '%doorbell%'
  OR obj_description('public.context_source_freshness_policy()'::regprocedure,'pg_proc') IS NOT NULL
  OR obj_description('public.context_ghl_capture_policy()'::regprocedure,'pg_proc') IS NOT NULL
  OR obj_description('public.context_email_attachments'::regclass,'pg_class') LIKE '%failed%'
 THEN RAISE EXCEPTION 'lanes rollback comments'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_email_attachments'::regclass AND attname='error_code' AND NOT attisdropped)
  OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_email_attachments'::regclass AND conname='context_email_attachments_failed_code')
  OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.context_email_attachments'::regclass
     AND conname='context_email_attachments_status_check'))
     <>'CHECK ((status = ANY (ARRAY[''stored''::text, ''skipped_inline''::text, ''skipped_kind''::text, ''skipped_too_large''::text, ''skipped_message_cap''::text, ''skipped_scope''::text])))'
 THEN RAISE EXCEPTION 'lanes rollback ledger shape'; END IF;
 IF NOT has_table_privilege('service_role','public.context_email_attachments','SELECT,INSERT')
  OR has_table_privilege('anon','public.context_email_attachments','SELECT')
 THEN RAISE EXCEPTION 'lanes rollback ledger access'; END IF;
END $$;

-- The rollback refuses while the ledger holds a failure row (it holds no file;
-- it is removed deliberately first) and changes nothing: run it against a
-- re-applied migration with one failed row, inside a savepoint.
BEGIN;
\ir ../../../migrations/20261006050000_context_lanes_health.sql
INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,error_code)
 VALUES('email:lanes-3@x.example',repeat('e',64),'failed','graph_403');
SAVEPOINT lanes_down;
\echo 'lanes health: the errors below are the rollback refusing, as it must'
\set ON_ERROR_STOP 0
\ir ../../../rollbacks/20261006050000_context_lanes_health_down.sql
\set ON_ERROR_STOP 1
\if :ERROR
\else
SELECT 'lanes rollback ran over a failed ledger row'::text::integer;
\endif
ROLLBACK TO SAVEPOINT lanes_down;
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ghl_capture_status()'::regprocedure)<>'07f8cd44cb45d0325577659559e83fc3'
  OR (SELECT error_code FROM public.context_email_attachments WHERE provider_message_id='email:lanes-3@x.example')<>'graph_403'
 THEN RAISE EXCEPTION 'lanes refused rollback changed something'; END IF;
END $$;
ROLLBACK;
