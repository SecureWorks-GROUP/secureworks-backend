-- After the grades rollback (run on an empty table): the table and all five
-- functions are gone, and what it read is untouched: jobs, the ledger model's
-- tables with the store's nine kinds, and the store's item check.
DO $$
DECLARE f text; got text;
BEGIN
 IF to_regclass('public.context_grades') IS NOT NULL THEN RAISE EXCEPTION 'grades rollback: the table was left behind'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_item_kinds()', 'public.context_grade_verdicts_problem(text,text,jsonb)',
   'public.context_grade_passed(text,text,jsonb)', 'public.context_grade_samples(timestamptz)', 'public.context_grades_newest(timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'grades rollback: % was left behind', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.jobs', 'public.context_ledger_items', 'public.context_ledger_generations'] LOOP
  IF to_regclass(f) IS NULL THEN RAISE EXCEPTION 'grades rollback: % was lost', f; END IF;
 END LOOP;
 IF to_regprocedure('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)') IS NULL THEN
  RAISE EXCEPTION 'grades rollback: the store''s item check was lost';
 END IF;
 SELECT string_agg(m[1], ',' ORDER BY m[1] COLLATE "C") INTO got
 FROM pg_constraint c CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') AS m
 WHERE c.conrelid = 'public.context_ledger_items'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%item_type = ANY%';
 IF got IS DISTINCT FROM 'agreement,claim,commitment,constraint,dependency,event,issue,phase_note,request' THEN
  RAISE EXCEPTION 'grades rollback: the store''s kinds changed to %', got;
 END IF;
END $$;
