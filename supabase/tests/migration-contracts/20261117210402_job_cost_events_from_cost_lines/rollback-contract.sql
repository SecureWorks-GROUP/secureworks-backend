BEGIN;
DO $rollback$ BEGIN
 IF to_regclass('public.job_cost_events_cutover') IS NOT NULL THEN
  RAISE EXCEPTION 'P2-01.7 rollback: cutover marker remains'; END IF;
 IF to_regclass('public.v_job_cost_events_lines') IS NOT NULL OR to_regclass('public.v_job_cost_events_legacy') IS NOT NULL THEN
  RAISE EXCEPTION 'P2-01.7 rollback: helper views remain'; END IF;
 IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass,true))<>'b48997c55913ce3c90e3a3c947533fd3' THEN
  RAISE EXCEPTION 'P2-01.7 rollback: legacy definition not restored'; END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name IN
 ('v_job_cost_events','job_cost_events_stored') AND column_name IN ('cost_line_id','cost_kind')) THEN
  RAISE EXCEPTION 'P2-01.7 rollback: appended columns remain'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN
 ('job_cost_events_parts_dirty','job_cost_events_lines_dirty','job_cost_events_switch_dirty')) THEN
  RAISE EXCEPTION 'P2-01.7 rollback: triggers remain'; END IF;
END $rollback$;
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('00000000-0000-0000-0000-00000000e701','00000000-0000-0000-0000-000000000001','ZZTEST-COST-A','fencing','accepted');
INSERT INTO public.purchase_orders(id,job_id,po_number,status,subtotal,total,created_at) VALUES
 ('00000000-0000-0000-0000-00000000e710','00000000-0000-0000-0000-00000000e701','ZZTEST-PO','sent',50,55,'2026-11-17T00:00:00Z');
DO $rows$ BEGIN
 IF (SELECT count(*) FROM public.v_job_cost_events WHERE job_id='00000000-0000-0000-0000-00000000e701')<>1
 OR (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE job_id='00000000-0000-0000-0000-00000000e701')<>50 THEN
  RAISE EXCEPTION 'P2-01.7 rollback: legacy rows missing'; END IF;
END $rows$;
-- The legacy typed RPC must survive the dependent-view rebuild as well.
SELECT count(*) FROM public.job_profit('00000000-0000-0000-0000-00000000e701');
SELECT 'PASS P2-01.7 rollback: original legacy view and fixture commitment restored';
ROLLBACK;
