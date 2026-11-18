SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Hold both tables through the emptiness checks and the drop.
DO $$
DECLARE
  target regclass;
  has_rows boolean;
BEGIN
  FOREACH target IN ARRAY ARRAY[to_regclass('public.division_tieout_cells'),
                                to_regclass('public.division_tieout_exceptions')] LOOP
    IF target IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', target);
      EXECUTE format('SELECT EXISTS (SELECT FROM %s)', target) INTO has_rows;
      IF has_rows THEN RAISE EXCEPTION 'division_tieout_in_use'; END IF;
    END IF;
  END LOOP;
  DROP TABLE IF EXISTS public.division_tieout_cells, public.division_tieout_exceptions;
END $$;
