-- Rollback for 20261115140000_materials_ai_known_answers: drops the two read-only views. Nothing else changed.
SET LOCAL lock_timeout = '5s';
DROP VIEW IF EXISTS public.v_materials_ai_accuracy_by_supplier;
DROP VIEW IF EXISTS public.v_materials_ai_known_answers;
