-- PostgREST enables safe-update checks inside RPCs too. The split's temporary
-- rows are all positive by the preceding HAVING; retain the exact allocation.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
  v_old text := 'remainder = (v_pot_cents * points_micro) % v_total;';
  v_new text := 'remainder = (v_pot_cents * points_micro) % v_total
  WHERE points_micro > 0;';
BEGIN
  IF strpos(v_definition, v_new) > 0 THEN RETURN; END IF;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'group_split_safeupdate_source_changed';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;
