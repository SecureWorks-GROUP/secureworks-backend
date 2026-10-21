-- After the down: the four bodies are the ones this migration replaced, word for word, and the
-- column, its check and the normaliser are gone.
DO $c$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', 'af976e59b8e6f35612d6383042d6e38e'),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', '6da1007ff2a6331219f4d98f85749ca7'),
  ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', '209d903df7a8732b4773dee0f0741593'),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', '09d28c282caf22c873f5673d7dd8073f')) v(sig, m) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.m THEN
   RAISE EXCEPTION 'person review rollback: % is %, want %', x.sig, live, x.m;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') LIKE '%(person review, 20261018120000)%' THEN
   RAISE EXCEPTION 'person review rollback: % keeps this migration''s comment', x.sig;
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_ledger_person_review(jsonb,timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'person review rollback: the normaliser is still there';
 END IF;
 IF to_regprocedure('public.context_ledger_person_review_ok(jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'person review rollback: the stored-shape check is still there';
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'context_ledger_items' AND column_name = 'person_review')
  OR EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'context_ledger_items_person_review_check'
               AND conrelid = 'public.context_ledger_items'::regclass) THEN
  RAISE EXCEPTION 'person review rollback: the column or its check is still there';
 END IF;
 IF to_regprocedure('public.context_ledger_person_review_guard()') IS NOT NULL THEN
  RAISE EXCEPTION 'person review rollback: the future-raised guard is still there';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger
            WHERE tgname = 'context_ledger_items_person_review_guard'
              AND tgrelid = 'public.context_ledger_items'::regclass AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'person review rollback: the person_review trigger is still there';
 END IF;
 IF to_regclass('public.context_ledger_person_review_archive') IS NULL THEN
  RAISE EXCEPTION 'person review rollback: the archive table is missing';
 END IF;
 IF has_table_privilege('anon', 'public.context_ledger_person_review_archive', 'SELECT')
  OR has_table_privilege('authenticated', 'public.context_ledger_person_review_archive', 'SELECT') THEN
  RAISE EXCEPTION 'person review rollback: the archive is readable by anon or authenticated';
 END IF;
 IF coalesce(obj_description('public.context_ledger_person_review_archive'::regclass, 'pg_class'), '')
    NOT LIKE '%(person review, 20261018120000)%' THEN
  RAISE EXCEPTION 'person review rollback: the archive comment is missing the marker';
 END IF;
END $c$;

-- A second down leaves the archive, including a row already in it.
INSERT INTO public.context_ledger_person_review_archive
 (item_id, job_id, generation_id, item_key, person_review)
VALUES ('8f000000-0000-4000-8000-000000000196', '8f000000-0000-4000-8000-000000000196',
 '8f000000-0000-4000-8000-000000000196', 'request:invoice:final:kept',
 '{"sentence":"kept","source_line_id":null,"reason":"claimed_closed_unverified","raised_at":"2026-10-10T01:00:00+00:00"}');
\ir ../../../rollbacks/20261019120000_context_ledger_person_review_down.sql
DO $c$
BEGIN
 IF (SELECT count(*) FROM public.context_ledger_person_review_archive
     WHERE item_id = '8f000000-0000-4000-8000-000000000196') <> 1 THEN
  RAISE EXCEPTION 'person review rollback: a second down did not keep the archived review';
 END IF;
 IF to_regclass('public.context_ledger_person_review_archive') IS NULL THEN
  RAISE EXCEPTION 'person review rollback: a second down dropped the archive';
 END IF;
END $c$;
