-- Prerequisites for 20261008090000_context_record_timeline_t1. Every table, column and function
-- the new timeline reads comes from earlier registered setups and migrations: jobs (with
-- ghl_contact_id, client_email, updated_at and archived), job_contacts (with phone_last9,
-- contact_type, is_primary and removed_at), job_assignments (with clocked_on_at), job_events,
-- business_events, xero_invoices, visit_outcomes, and the record and key helpers. This checks they
-- are there and that the timeline it replaces is the story safety (20261006040000) body production
-- runs; it adds nothing.
DO $$
DECLARE f text; t text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)'))
    IS DISTINCT FROM '0921f25dfb5a67ab04629d2977e9f0a6' THEN
  RAISE EXCEPTION 'record timeline T1 setup: the timeline is not the 20261006040000 body production runs';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_job_record_messages(uuid[],timestamptz)', 'public.context_job_record_bill_share(text,jsonb,text)',
  'public.context_job_record_date(text)', 'public.job_quote_values(uuid)', 'public.context_email_key(text)', 'public.context_phone_key(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'record timeline T1 setup: % missing from the registered stack', f; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs.ghl_contact_id', 'jobs.client_email', 'jobs.updated_at', 'jobs.archived', 'job_contacts.phone_last9',
  'job_contacts.contact_type', 'job_contacts.is_primary', 'job_contacts.removed_at', 'job_contacts.client_phone',
  'job_assignments.clocked_on_at', 'job_assignments.completed_at', 'job_assignments.started_at', 'visit_outcomes.visit_start'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   RAISE EXCEPTION 'record timeline T1 setup: public.% missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
