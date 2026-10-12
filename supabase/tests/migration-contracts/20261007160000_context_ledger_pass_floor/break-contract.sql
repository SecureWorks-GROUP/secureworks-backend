-- Deliberately put back the verdict production runs before this migration: the 20261006013000 20% line,
-- everything else (the comment above it, the function comment, grants, attributes) as this migration
-- left it. A 6-item reading with 3 of the reader's own refusals fails whole again; contract.sql must
-- fail on it.
DO $b$
DECLARE d text;
BEGIN
 d := pg_get_functiondef('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure);
 IF position('v_pass := (v_local + v_ref) <= 0.5 * v_den AND v_ref <= 0.5 * (v_acc + v_ref);' IN d) = 0 THEN
  RAISE EXCEPTION 'break: the half rule is not in the live body';
 END IF;
 EXECUTE replace(d, 'v_pass := (v_local + v_ref) <= 0.5 * v_den AND v_ref <= 0.5 * (v_acc + v_ref);',
  'v_pass := (v_local + v_ref) <= 0.2 * v_den AND v_ref <= 0.2 * (v_acc + v_ref);');
END $b$;
