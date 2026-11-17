DO $$ BEGIN
 IF to_regclass('public.job_cost_lines_shadow_retries') IS NOT NULL
  OR to_regprocedure('public.job_cost_lines_retry_one()') IS NOT NULL
  OR to_regprocedure('public.job_cost_lines_write_state(uuid,text,jsonb,text,bigint,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'followup8 rollback: retry objects remain'; END IF;
 IF pg_get_functiondef('public.job_cost_lines_sync_trade_invoice(uuid)'::regprocedure) NOT LIKE '%WHERE id=p_trade_invoice_id FOR UPDATE%' THEN
  RAISE EXCEPTION 'followup8 rollback: previous trade function not restored'; END IF;
END $$;
