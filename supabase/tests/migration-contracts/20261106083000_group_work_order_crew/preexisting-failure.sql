DO $$ DECLARE body text := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
BEGIN EXECUTE replace(body,'-- Every participant, and every installer currently assigned to the job,','-- Unexpected crew preimage'); END $$;
