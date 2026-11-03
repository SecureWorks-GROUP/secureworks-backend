-- (notes due list, 3 Nov 2026) context_ledger_due took 28.1 s at 06:01Z (20.7 s at 03:25Z) against the
-- worker's 28 s limit, so every tick failed (context_ledger_due_failed) and the re-read stalled at 318
-- of 670 live jobs. Measured cause (EXPLAIN ANALYZE of the lifted bodies as generic plans, 06:08 to
-- 06:15Z): the old-inbox copy test
--   c.payload @> jsonb_build_object('inbox_events_id', <mail id>)
-- runs once per old-inbox mail as a correlated subplan on the GIN index idx_events_payload, and every
-- probe also reads the index's whole pending list (about 500 pages, 3.8 to 4.4 ms a probe; the list
-- grows with each insert until gin_pending_list_limit, so the cost climbs through the day):
--   context_job_record_legacy_mail (inlined into context_job_record_messages): the lead rule over the
--   907 live jobs 7.1 s, 6.5 s of it these probes (1,694 mails of 434 leads); the finished wake over
--   the 1,421 finished jobs 8.1 s, 7.7 s of it (1,741 mails of 109 candidates);
--   context_ledger_evidence_rows: the same probe in the judge's full evidence read (5.1 s of the
--   judge's 19.3 s; 4.3 s with the key lookup) and in context_ledger_due's freshness read.
-- Fix, the 20261103030000 pattern: the same test written as a key lookup, read by a partial btree.
-- Same answer: payload @> {"inbox_events_id": "<uuid>"} holds exactly when the top-level key
-- inbox_events_id is the JSON string "<uuid>", which is when payload ? 'inbox_events_id' and
-- payload ->> 'inbox_events_id' = '<uuid>' (a uuid's text is never the text of another JSON type, and
-- ->> of an array or scalar is null). The legacy mail test has no source_table condition, so it needs
-- an index over every row with the key (3,943 rows on 3 Nov: 3,940 inbox_events copies, 3 old-path);
-- the evidence read keeps its source_table IS NULL and is answered by business_events_inbox_events_id_ref.
-- Only the two tests (and the evidence read's comment on its test) change; everything else is byte for
-- byte the live definitions. Guard: each live definition must be the one this was written against.
-- Rehearsed on production in rolled-back transactions (3 Nov 06:20 to 06:28Z, old and new read in one
-- snapshot): context_ledger_due(20) 28.3 / 26.9 / 36.9 s before, 10.9 / 12.3 / 10.9 s after, the same
-- rows in the same order each time; context_ledger_due(200) the same 200 rows in order (28.6 s to
-- 11.5 s); context_ledger_judge over all 2,911 jobs the same rows (25.2 s to 11.5 s, 297 due); the
-- finished wake over the 1,421 finished jobs the same rows (9.5 s to 0.27 s, 32 awake). The index
-- built in 0.13 to 0.30 s (248 kB).
-- Rollback: supabase/rollbacks/20261103150000_context_record_mail_copy_key_fast_down.sql.

CREATE INDEX IF NOT EXISTS business_events_inbox_events_id_any_source
  ON public.business_events ((payload ->> 'inbox_events_id'))
  WHERE payload ? 'inbox_events_id';

DO $mig$
DECLARE
  v_def text;
  v_old1 text := $o$WHERE c.payload @> jsonb_build_object('inbox_events_id', x.id::text) AND$o$;
  v_new1 text := $n$WHERE c.payload ? 'inbox_events_id' AND c.payload ->> 'inbox_events_id' = x.id::text AND$n$;
  v_old2 text := $o$   -- An old-path copy names its inbox row only in the payload (containment, so
   -- the payload index answers it instead of a scan of every business_events row).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', c.id::text)
$o$;
  v_new2 text := $n$   -- An old-path copy names its inbox row only in the payload (a key lookup, so the
   -- partial index business_events_inbox_events_id_ref answers it, 20261103150000).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload ? 'inbox_events_id' AND b.payload ->> 'inbox_events_id' = c.id::text
$n$;
BEGIN
  -- context_job_record_legacy_mail: the copy test with no source table
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.oid = 'public.context_job_record_legacy_mail(uuid[],timestamp with time zone)'::regprocedure;
  IF md5(v_def) = '87e09520aecd31d4a8d9debde7d0aba4' THEN
    RAISE NOTICE 'context_job_record_legacy_mail already carries the key lookup';
  ELSIF md5(v_def) <> '3517767afcd634cfa8e022aff0ed04e9' THEN
    RAISE EXCEPTION 'context_job_record_legacy_mail is not the definition this migration was written against (md5 %)', md5(v_def);
  ELSIF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
    RAISE EXCEPTION 'context_job_record_legacy_mail: the inbox_events_id test is not there exactly once';
  ELSE
    EXECUTE replace(v_def, v_old1, v_new1);
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    WHERE p.oid = 'public.context_job_record_legacy_mail(uuid[],timestamp with time zone)'::regprocedure;
    IF md5(v_def) <> '87e09520aecd31d4a8d9debde7d0aba4' THEN
      RAISE EXCEPTION 'context_job_record_legacy_mail after the change is not the rehearsed definition (md5 %)', md5(v_def);
    END IF;
  END IF;

  -- context_ledger_evidence_rows: the old-path copy test (source_table IS NULL)
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.oid = 'public.context_ledger_evidence_rows(uuid[],timestamp with time zone)'::regprocedure;
  IF md5(v_def) = '33e59b23c7fe914ee8208cecd96a6c57' THEN
    RAISE NOTICE 'context_ledger_evidence_rows already carries the key lookup';
  ELSIF md5(v_def) <> 'cdcd2bbfbd6b3d120abf5a8774cab247' THEN
    RAISE EXCEPTION 'context_ledger_evidence_rows is not the definition this migration was written against (md5 %)', md5(v_def);
  ELSIF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_evidence_rows: the inbox_events_id test is not there exactly once';
  ELSE
    EXECUTE replace(v_def, v_old2, v_new2);
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    WHERE p.oid = 'public.context_ledger_evidence_rows(uuid[],timestamp with time zone)'::regprocedure;
    IF md5(v_def) <> '33e59b23c7fe914ee8208cecd96a6c57' THEN
      RAISE EXCEPTION 'context_ledger_evidence_rows after the change is not the rehearsed definition (md5 %)', md5(v_def);
    END IF;
  END IF;
END
$mig$;
