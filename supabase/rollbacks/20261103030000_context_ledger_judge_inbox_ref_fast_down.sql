-- Undo 20261103030000_context_ledger_judge_inbox_ref_fast: put the judge's old-inbox test back to the
-- containment form (md5 8582c0f95af3865b18ba57423a1f16e8) and drop the partial index.
-- Note: the old form made context_ledger_due take about 68 s on 3 Nov, so the notes reader stops again.
DO $down$
DECLARE
  v_def text;
  v_new text := $n$AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table IS NULL
                               AND x.payload ? 'inbox_events_id' AND x.payload ->> 'inbox_events_id' = m.id::text$n$;
  v_old text := $o$AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table IS NULL
                               AND x.payload @> jsonb_build_object('inbox_events_id', m.id::text)$o$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.proname = 'context_ledger_judge' AND p.pronamespace = 'public'::regnamespace;
  IF md5(v_def) <> '4b8ea581f9a98351aa5a651a5fc950fd' THEN
    RAISE EXCEPTION 'context_ledger_judge is not the 20261103030000 definition (md5 %)', md5(v_def);
  END IF;
  EXECUTE replace(v_def, v_new, v_old);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.proname = 'context_ledger_judge' AND p.pronamespace = 'public'::regnamespace;
  IF md5(v_def) <> '8582c0f95af3865b18ba57423a1f16e8' THEN
    RAISE EXCEPTION 'context_ledger_judge after undo is not the old definition (md5 %)', md5(v_def);
  END IF;
END
$down$;
DROP INDEX IF EXISTS public.business_events_inbox_events_id_ref;
