-- Deliberately read the AI's first decision on a bill instead of its latest, so an old wrong answer stands after
-- the AI changed its mind. The contract must fail.
DO $$
DECLARE d text := pg_get_viewdef('public.v_materials_ai_known_answers'::regclass);
BEGIN
  IF position('created_at DESC' IN d) = 0 THEN
    RAISE EXCEPTION 'break: the latest-decision order was not found';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_materials_ai_known_answers WITH (security_invoker = true) AS '
          || replace(replace(d, 'created_at DESC', 'created_at'), 'p.id DESC', 'p.id');
END $$;
