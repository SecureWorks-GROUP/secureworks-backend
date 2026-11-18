-- Rollback of 20261119999920_reconcile_decide_switch_in_database (PLACEHOLDER
-- version): takes the switch check back out of reconcile_decide and
-- reconcile_undo, putting back main's bodies (20261118073318, 20261118195300)
-- byte for byte; grants, comments and settings are kept. A body that is
-- already main's is left alone (a re-run); a missing function is skipped, so
-- an earlier contract can run this first wherever it re-applies or rolls back
-- those migrations. Any other body refuses. Changes no row or switch.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $unpatch$
DECLARE
  f record;
  h text;
  def text;
  n int;
  switch_check constant text := $chk$  -- reconcile_decide_v1, checked here as well as at the ops-api door: off,
  -- missing or unreadable refuses before anything is read or written.
  IF NOT coalesce((SELECT f.enabled FROM public.feature_flags f WHERE f.flag_name = 'reconcile_decide_v1'), false) THEN
    RAISE EXCEPTION 'reconcile_decide_off' USING ERRCODE = '55000';
  END IF;
$chk$;
/* each body: this migration's (unpatch it), main's (re-run), else refuse */ BEGIN
  FOR f IN SELECT * FROM (VALUES
    ('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)',
     '5eb8d0b43f1a2b8339d3f739a6d05433', '95d788204b6dbbc1817d48a254989130',
     E'/* block */ BEGIN\n',
     E'  -- 1. Staff only, in the item''s organisation (read after the item, below).\n'),
    ('public.reconcile_undo(bigint,uuid)',
     '8d34d85b018204c72d7db66ea915dcda', '7c7cf1647abd300405165d017cd35338',
     E'/* one transaction for the document, review item and decision */ BEGIN\n',
     '')) v(sig, main_md5, own_md5, head, tail)
  LOOP
    CONTINUE WHEN to_regprocedure(f.sig) IS NULL;
    SELECT md5(prosrc), pg_get_functiondef(oid) INTO STRICT h, def FROM pg_proc WHERE oid = to_regprocedure(f.sig);
    IF h = f.own_md5 THEN
      n := (length(def) - length(replace(def, f.head || switch_check || f.tail, ''))) / length(f.head || switch_check || f.tail);
      IF n <> 1 THEN
        RAISE EXCEPTION 'reconcile_decide_switch_in_database down: % has % patched points', f.sig, n;
      END IF;
      EXECUTE replace(def, f.head || switch_check || f.tail, f.head || f.tail);
    ELSIF h <> f.main_md5 THEN
      RAISE EXCEPTION 'reconcile_decide_switch_in_database down: % body changed', f.sig;
    END IF;
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(f.sig)) <> f.main_md5 THEN
      RAISE EXCEPTION 'reconcile_decide_switch_in_database down: % did not return to main''s body', f.sig;
    END IF;
  END LOOP;
END
$unpatch$;
