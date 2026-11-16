-- Rollback for 20261115140000_materials_ai_known_answers: drops the two read-only functions. Nothing else changed.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.materials_ai_accuracy_by_supplier();
DROP FUNCTION IF EXISTS public.materials_ai_known_answers();
