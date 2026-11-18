-- Reconcile decide switch, checked inside the database (Follow-up 66, director
-- 03:36, queued hardening). PLACEHOLDER version: the keeper stamps the real one
-- when the PR is marked ready.
--
-- reconcile_decide (20261118073318) and reconcile_undo (20261118195300) each
-- read feature_flags.reconcile_decide_v1 as their first statement and refuse
-- 'reconcile_decide_off' (SQLSTATE 55000) unless it is true. A missing row is
-- off; an unreadable table raises its own error. Before this, only the ops-api
-- door read the switch, so a service-role caller reaching the functions
-- directly could decide or undo with the switch off. The ops-api door already
-- maps 'reconcile_decide_off' to its own 409 words, so the screen says the
-- same thing whichever side refuses.
--
-- Nothing else in either body changes: each is patched in place (the
-- 20261118195300 match_apply pattern), keeping its signature, grants, comment
-- and settings, guarded on main's body or this migration's own, and checked
-- after. reconcile_decide_message (P2-03.5) does not exist yet; when it is
-- built it carries the same first statement.
--
-- No table, row, switch, trigger or schedule changes. The switch stays as it is
-- (off as seeded by 20261118194900).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $patch$
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
/* each body: main's (patch it), this migration's (re-apply), else refuse */ BEGIN
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
    IF to_regprocedure(f.sig) IS NULL THEN
      RAISE EXCEPTION 'reconcile_decide_switch_in_database: % is missing', f.sig;
    END IF;
    SELECT md5(prosrc), pg_get_functiondef(oid) INTO STRICT h, def FROM pg_proc WHERE oid = to_regprocedure(f.sig);
    IF h = f.main_md5 THEN
      n := (length(def) - length(replace(def, f.head || f.tail, ''))) / length(f.head || f.tail);
      IF n <> 1 THEN
        RAISE EXCEPTION 'reconcile_decide_switch_in_database: % has % insertion points', f.sig, n;
      END IF;
      EXECUTE replace(def, f.head || f.tail, f.head || switch_check || f.tail);
    ELSIF h <> f.own_md5 THEN
      RAISE EXCEPTION 'reconcile_decide_switch_in_database: % body changed', f.sig;
    END IF;
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(f.sig)) <> f.own_md5 THEN
      RAISE EXCEPTION 'reconcile_decide_switch_in_database: % did not patch to its expected body', f.sig;
    END IF;
  END LOOP;
END
$patch$;
