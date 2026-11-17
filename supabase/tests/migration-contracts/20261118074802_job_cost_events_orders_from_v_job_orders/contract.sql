BEGIN;
SET LOCAL statement_timeout='120s';
-- Earlier contracts can unwind the line reader. Restore its owners inside this
-- rollback transaction (P2-01.7's reader, then P2-03.1), then this migration.
\ir ../20261118060051_reconcile_tables/main_lines_reader.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
DO $pre$ BEGIN
 IF md5(pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true))<>'c98dd14a51e982b78493c3385b25c9d9'
 OR to_regclass('public.v_job_orders') IS NULL THEN
  RAISE EXCEPTION 'P2-10.2 contract: main reader not restored'; END IF;
END $pre$;
CREATE TEMP TABLE parent_definition AS SELECT pg_get_viewdef('public.v_job_cost_events'::regclass,true) def;

-- Org 1. Jobs: A and B live, Q quoted. Supplier S1 has a Xero contact; S2 none.
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('10210000-0000-4000-8000-00000000000a','00000000-0000-0000-0000-000000000001','ZZTEST-1021-A','fencing','accepted'),
 ('10210000-0000-4000-8000-00000000000b','00000000-0000-0000-0000-000000000001','ZZTEST-1021-B','fencing','accepted'),
 ('10210000-0000-4000-8000-00000000000c','00000000-0000-0000-0000-000000000001','ZZTEST-1021-Q','fencing','quoted');
INSERT INTO public.suppliers(id,name,xero_contact_id) VALUES
 ('10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST-contact-1021'),
 ('10210000-0000-4000-8000-000000000052','ZZTEST Timber',NULL);
-- O1 cost 1500+500; O2 no cost; O3 one line missing its cost; O4 lines of 0;
-- O5 on a quoted job; O6 a draft.
INSERT INTO public.dispatch_supplier_order_emails(id,org_id,job_id,supplier_id,supplier_name,subject,status,sent_at,order_cost) VALUES
 ('10210000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000a','10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST order','sent','2026-11-10T02:00:00Z',
  '{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":1500.00},{"line_cost_ex_gst":500.00}]}'),
 ('10210000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000b','10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST order','sent','2026-11-10T02:00:00Z',NULL),
 ('10210000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000a','10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST order','sent','2026-11-10T02:00:00Z',
  '{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":1500.00},{}]}'),
 ('10210000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000a','10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST order','sent','2026-11-10T02:00:00Z',
  '{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":0}]}'),
 ('10210000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000c','10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST order','sent','2026-11-10T02:00:00Z',
  '{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":300.00}]}'),
 ('10210000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000a','10210000-0000-4000-8000-000000000052','ZZTEST Timber','ZZTEST order','draft',NULL,NULL);
INSERT INTO public.purchase_orders(id,job_id,po_number,supplier_name,status,subtotal,total,created_at) VALUES
 ('10210000-0000-4000-8000-000000000061','10210000-0000-4000-8000-00000000000a','ZZTEST-PO-1021','ZZTEST Steel Pty Ltd','sent',100,110,'2026-11-10T00:00:00Z');

CREATE TEMP TABLE main_off_rows AS SELECT to_jsonb(e) r FROM public.v_job_cost_events e;
CREATE TEMP TABLE main_line_rows AS SELECT to_jsonb(e) r FROM public.v_job_cost_events_lines e;

\ir ../../../migrations/20261118074802_job_cost_events_orders_from_v_job_orders.sql
-- A re-apply is a no-op.
\ir ../../../migrations/20261118074802_job_cost_events_orders_from_v_job_orders.sql

CREATE FUNCTION pg_temp.expect_failure(command text, expected text) RETURNS void
LANGUAGE plpgsql AS $expect$
DECLARE failed boolean:=false; BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN
  IF position(expected IN SQLERRM)=0 THEN RAISE; END IF;
  failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'expected refusal: %',expected; END IF;
END $expect$;

