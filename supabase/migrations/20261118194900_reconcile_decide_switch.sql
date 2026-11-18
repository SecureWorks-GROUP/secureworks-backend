-- P2-03.7 (Follow-up 66): the switch for the Reconcile decide and undo doors.
-- Ships off; only the director turns it on. Inserts one row and changes
-- nothing else. ops-api reads a missing row as off and refuses (503) when the
-- switch cannot be read.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'reconcile_decide_v1', false,
  'A signed-in staff member places, splits or files a waiting cost line from the Reconcile list (ops-api reconcile_decide and reconcile_undo). Off until the director says.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1'
);
