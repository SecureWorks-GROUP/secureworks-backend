-- Deliberately carry every note again: the packet refuses, and the contract must catch it.
DO $b$ DECLARE v_def text := pg_get_functiondef('public.context_ledger_rebuild_packet(uuid,uuid)'::regprocedure); BEGIN
 EXECUTE replace(v_def, '   IF v_gone IS NOT NULL THEN', '   IF false THEN');
END $b$;