-- Switch off: every reader of v_job_cost_events gets main's rows and main's view.
-- The line reader keeps every main row and only adds dispatch order rows.
DO $off$ BEGIN
 IF md5(pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true))<>'90b424e43450a35382e013b01a0d2462' THEN
  RAISE EXCEPTION 'P2-10.2 post-image differs'; END IF;
 IF pg_get_viewdef('public.v_job_cost_events'::regclass,true)<>(SELECT def FROM parent_definition) THEN
  RAISE EXCEPTION 'P2-10.2 parent reader changed'; END IF;
 IF EXISTS((SELECT to_jsonb(e) FROM public.v_job_cost_events e EXCEPT ALL SELECT r FROM main_off_rows)
 UNION ALL (SELECT r FROM main_off_rows EXCEPT ALL SELECT to_jsonb(e) FROM public.v_job_cost_events e)) THEN
  RAISE EXCEPTION 'P2-10.2 switch off differs from main'; END IF;
 IF EXISTS(SELECT r FROM main_line_rows EXCEPT ALL SELECT to_jsonb(e) FROM public.v_job_cost_events_lines e)
 OR EXISTS(SELECT 1 FROM (SELECT to_jsonb(e) r FROM public.v_job_cost_events_lines e EXCEPT ALL SELECT r FROM main_line_rows) x
  WHERE x.r->>'match_method'<>'dispatch_order.job_id') THEN
  RAISE EXCEPTION 'P2-10.2 main line rows changed'; END IF;
END $off$;

-- Switch on in this transaction only.
INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES('job_cost_events_from_cost_lines_v1',true,'ZZTEST') ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
UPDATE public.job_cost_events_cutover SET bills_backfilled_at=now(),credits_backfilled_at=now(),
 trade_backfilled_at=now(),trade_triggers_installed_at=now(),completed_at=now() WHERE singleton;

DO $on$ DECLARE n int; BEGIN
 SELECT count(*) INTO n FROM public.v_job_cost_events WHERE source_id='10210000-0000-4000-8000-000000000001'
  AND job_id='10210000-0000-4000-8000-00000000000a' AND amount_ex=2000.00 AND NOT is_actual
  AND source='po_committed' AND confidence='committed' AND lane='materials' AND lane_detail='purchase_order'
  AND party='ZZTEST Steel Pty Ltd' AND document_number IS NULL AND match_method='dispatch_order.job_id';
 IF n<>1 THEN RAISE EXCEPTION 'P2-10.2 known cost order must be one committed event, got %',n; END IF;
 -- No cost, a line missing its cost, or a cost of 0: one event, amount unknown, never 0.
 IF (SELECT count(*) FROM public.v_job_cost_events WHERE source_id IN ('10210000-0000-4000-8000-000000000002',
  '10210000-0000-4000-8000-000000000003','10210000-0000-4000-8000-000000000004')
  AND amount_ex IS NULL AND source='po_ordered' AND confidence='ordered_not_billed' AND NOT is_actual)<>3
 OR EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE match_method='dispatch_order.job_id' AND amount_ex=0) THEN
  RAISE EXCEPTION 'P2-10.2 unknown cost must read NULL'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='10210000-0000-4000-8000-000000000002'
  AND job_id='10210000-0000-4000-8000-00000000000b') THEN RAISE EXCEPTION 'P2-10.2 job B order missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id IN ('10210000-0000-4000-8000-000000000005',
  '10210000-0000-4000-8000-000000000006')) THEN
  RAISE EXCEPTION 'P2-10.2 quoted job or draft order must not show'; END IF;
 IF (SELECT count(*) FROM public.v_job_cost_events WHERE match_method='dispatch_order.job_id')<>4 THEN
  RAISE EXCEPTION 'P2-10.2 one event per sent order'; END IF;
 IF (SELECT count(*) FROM public.v_job_cost_events WHERE document_number='ZZTEST-PO-1021' AND amount_ex=100)<>1 THEN
  RAISE EXCEPTION 'P2-10.2 purchase order row changed'; END IF;
END $on$;

