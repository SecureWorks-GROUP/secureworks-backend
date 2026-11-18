-- Simulate a drifted reconcile_item_raise body before P4-01.6 runs.
CREATE OR REPLACE FUNCTION public.reconcile_item_raise(
  text, text, text, uuid[], jsonb, jsonb, text)
RETURNS uuid LANGUAGE plpgsql AS $drift$
/* block */ BEGIN
  RETURN NULL;
END $drift$;
