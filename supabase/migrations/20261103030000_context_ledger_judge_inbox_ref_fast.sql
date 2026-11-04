-- (notes due list, 3 Nov 2026) context_ledger_due timed out again from 3 Nov ~00:50Z (68 s against the
-- worker's 30 s), so the notes reader read nothing. Measured cause: inside context_ledger_judge's
-- `moved` check, one test per old-inbox citation,
--   x.source_table IS NULL AND x.payload @> jsonb_build_object('inbox_events_id', m.id::text)
-- runs as a correlated subplan whose value the planner cannot see, so it chose a sequential scan of
-- business_events (271,248 rows, 0.44 s) for every citation: 65 loops, about 29 s over the open jobs.
-- With a constant the same test uses idx_events_payload in 6 ms.
-- Fix: the same test written as a key lookup, with a partial index the planner can prove and use.
-- Same answer: payload @> {"inbox_events_id": "<uuid>"} holds exactly when the top-level key
-- inbox_events_id is the JSON string "<uuid>", which is when payload ? 'inbox_events_id' and
-- payload ->> 'inbox_events_id' = '<uuid>' (a uuid's text is never the text of another JSON type).
-- Only the judge's text at that one place changes; everything else is byte for byte the live one.
-- Guard: the live judge must be the definition this was written against (md5 8582c0f9...).
-- Rollback: supabase/rollbacks/20261103030000_context_ledger_judge_inbox_ref_fast_down.sql.

CREATE INDEX IF NOT EXISTS business_events_inbox_events_id_ref
  ON public.business_events ((payload ->> 'inbox_events_id'))
  WHERE source_table IS NULL AND payload ? 'inbox_events_id';

DO $mig$
DECLARE
  v_def text;
  v_old text := $o$AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table IS NULL
                               AND x.payload @> jsonb_build_object('inbox_events_id', m.id::text)$o$;
  v_new text := $n$AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table IS NULL
                               AND x.payload ? 'inbox_events_id' AND x.payload ->> 'inbox_events_id' = m.id::text$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.proname = 'context_ledger_judge' AND p.pronamespace = 'public'::regnamespace;
  IF md5(v_def) = '4b8ea581f9a98351aa5a651a5fc950fd' THEN
    RAISE NOTICE 'context_ledger_judge already carries the key lookup';
    RETURN;
  END IF;
  IF md5(v_def) <> '8582c0f95af3865b18ba57423a1f16e8' THEN
    RAISE EXCEPTION 'context_ledger_judge is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_judge: the inbox_events_id test is not there exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.proname = 'context_ledger_judge' AND p.pronamespace = 'public'::regnamespace;
  IF md5(v_def) <> '4b8ea581f9a98351aa5a651a5fc950fd' THEN
    RAISE EXCEPTION 'context_ledger_judge after the change is not the rehearsed definition (md5 %)', md5(v_def);
  END IF;
END
$mig$;