-- The service role reads the line reader. v_job_orders is security_invoker, so
-- its base tables are checked as the caller: mirror live's service role
-- (table grants and BYPASSRLS), inside this rolled-back transaction only.
GRANT SELECT ON public.jobs,public.suppliers,public.purchase_orders,public.job_order_emails,
 public.dispatch_supplier_order_emails,public.job_cost_lines,public.job_cost_line_parts,
 public.reconcile_items,public.feature_flags,public.job_cost_events_cutover TO service_role;
ALTER ROLE service_role BYPASSRLS;
SET LOCAL ROLE service_role;
DO $svc$ BEGIN
 IF (SELECT count(*) FROM public.v_job_cost_events_lines WHERE match_method='dispatch_order.job_id')<>4 THEN
  RAISE EXCEPTION 'P2-10.2 service role read'; END IF;
END $svc$;
RESET ROLE;

-- A bill line names O1 but waits for a person: v_job_orders.matched is true,
-- yet no cost is on job A, so the 2000 commitment stays and actual is 0.
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,
 order_kind,order_id,party_id,party_name,event_source,event_lane_detail)
VALUES('10210000-0000-4000-8000-000000000071','00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill',
 'ZZTEST-BILL-1021','1','materials',2000,'needs_person','ZZTEST','dispatch_order','10210000-0000-4000-8000-000000000001',
 'ZZTEST-contact-1021','ZZTEST Steel Pty Ltd','supplier_bill','supplier_bill');
DO $awaiting$ BEGIN
 IF NOT (SELECT matched FROM public.v_job_orders WHERE order_id='10210000-0000-4000-8000-000000000001') THEN
  RAISE EXCEPTION 'P2-10.2 fixture: needs_person line must match the order'; END IF;
 IF (SELECT coalesce(sum(amount_ex),0) FROM public.v_job_cost_events
  WHERE job_id='10210000-0000-4000-8000-00000000000a' AND source_id='10210000-0000-4000-8000-000000000001'
   AND source='po_committed' AND NOT is_actual)<>2000
 OR (SELECT coalesce(sum(amount_ex),0) FROM public.v_job_cost_events
  WHERE job_id='10210000-0000-4000-8000-00000000000a' AND is_actual)<>0 THEN
  RAISE EXCEPTION 'P2-10.2 an order awaiting a person must stay committed at 2000 with 0 actual'; END IF;
END $awaiting$;
-- The bill is counted against O1 on job A: the commitment closes, the bill counts once.
UPDATE public.job_cost_lines SET state='on_job' WHERE id='10210000-0000-4000-8000-000000000071';
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
VALUES('10210000-0000-4000-8000-000000000071',1,'job','10210000-0000-4000-8000-00000000000a','materials',2000);
-- A purchase order closes when v_job_orders.matched is true; a line not
-- counted (removed) leaves O2 open.
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,order_kind,order_id)
VALUES('00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill','ZZTEST-BILL-1021-PO','1','materials',100,
 'needs_person','ZZTEST','purchase_order','10210000-0000-4000-8000-000000000061');
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,not_counted_reason,source_hash,order_kind,order_id)
VALUES('00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill','ZZTEST-BILL-1021-B','1','materials',50,
 NULL,'line_removed','ZZTEST','dispatch_order','10210000-0000-4000-8000-000000000002');
DO $closed$ BEGIN
 IF EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='10210000-0000-4000-8000-000000000001') THEN
  RAISE EXCEPTION 'P2-10.2 billed order still committed'; END IF;
 IF (SELECT coalesce(sum(amount_ex),0) FROM public.v_job_cost_events
  WHERE job_id='10210000-0000-4000-8000-00000000000a' AND is_actual)<>2000 THEN
  RAISE EXCEPTION 'P2-10.2 billed order must count once'; END IF;
 IF NOT (SELECT matched FROM public.v_job_orders WHERE order_id='10210000-0000-4000-8000-000000000061')
 OR EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE document_number='ZZTEST-PO-1021') THEN
  RAISE EXCEPTION 'P2-10.2 matched purchase order must close'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='10210000-0000-4000-8000-000000000002') THEN
  RAISE EXCEPTION 'P2-10.2 a not-counted line must not close an order'; END IF;
END $closed$;

