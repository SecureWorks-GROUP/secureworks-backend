-- Rollback for 20261030010000_xero_supplier_credit_notes.sql (TP-07 slice 1).
-- Drops the placement view, the writer and both copy tables (a copy of Xero:
-- the next run with the flag on reads it back), and the flag row. Refuses an
-- object of the same name that the migration did not make; an absent one is
-- already rolled back. Nothing else reads these, so no money figure moves.

DO $down$
DECLARE
  problems text[] := '{}';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['xero_supplier_credit_notes', 'xero_supplier_credit_note_allocations', 'v_supplier_credit_placement'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND COALESCE(obj_description(to_regclass('public.' || t), 'pg_class'), '') NOT LIKE 'Supplier credit notes (20261030010000%' THEN
      problems := problems || ('public.' || t || ' is not 20261030010000''s');
    END IF;
  END LOOP;
  IF to_regprocedure('public.xero_supplier_credit_note_copy(uuid,jsonb,jsonb)') IS NOT NULL
     AND COALESCE(obj_description(to_regprocedure('public.xero_supplier_credit_note_copy(uuid,jsonb,jsonb)'), 'pg_proc'), '') NOT LIKE 'Supplier credit notes (20261030010000%' THEN
    problems := problems || 'public.xero_supplier_credit_note_copy is not 20261030010000''s'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'xero_supplier_credit_notes_down_preimage_mismatch: %', array_to_string(problems, '; ');
  END IF;
END
$down$;

DROP VIEW IF EXISTS public.v_supplier_credit_placement;
DROP FUNCTION IF EXISTS public.xero_supplier_credit_note_copy(uuid, jsonb, jsonb);
DROP TABLE IF EXISTS public.xero_supplier_credit_note_allocations;
DROP TABLE IF EXISTS public.xero_supplier_credit_notes;

DO $flag$
BEGIN
  IF to_regclass('public.feature_flags') IS NOT NULL THEN
    DELETE FROM public.feature_flags WHERE flag_name = 'xero_supplier_credit_notes_v1';
  END IF;
END
$flag$;
