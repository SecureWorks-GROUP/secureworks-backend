-- Prerequisites for 20261007150000_context_ledger_reader_fixes. Every table, column and
-- function the new reads take comes from earlier registered setups and migrations: the ledger
-- store (20261006013000) and story safety (20261006040000) bodies it builds on, business_events
-- with contact_id and provider_message_id, jobs, inbox_events, job_documents, quote_revisions,
-- xero_invoices with line_items and reference, makesafe_job_details and the placement keys
-- (context_job_ref_tokens, context_ref_jobs). This checks they are there and that the four bodies
-- it replaces are the ones production runs (the 20261006013000 bodies); it adds nothing.
DO $$
DECLARE f text; t text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_call_customer(public.business_events)', '23f31463321396e3e5fde6329e32c60e'),
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', '52bd1db9fb4b75fedd6cbfc755e806b3'),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', '7afbf2bbe6d5688219e743fda88b5eb2'),
  ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', '86bed4277fb61ce4679e5cd476001555')) v(sig, m) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(x.sig)) IS DISTINCT FROM x.m THEN
   RAISE EXCEPTION 'ledger reader fixes setup: % is not the 20261006013000 body production runs (md5 %)', x.sig, x.m;
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_ledger_cite(uuid,jsonb)', 'public.context_ledger_evidence_rows(uuid[],timestamptz)',
  'public.context_job_ref_tokens(text)', 'public.context_ref_jobs(text[])', 'public.context_email_key(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'ledger reader fixes setup: % missing from the registered stack', f; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['quote_revisions.job_document_id', 'quote_revisions.totals_snapshot_json', 'makesafe_job_details.external_ref',
  'makesafe_job_details.requesting_company_slug', 'xero_invoices.line_items', 'xero_invoices.reference', 'business_events.contact_id'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   RAISE EXCEPTION 'ledger reader fixes setup: public.% missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