-- The office changes records by hand: the bill line is taken off (not counted),
-- and O2 gets its cost. The next read follows both.
DELETE FROM public.job_cost_line_parts WHERE line_id='10210000-0000-4000-8000-000000000071';
UPDATE public.job_cost_lines SET state=NULL,not_counted_reason='document_not_live'
 WHERE id='10210000-0000-4000-8000-000000000071';
UPDATE public.dispatch_supplier_order_emails SET order_cost='{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":700.00}]}'
 WHERE id='10210000-0000-4000-8000-000000000002';
DO $office$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='10210000-0000-4000-8000-000000000001'
  AND amount_ex=2000 AND source='po_committed') THEN RAISE EXCEPTION 'P2-10.2 un-billed order must reopen'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='10210000-0000-4000-8000-000000000002'
  AND amount_ex=700 AND source='po_committed') THEN RAISE EXCEPTION 'P2-10.2 office cost must show'; END IF;
END $office$;

-- The trigger is installed only by its function, never by the migration.
DO $notrigger$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='dispatch_order_commitment'
  AND tgrelid='public.dispatch_supplier_order_emails'::regclass) THEN
  RAISE EXCEPTION 'P2-10.2 migration must not install the trigger'; END IF;
END $notrigger$;
SELECT public.install_dispatch_order_commitment();
-- Open bill items: BX1 by Xero contact, BX2 by name key; BX3 another supplier,
-- BX4 decided, BX5 a credit, BX6 another org: none of those is queued.
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,party_id,party_name)
SELECT o,'supplier_bill','xero_bill',d,'1','materials',10,'needs_person','ZZTEST',p,n FROM (VALUES
 ('00000000-0000-0000-0000-000000000001'::uuid,'ZZTEST-BX1','ZZTEST-contact-1021','Other words'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'ZZTEST-BX2',NULL,'ZZTEST STEEL LIMITED'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'ZZTEST-BX3',NULL,'ZZTEST Timber'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'ZZTEST-BX4','ZZTEST-contact-1021','ZZTEST Steel'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'ZZTEST-BX5','ZZTEST-contact-1021','ZZTEST Steel'),
 ('00000000-0000-0000-0000-000000000002'::uuid,'ZZTEST-BX6','ZZTEST-contact-1021','ZZTEST Steel')) v(o,d,p,n);
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by,status)
SELECT o,k,'cost_document','xero_bill:'||d,'new','fixture','migration',s FROM (VALUES
 ('00000000-0000-0000-0000-000000000001'::uuid,'bill','ZZTEST-BX1','open'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'bill','ZZTEST-BX2','open'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'bill','ZZTEST-BX3','open'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'bill','ZZTEST-BX4','decided'),
 ('00000000-0000-0000-0000-000000000001'::uuid,'credit','ZZTEST-BX5','open'),
 ('00000000-0000-0000-0000-000000000002'::uuid,'bill','ZZTEST-BX6','open')) v(o,k,d,s);
DELETE FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%';
DELETE FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000a';

-- Sending an order to S1 marks its job and queues S1's two open bills.
UPDATE public.dispatch_supplier_order_emails SET supplier_id='10210000-0000-4000-8000-000000000051',
 supplier_name='ZZTEST Steel Pty Ltd' WHERE id='10210000-0000-4000-8000-000000000006';
