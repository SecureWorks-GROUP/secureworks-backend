-- Ship the deep load with a tick that reads every mailbox back to the hard
-- floor (1 Jan 2025), past the start of the oldest monitored live job: the
-- owner's "never further" broken. The contract must catch it.
DO $$
DECLARE src text;
BEGIN
 src:=pg_get_functiondef('public.trigger_context_email_deep_history()'::regprocedure);
 src:=replace(src,'v_from:=date_trunc(''second'',nd.need);','v_from:=v_hard;');
 src:=replace(src,'v_from:=greatest(date_trunc(''second'',v_floor),v_to-v_slice);','v_from:=greatest(v_hard,v_to-v_slice);');
 IF src NOT LIKE '%v_from:=v_hard;%' OR src NOT LIKE '%v_from:=greatest(v_hard,v_to-v_slice);%' THEN
  RAISE EXCEPTION 'deep break: the tick no longer has the floor lines this break replaces';
 END IF;
 EXECUTE src;
END $$;
