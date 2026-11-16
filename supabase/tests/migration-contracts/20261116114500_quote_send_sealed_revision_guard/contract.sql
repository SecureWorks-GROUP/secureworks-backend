-- The switch is seeded off, the document records a revision of the same
-- database, and the miss log is append only, service role only, and refuses
-- anything that could carry customer details.
DO $$
BEGIN
  ASSERT (SELECT enabled FROM public.feature_flags WHERE flag_name = 'quote_send_sealed_revision_required_v1') = false,
    'the switch is seeded off';
  ASSERT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'job_documents' AND column_name = 'scope_revision_id' AND data_type = 'uuid'),
    'job_documents.scope_revision_id exists';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.quote_send_sealed_revision_misses'::regclass),
    'the miss log has row level security';
  ASSERT NOT has_table_privilege('anon', 'public.quote_send_sealed_revision_misses', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.quote_send_sealed_revision_misses', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.quote_send_sealed_revision_misses', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.quote_send_sealed_revision_misses', 'INSERT'),
    'browser roles cannot read or write the miss log';
  ASSERT has_table_privilege('service_role', 'public.quote_send_sealed_revision_misses', 'INSERT')
    AND has_table_privilege('service_role', 'public.quote_send_sealed_revision_misses', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.quote_send_sealed_revision_misses', 'UPDATE')
    AND NOT has_table_privilege('service_role', 'public.quote_send_sealed_revision_misses', 'DELETE'),
    'the service role may only insert and read';
END;
$$;

-- Re-apply is a no-op that keeps a switch someone turned on.
BEGIN;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_send_sealed_revision_required_v1';
\ir ../../../migrations/20261116114500_quote_send_sealed_revision_guard.sql
DO $$
BEGIN
  ASSERT (SELECT enabled FROM public.feature_flags WHERE flag_name = 'quote_send_sealed_revision_required_v1') = true,
    're-apply never turns the switch back off';
END;
$$;
ROLLBACK;

BEGIN;
INSERT INTO public.jobs (id) VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
INSERT INTO public.scope_revisions (id, job_id, revision_number, scope_hash, pricing_hash, status)
VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 1, repeat('a', 64), repeat('b', 64), 'frozen');
INSERT INTO public.job_documents (id, job_id, type, scope_revision_id)
VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001', 'quote', '00000000-0000-4000-8000-0000000000a1');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.job_documents (job_id, type, scope_revision_id)
    VALUES ('00000000-0000-4000-8000-000000000001', 'quote', '00000000-0000-4000-8000-0000000000ff');
    RAISE EXCEPTION 'contract: a document named a revision that does not exist';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  INSERT INTO public.quote_send_sealed_revision_misses
    (job_id, path, document_id, named_scope_revision_id, reason, switch_on, sender_mode, sender_user_id,
     caller_origin, caller_referer, body_keys)
  VALUES ('00000000-0000-4000-8000-000000000001', 'send', '00000000-0000-4000-8000-0000000000d1', NULL,
     'no_named_revision', false, 'jwt', '00000000-0000-4000-8000-0000000000c1',
     'https://example.test', 'https://example.test/fence.html', ARRAY['client_email', 'document_id']);

  BEGIN
    UPDATE public.quote_send_sealed_revision_misses SET switch_on = true;
    RAISE EXCEPTION 'contract: a miss row was updated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.quote_send_sealed_revision_misses;
    RAISE EXCEPTION 'contract: a miss row was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.quote_send_sealed_revision_misses (job_id, path, reason, switch_on, sender_mode)
    VALUES ('00000000-0000-4000-8000-000000000001', 'send', 'some_other_reason', false, 'jwt');
    RAISE EXCEPTION 'contract: an unknown reason was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.quote_send_sealed_revision_misses (job_id, path, reason, switch_on, sender_mode, caller_referer)
    VALUES ('00000000-0000-4000-8000-000000000001', 'send', 'no_named_revision', false, 'jwt',
      'https://example.test/view?token=abc');
    RAISE EXCEPTION 'contract: a referer with a query (a possible link token) was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.quote_send_sealed_revision_misses (job_id, path, reason, switch_on, sender_mode, body_keys)
    VALUES ('00000000-0000-4000-8000-000000000001', 'send', 'no_named_revision', false, 'jwt',
      ARRAY['someone@example.test']);
    RAISE EXCEPTION 'contract: a body value (an email) was stored as a key';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.quote_send_sealed_revision_misses (job_id, path, reason, switch_on, sender_mode)
    VALUES ('00000000-0000-4000-8000-000000000001', 'other', 'no_named_revision', false, 'jwt');
    RAISE EXCEPTION 'contract: an unknown path was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM public.quote_send_sealed_revision_misses) = 1, 'one miss row kept';
END;
$$;
ROLLBACK;
