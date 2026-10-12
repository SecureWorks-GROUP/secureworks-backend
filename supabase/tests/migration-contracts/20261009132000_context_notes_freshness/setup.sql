-- Prerequisites for 20261009132000_context_notes_freshness. Every table, column and function the
-- new bodies read comes from earlier registered setups and migrations: the ledger model and store
-- (20261006010000, 20261006013000), the job story (20261006014000), story safety (20261006040000)
-- and the lead cutoff (20261007010000). This checks they are there and that the four bodies it
-- replaces are the ones production runs; it adds nothing.
DO $$
DECLARE f text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_judge(uuid[])', 'eb359d521397c8be161bfef6421a35c9'),
  ('public.context_ledger_due(integer)', 'b546910aafd7eed12660049e363cd587'),
  ('public.context_ledger_promote_shadow(text,uuid[],integer)', 'b79bea76d5ee2c72670ef7d950beaeb1'),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', '273c0612f9778905c18e86878402898f')) v(sig, m) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(x.sig)) IS DISTINCT FROM x.m THEN
   RAISE EXCEPTION 'notes freshness setup: % is not the body production runs (md5 %)', x.sig, x.m;
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_ledger_evidence_rows(uuid[],timestamptz)', 'public.context_ledger_claim(uuid,text,date)',
  'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)', 'public.context_ledger_promote(uuid,text)',
  'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', 'public.context_lead_monitored_jobs(uuid[],timestamptz)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'notes freshness setup: % missing from the registered stack', f; END IF;
 END LOOP;
END $$;
