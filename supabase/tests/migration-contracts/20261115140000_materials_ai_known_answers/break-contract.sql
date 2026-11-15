-- Deliberately read the AI's first decision on a bill instead of its latest, so an old wrong answer stands after
-- the AI changed its mind. The contract must fail.
DO $$
DECLARE d text := pg_get_functiondef('public.materials_ai_known_answers()'::regprocedure);
BEGIN
  IF position('created_at DESC, p.id DESC' IN d) = 0 THEN
    RAISE EXCEPTION 'break: the latest-decision order was not found';
  END IF;
  EXECUTE replace(d, 'created_at DESC, p.id DESC', 'created_at, p.id');
END $$;