DO $draft$ BEGIN
 IF EXISTS(SELECT 1 FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%')
 OR EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000a') THEN
  RAISE EXCEPTION 'P2-10.2 an edit that is not status or cost does nothing'; END IF;
END $draft$;
UPDATE public.dispatch_supplier_order_emails SET status='sent',sent_at=now() WHERE id='10210000-0000-4000-8000-000000000006';
DO $sent$ BEGIN
 IF (SELECT array_agg(subject_id ORDER BY subject_id) FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%')
  IS DISTINCT FROM ARRAY['xero_bill:ZZTEST-BX1','xero_bill:ZZTEST-BX2']
 OR EXISTS(SELECT 1 FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%'
  AND (subject_kind<>'cost_document' OR reason<>'order_sent'))
 OR NOT EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000a' AND reason='order') THEN
  RAISE EXCEPTION 'P2-10.2 send must mark the job and queue the supplier''s open bills'; END IF;
END $sent$;
-- A repeated send queues nothing twice; a cost change on a sent order marks the job only.
UPDATE public.dispatch_supplier_order_emails SET status='sent' WHERE id='10210000-0000-4000-8000-000000000006';
DELETE FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%';
DELETE FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000a';
UPDATE public.dispatch_supplier_order_emails SET order_cost='{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":90.00}]}'
 WHERE id='10210000-0000-4000-8000-000000000006';
DO $cost$ BEGIN
 IF EXISTS(SELECT 1 FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%')
 OR NOT EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000a' AND reason='order') THEN
  RAISE EXCEPTION 'P2-10.2 cost change must mark the job and queue nothing'; END IF;
END $cost$;

-- A failed queue write or a failed job mark never fails the order send.
SAVEPOINT broken_queue;
ALTER TABLE public.match_queue ADD CONSTRAINT zztest_no_order_sent CHECK (reason<>'order_sent') NOT VALID;
INSERT INTO public.dispatch_supplier_order_emails(id,org_id,job_id,supplier_id,supplier_name,subject,status,sent_at)
VALUES('10210000-0000-4000-8000-000000000007','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000b',
 '10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST order','sent',now());
DO $q$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_supplier_order_emails WHERE id='10210000-0000-4000-8000-000000000007')
 OR EXISTS(SELECT 1 FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%')
 OR NOT EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000b' AND reason='order') THEN
  RAISE EXCEPTION 'P2-10.2 a failed queue write must not fail the send'; END IF;
END $q$;
ROLLBACK TO broken_queue;
SAVEPOINT broken_mark;
ALTER TABLE public.job_profit_dirty ADD CONSTRAINT zztest_no_order_mark CHECK (reason<>'order') NOT VALID;
DELETE FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000b';
INSERT INTO public.dispatch_supplier_order_emails(id,org_id,job_id,supplier_id,supplier_name,subject,status,sent_at)
VALUES('10210000-0000-4000-8000-000000000007','00000000-0000-0000-0000-000000000001','10210000-0000-4000-8000-00000000000b',
 '10210000-0000-4000-8000-000000000051','ZZTEST Steel Pty Ltd','ZZTEST order','sent',now());
DO $m$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_supplier_order_emails WHERE id='10210000-0000-4000-8000-000000000007')
 OR EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000b')
 OR (SELECT count(*) FROM public.match_queue WHERE subject_id LIKE 'xero_bill:ZZTEST-BX%' AND reason='order_sent')<>2 THEN
  RAISE EXCEPTION 'P2-10.2 a failed job mark must not fail the send or the queue'; END IF;
END $m$;
ROLLBACK TO broken_mark;

-- Removed: a send no longer marks or queues.
SELECT public.remove_dispatch_order_commitment();
DELETE FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000b';
UPDATE public.dispatch_supplier_order_emails SET status='discarded' WHERE id='10210000-0000-4000-8000-000000000002';
DO $removed$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='dispatch_order_commitment')
 OR EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='10210000-0000-4000-8000-00000000000b') THEN
  RAISE EXCEPTION 'P2-10.2 remove must drop the trigger'; END IF;
 IF has_function_privilege('authenticated','public.install_dispatch_order_commitment()','EXECUTE')
 OR has_function_privilege('anon','public.dispatch_order_rematch_subjects(uuid,text,text)','EXECUTE')
 OR has_table_privilege('authenticated','public.v_job_cost_events_lines','SELECT') THEN
  RAISE EXCEPTION 'P2-10.2 service-only grants'; END IF;
END $removed$;

-- Plans: the re-match read walks the open bill list by index and each item's
-- lines by index, never the closed history or every cost line.
SAVEPOINT plan_fixture;
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,reason,evidence_hash,raised_by,status)
SELECT '00000000-0000-0000-0000-000000000001',CASE WHEN n%2=0 THEN 'bill' ELSE 'message' END,'cost_document',
 'xero_bill:ZZTEST-HIST-'||n,'new','fixture','migration',CASE WHEN n%2=0 THEN 'decided' ELSE 'open' END
