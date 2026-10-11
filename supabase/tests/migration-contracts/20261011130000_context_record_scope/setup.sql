-- Prerequisites for 20261011130000_context_record_scope. Every table, column and function the two new
-- bodies read comes from earlier registered setups and migrations: the job record (20261006011000),
-- the job story setup (job_documents party, run and trade-pack columns, jobs.pricing_json), story
-- safety (20261006040000, the timeline body replaced here) and the call budget (20261006060000, the
-- vision policy body replaced here). This checks they are there and that the two bodies it replaces
-- are the ones production runs; it adds nothing.
DO $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_record_timeline(uuid[],timestamptz)', '0921f25dfb5a67ab04629d2977e9f0a6'),
  ('public.context_document_vision_policy()', '160abaf805bacd50e6ee570385c67037')) v(sig, m) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(x.sig)) IS DISTINCT FROM x.m THEN
   RAISE EXCEPTION 'record scope setup: % is not the body production runs (md5 %)', x.sig, x.m;
  END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES ('job_documents', 'trade_pack_json'), ('job_documents', 'run_label'), ('job_documents', 'job_contact_id'),
   ('job_documents', 'superseded_at'), ('job_documents', 'accepted_at'), ('jobs', 'pricing_json')) v(t, c) LOOP
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = x.t AND column_name = x.c) THEN
   RAISE EXCEPTION 'record scope setup: %.% missing from the registered stack', x.t, x.c;
  END IF;
 END LOOP;
END $$;
