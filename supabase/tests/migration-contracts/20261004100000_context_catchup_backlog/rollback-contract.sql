-- After the down migration: the writer is gone, the pending read is
-- 20260924220000's body again (the down migration checks its md5 itself),
-- mode and scope are gone, and priority is 1..2 again.
DO $$
BEGIN
 IF to_regprocedure('public.context_catchup_request_backlog(integer,boolean,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'backlog rollback left the writer'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_catchup_pending_rows(uuid[])')) IS DISTINCT FROM '153a4a0e10b566445a029f0785c096ff'
 THEN RAISE EXCEPTION 'backlog rollback did not restore the pending read'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_catchup_jobs'::regclass AND attname IN ('mode','scope') AND attnum>0 AND NOT attisdropped)
 THEN RAISE EXCEPTION 'backlog rollback left mode or scope'; END IF;
 IF (SELECT array_agg(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.context_catchup_jobs'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%priority%') IS DISTINCT FROM ARRAY['CHECK ((priority = ANY (ARRAY[1, 2])))']
 THEN RAISE EXCEPTION 'backlog rollback priority check'; END IF;
 IF has_function_privilege('anon','public.context_catchup_pending_rows(uuid[])','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_catchup_pending_rows(uuid[])','EXECUTE')
 THEN RAISE EXCEPTION 'backlog rollback grants'; END IF;
 IF to_regprocedure('public.context_catchup_request(boolean)') IS NULL THEN RAISE EXCEPTION 'backlog rollback dropped the original writer'; END IF;
END $$;

-- The rows: forward again with a pending original row, a pending backlog row
-- and a done backlog row at tier 4, then down. Only the pending backlog row is
-- deleted; the done one stays with a priority the 1..2 check accepts.
BEGIN;
\ir ../../../migrations/20261004100000_context_catchup_backlog.sql
CREATE TEMP TABLE bl_rb_jobs AS
 SELECT gen_random_uuid() AS id, x AS job_number FROM unnest(ARRAY['BL-RB-LIVE','BL-RB-PENDING','BL-RB-DONE']) x;
INSERT INTO public.jobs(id,org_id,status,type,job_number)
 SELECT id,'00000000-0000-0000-0000-000000000001','complete','fencing',job_number FROM bl_rb_jobs;
INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) SELECT id,job_number,1 FROM bl_rb_jobs WHERE job_number='BL-RB-LIVE';
INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope) SELECT id,job_number,4,'unread','backlog' FROM bl_rb_jobs WHERE job_number='BL-RB-PENDING';
INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope,done_at,done_run_id)
 SELECT id,job_number,4,'full','backlog',now(),gen_random_uuid() FROM bl_rb_jobs WHERE job_number='BL-RB-DONE';
\ir ../../../rollbacks/20261004100000_context_catchup_backlog_down.sql
DO $$
BEGIN
 IF (SELECT string_agg(c.job_number||'/'||c.priority||'/'||(c.done_at IS NOT NULL),',' ORDER BY c.job_number)
     FROM public.context_catchup_jobs c WHERE c.job_number LIKE 'BL-RB-%') IS DISTINCT FROM 'BL-RB-DONE/2/true,BL-RB-LIVE/1/false'
 THEN RAISE EXCEPTION 'backlog rollback rows %',(SELECT jsonb_agg(to_jsonb(c)) FROM public.context_catchup_jobs c WHERE c.job_number LIKE 'BL-RB-%'); END IF;
END $$;
ROLLBACK;
