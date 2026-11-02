-- A live guard body this repo has not seen: the migration must refuse to
-- overwrite it.
CREATE OR REPLACE FUNCTION public.scope_revisions_controlled_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