FROM generate_series(1,12000) n;
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,party_id,party_name,order_kind,order_id)
SELECT '00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill','ZZTEST-HIST-'||n,'1','materials',10,'needs_person','ZZTEST',
 'ZZTEST-contact-1021','ZZTEST Steel','purchase_order','ZZTEST-PO-HIST-'||n FROM generate_series(1,6000) n;
-- Dispatch order lines with parts on job B: the allocation probe reads by index.
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,order_kind,order_id)
SELECT ('10210000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill',
 'ZZTEST-ALLOC-'||n,'1','materials',10,'on_job','ZZTEST','dispatch_order','ZZTEST-DO-HIST-'||n FROM generate_series(1,6000) n;
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
SELECT ('10210000-0000-4000-9000-'||lpad(n::text,12,'0'))::uuid,1,'job','10210000-0000-4000-8000-00000000000b','materials',10
FROM generate_series(1,6000) n;
-- O1's bill counted, but its part is on job B: O1 stays committed on job A.
UPDATE public.job_cost_lines SET state='on_job',not_counted_reason=NULL
 WHERE id='10210000-0000-4000-8000-000000000071';
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
VALUES('10210000-0000-4000-8000-000000000071',1,'job','10210000-0000-4000-8000-00000000000b','materials',2000);
DO $otherjob$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='10210000-0000-4000-8000-000000000001'
  AND job_id='10210000-0000-4000-8000-00000000000a' AND amount_ex=2000 AND source='po_committed') THEN
  RAISE EXCEPTION 'P2-10.2 a bill on another job must not close the order'; END IF;
END $otherjob$;
ANALYZE public.reconcile_items;
ANALYZE public.job_cost_lines;
ANALYZE public.job_cost_line_parts;
DO $plan$ DECLARE plan jsonb; BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE,FORMAT JSON) SELECT * FROM public.dispatch_order_rematch_subjects(
  '00000000-0000-0000-0000-000000000001','ZZTEST-contact-1021','zzteststeel')$q$ INTO plan;
 IF EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "reconcile_items" || @."Relation Name" == "job_cost_lines")') node
  WHERE node->>'Node Type'='Seq Scan')
 OR NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "reconcile_items")') node
  WHERE node->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan'))
 OR NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "job_cost_lines")') node
  WHERE node->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan'))
 OR EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "reconcile_items")') node
  WHERE (node->>'Actual Loops')::numeric*(coalesce((node->>'Actual Rows')::numeric,0)
   +coalesce((node->>'Rows Removed by Filter')::numeric,0))>20) THEN
  RAISE EXCEPTION 'P2-10.2 re-match read must be bounded and indexed: %',plan; END IF;
 EXECUTE $q$EXPLAIN (ANALYZE,FORMAT JSON) SELECT * FROM public.v_job_orders
  WHERE order_kind='dispatch_order' AND job_id='10210000-0000-4000-8000-00000000000a'$q$ INTO plan;
 IF EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "job_cost_lines")') node
  WHERE node->>'Node Type'='Seq Scan' AND (node->>'Actual Loops')::numeric>0) THEN
  RAISE EXCEPTION 'P2-10.2 order close test must use an index: %',plan; END IF;
 EXECUTE $q$EXPLAIN (ANALYZE,FORMAT JSON) SELECT * FROM public.v_job_cost_events_lines
  WHERE match_method='dispatch_order.job_id' AND job_id='10210000-0000-4000-8000-00000000000a'$q$ INTO plan;
 IF EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "job_cost_lines" || @."Relation Name" == "job_cost_line_parts")') node
  WHERE node->>'Node Type'='Seq Scan' AND (node->>'Actual Loops')::numeric>0)
 OR NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == "job_cost_line_parts")') node
  WHERE node->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan') AND (node->>'Actual Loops')::numeric>0) THEN
  RAISE EXCEPTION 'P2-10.2 allocation probe must use an index: %',plan; END IF;
END $plan$;
ROLLBACK TO plan_fixture;

SELECT 'PASS P2-10.2: dispatch orders committed until counted, unknown cost NULL, matched purchase orders close, off parity, guarded queue and mark';
ROLLBACK;
