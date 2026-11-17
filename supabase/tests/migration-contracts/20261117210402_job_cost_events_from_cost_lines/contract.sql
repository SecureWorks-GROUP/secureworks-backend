BEGIN;
-- Restore this ticket after earlier contracts unwind dependent views. Keep the
-- replay inside our rollback transaction so later contracts retain their state.
\ir ../../../migrations/20261117210402_job_cost_events_from_cost_lines.sql
SET LOCAL TimeZone='UTC';
CREATE TEMP TABLE profit_definition AS SELECT pg_get_viewdef('public.v_job_profit'::regclass,true) def;
DO $schema$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN
 ('job_cost_events_parts_dirty','job_cost_events_lines_dirty','job_cost_events_switch_dirty','job_cost_events_cutover_dirty')) THEN
  RAISE EXCEPTION 'P2-01.7: triggers installed on merge';
 END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_events_from_cost_lines_v1' AND enabled) THEN
  RAISE EXCEPTION 'P2-01.7: switch on at merge';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_cost_events_cutover WHERE singleton AND completed_at IS NULL) THEN
  RAISE EXCEPTION 'P2-01.7: cutover marker must be unset'; END IF;
 IF has_table_privilege('service_role','public.job_cost_events_cutover','UPDATE')
 OR has_table_privilege('authenticated','public.job_cost_events_cutover','SELECT')
 OR has_table_privilege('authenticated','public.v_job_cost_events_lines','SELECT')
 OR has_table_privilege('anon','public.v_job_cost_events_legacy','SELECT')
 OR has_function_privilege('authenticated','public.install_job_cost_events_from_cost_lines()','EXECUTE') THEN
  RAISE EXCEPTION 'P2-01.7: service boundary';
 END IF;
END $schema$;
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('00000000-0000-0000-0000-00000000e701','00000000-0000-0000-0000-000000000001','ZZTEST-COST-A','fencing','accepted'),
 ('00000000-0000-0000-0000-00000000e702','00000000-0000-0000-0000-000000000001','ZZTEST-COST-B','fencing','accepted');
INSERT INTO public.purchase_orders(id,job_id,po_number,status,subtotal,total,created_at) VALUES
 ('00000000-0000-0000-0000-00000000e710','00000000-0000-0000-0000-00000000e701','ZZTEST-PO','sent',50,55,'2026-11-17T00:00:00Z');
-- One contract behaviour: switch routing preserves legacy and conserves job parts.
DO $off$ DECLARE a bigint; b bigint; x numeric; y numeric; BEGIN
 SELECT count(*),sum(amount_ex) INTO a,x FROM public.v_job_cost_events WHERE job_id='00000000-0000-0000-0000-00000000e701';
 SELECT count(*),sum(amount_ex) INTO b,y FROM public.v_job_cost_events_legacy WHERE job_id='00000000-0000-0000-0000-00000000e701';
 IF a<>b OR a<>1 OR x IS DISTINCT FROM y OR x<>50 THEN RAISE EXCEPTION 'P2-01.7: switch off differs from legacy'; END IF;
 IF EXISTS((SELECT to_jsonb(e)-'cost_line_id'-'cost_kind' FROM public.v_job_cost_events e
 WHERE job_id='00000000-0000-0000-0000-00000000e701') EXCEPT ALL
 (SELECT to_jsonb(g) FROM public.v_job_cost_events_legacy g WHERE job_id='00000000-0000-0000-0000-00000000e701')) THEN
  RAISE EXCEPTION 'P2-01.7: legacy field changed';
 END IF;
END $off$;
-- A missing flag is off too, with the same real fixture row.
DELETE FROM public.feature_flags WHERE flag_name='job_cost_events_from_cost_lines_v1';
DO $missing$ BEGIN
 IF (SELECT count(*) FROM public.v_job_cost_events WHERE job_id='00000000-0000-0000-0000-00000000e701')<>1
 OR (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE job_id='00000000-0000-0000-0000-00000000e701')<>50 THEN
  RAISE EXCEPTION 'P2-01.7: missing switch must read legacy'; END IF;
END $missing$;
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_cost_events_from_cost_lines_v1',false);
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('00000000-0000-0000-0000-00000000e703','00000000-0000-0000-0000-000000000001','ZZTEST-COST-CREDIT','fencing','accepted'),
 ('00000000-0000-0000-0000-00000000e704','00000000-0000-0000-0000-000000000001','ZZTEST-COST-LABOUR','fencing','accepted');
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_type,status,sub_total,total,invoice_date,job_id,line_items,raw_json)
VALUES('00000000-0000-0000-0000-000000000001','ZZTEST-CREDIT-BILL','ACCPAY','AUTHORISED',200,220,'2026-11-17',
 '00000000-0000-0000-0000-00000000e703',
 '[{"LineItemID":"ZZTEST-L1","Description":"Materials","AccountCode":"305","LineAmount":200,"TaxAmount":20}]',
 '{"LineAmountTypes":"Exclusive","AmountCredited":22,"CreditNotes":[{"CreditNoteID":"ZZTEST-CREDIT","AppliedAmount":22}]}');
INSERT INTO public.xero_supplier_credit_notes(org_id,xero_credit_note_id,credit_note_type,credit_note_number,
 credit_note_date,status,sub_total,total_tax,total,allocations_returned,raw_json)
VALUES('00000000-0000-0000-0000-000000000001','ZZTEST-CREDIT','ACCPAYCREDIT','ZZTEST-CN','2026-11-17','AUTHORISED',20,2,22,true,'{}');
INSERT INTO public.users(id,org_id,name,role)
VALUES('00000000-0000-0000-0000-00000000e740','00000000-0000-0000-0000-000000000001','ZZTEST trade','trade');
INSERT INTO public.trade_invoices(id,org_id,user_id,week_start,status,subtotal_ex,gst,total_inc,invoice_number,gst_on,super_rate,super_amount,gross_earned,net_pay)
VALUES('00000000-0000-0000-0000-00000000e741','00000000-0000-0000-0000-000000000001',
 '00000000-0000-0000-0000-00000000e740','2026-11-16','approved',160,0,160,'ZZTEST-TRADE',false,0.12,19.20,160,140.80);
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,description,line_total_ex,line_date)
VALUES('00000000-0000-0000-0000-00000000e742','00000000-0000-0000-0000-00000000e741',
 '00000000-0000-0000-0000-00000000e704','ZZTEST-COST-LABOUR','labour','Labour',160,'2026-11-17');
CREATE FUNCTION pg_temp.assert_legacy(label text) RETURNS void LANGUAGE plpgsql AS $parity$
BEGIN
 IF EXISTS(
  (SELECT to_jsonb(e)-'cost_line_id'-'cost_kind' FROM public.v_job_cost_events e
    WHERE job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-COST-%')
   EXCEPT ALL SELECT to_jsonb(g) FROM public.v_job_cost_events_legacy g
    WHERE job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-COST-%'))
  UNION ALL
  (SELECT to_jsonb(g) FROM public.v_job_cost_events_legacy g
    WHERE job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-COST-%')
   EXCEPT ALL SELECT to_jsonb(e)-'cost_line_id'-'cost_kind' FROM public.v_job_cost_events e
    WHERE job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-COST-%'))
 ) THEN RAISE EXCEPTION 'P2-01.7: exact legacy rows differ (%)',label; END IF;
END $parity$;
DO $fixtures$ BEGIN
 IF (SELECT count(*) FROM public.v_job_cost_events_legacy WHERE job_id='00000000-0000-0000-0000-00000000e703')<>2
 OR NOT EXISTS(SELECT 1 FROM public.v_job_cost_events_legacy WHERE job_id='00000000-0000-0000-0000-00000000e703' AND source='supplier_credit')
 OR (SELECT count(*) FROM public.v_job_cost_events_legacy WHERE job_id='00000000-0000-0000-0000-00000000e704' AND source='trade_line' AND amount_ex=160)<>1 THEN
  RAISE EXCEPTION 'P2-01.7: credit and labour fixtures must exercise real legacy rows'; END IF;
END $fixtures$;
SELECT pg_temp.assert_legacy('switch off, credit and labour');
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_type,status,sub_total,total,invoice_date,job_id,line_items)
VALUES('00000000-0000-0000-0000-000000000001','ZZTEST-LEGACY-BILL','ACCPAY','AUTHORISED',120,132,'2026-11-17',
 '00000000-0000-0000-0000-00000000e701','[]');
-- Follow-up 25 regression: switch on, zero lines returns the legacy rows.
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_events_from_cost_lines_v1';
DO $empty$ BEGIN
 IF EXISTS(SELECT 1 FROM public.job_cost_lines) THEN
  RAISE EXCEPTION 'P2-01.7: zero-line fixture is not empty'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE document_id='ZZTEST-LEGACY-BILL') THEN
  RAISE EXCEPTION 'P2-01.7: switch on, zero lines returns the legacy rows'; END IF;
END $empty$;
SELECT pg_temp.assert_legacy('switch on, zero lines');
-- An unreadable line source must not affect a not-yet-cut-over reader.
CREATE FUNCTION pg_temp.line_read_failed() RETURNS boolean LANGUAGE plpgsql AS $failed$
BEGIN RAISE EXCEPTION 'ZZTEST line source unavailable'; END $failed$;
DO $unavailable$ DECLARE original text; BEGIN
 original:=pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true);
 EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS SELECT g.*,NULL::uuid cost_line_id,NULL::text cost_kind FROM public.v_job_cost_events_legacy g WHERE pg_temp.line_read_failed()';
 PERFORM pg_temp.assert_legacy('line read unavailable before cutover');
 EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS '||original;
END $unavailable$;
DELETE FROM public.xero_invoices WHERE xero_invoice_id='ZZTEST-LEGACY-BILL';
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,
 event_source,event_source_id,event_lane_detail,event_match_method,event_confidence,document_date,order_kind,order_id) VALUES
 ('00000000-0000-0000-0000-00000000e720','00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill','ZZTEST-BILL','1','materials',1000,'split','fixture',
 'supplier_bill','ZZTEST-SOURCE','supplier','job_id','high','2026-11-17','purchase_order','00000000-0000-0000-0000-00000000e710');
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex) VALUES
 ('00000000-0000-0000-0000-00000000e720',1,'job','00000000-0000-0000-0000-00000000e701','materials',600),
 ('00000000-0000-0000-0000-00000000e720',2,'job','00000000-0000-0000-0000-00000000e702','materials',300),
 ('00000000-0000-0000-0000-00000000e720',3,'overhead',NULL,'materials',100);
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,not_counted_reason,source_hash) VALUES
 ('00000000-0000-0000-0000-00000000e721','00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill','ZZTEST-NOT-COUNTED','1','materials',100,NULL,'document_not_live','fixture');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.assert_legacy('switch on, partial backfill');
-- An office edit during the incomplete backfill is read immediately from legacy.
UPDATE public.trade_invoice_lines SET line_total_ex=170 WHERE id='00000000-0000-0000-0000-00000000e742';
SELECT pg_temp.assert_legacy('office edit before cutover');
UPDATE public.trade_invoice_lines SET line_total_ex=160 WHERE id='00000000-0000-0000-0000-00000000e742';
-- A completion assertion without all three backfills and trade install refuses.
DO $incomplete$ BEGIN
 BEGIN
  UPDATE public.job_cost_events_cutover SET completed_at=now();
  RAISE EXCEPTION 'P2-01.7: incomplete cutover accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $incomplete$;
SELECT pg_temp.assert_legacy('refused cutover retry');
SET CONSTRAINTS ALL DEFERRED;
-- Model the historical backfill for TWO complete real source jobs. The 23
-- fields come from real legacy bill/credit/trade paths, never a stand-in view.
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,
 event_source,event_source_id,event_lane_detail,event_match_method,event_confidence,document_date,
 document_number,document_status,party_kind,party_id,party_name,paid,paid_on,is_actual,description,hours,account_code,business_unit,incomplete_invoice)
SELECT md5(g.source_id)::uuid,'00000000-0000-0000-0000-000000000001',
 CASE g.source WHEN 'trade_line' THEN 'trade_line' WHEN 'supplier_credit' THEN 'supplier_credit' ELSE 'supplier_bill' END,
 CASE g.source WHEN 'trade_line' THEN 'trade_invoice' WHEN 'supplier_credit' THEN 'xero_credit_note' ELSE 'xero_bill' END,
 g.document_id,g.source_id,g.lane,g.amount_ex,'on_job','ZZTEST-backfill',g.source,g.source_id,g.lane_detail,g.match_method,g.confidence,g.event_date,
 g.document_number,g.document_status,g.party_kind,g.party_id,g.party,g.paid,g.paid_on,g.is_actual,g.description,g.hours,g.account_code,g.business_unit,g.incomplete_invoice
FROM public.v_job_cost_events_legacy g WHERE g.job_id IN
 ('00000000-0000-0000-0000-00000000e703','00000000-0000-0000-0000-00000000e704');
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
SELECT md5(g.source_id)::uuid,1,'job',g.job_id,g.lane,g.amount_ex
FROM public.v_job_cost_events_legacy g WHERE g.job_id IN
 ('00000000-0000-0000-0000-00000000e703','00000000-0000-0000-0000-00000000e704');
SET CONSTRAINTS ALL IMMEDIATE;
-- TEST ONLY: the release migration has no path that stamps these coordinates.
UPDATE public.job_cost_events_cutover SET bills_backfilled_at=now(),credits_backfilled_at=now(),trade_backfilled_at=now();
SELECT pg_temp.assert_legacy('all backfills, trade triggers absent');
UPDATE public.job_cost_events_cutover SET trade_triggers_installed_at=now(),completed_at=now();
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_cost_events_from_cost_lines_v1';
SELECT pg_temp.assert_legacy('ready marker, switch off');
DELETE FROM public.feature_flags WHERE flag_name='job_cost_events_from_cost_lines_v1';
SELECT pg_temp.assert_legacy('ready marker, switch missing');
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_cost_events_from_cost_lines_v1',true);
DO $on$ BEGIN
 IF (SELECT count(*) FROM public.v_job_cost_events WHERE cost_line_id='00000000-0000-0000-0000-00000000e720')<>2
 OR (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE job_id='00000000-0000-0000-0000-00000000e701')<>600
 OR (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE job_id='00000000-0000-0000-0000-00000000e702')<>300
 OR EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE cost_line_id='00000000-0000-0000-0000-00000000e721')
 OR EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='00000000-0000-0000-0000-00000000e710') THEN
  RAISE EXCEPTION 'P2-01.7: split or commitment closure';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='ZZTEST-SOURCE:part1' AND cost_kind='supplier_bill' AND amount_ex=600)
 OR NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source_id='ZZTEST-SOURCE:part2' AND amount_ex=300) THEN
  RAISE EXCEPTION 'P2-01.7: part identity';
 END IF;
END $on$;
DO $equal$ BEGIN
 IF EXISTS(
  (SELECT to_jsonb(e)-'cost_line_id'-'cost_kind' FROM public.v_job_cost_events e
   WHERE job_id IN ('00000000-0000-0000-0000-00000000e703','00000000-0000-0000-0000-00000000e704')
   EXCEPT ALL SELECT to_jsonb(g) FROM public.v_job_cost_events_legacy g
   WHERE job_id IN ('00000000-0000-0000-0000-00000000e703','00000000-0000-0000-0000-00000000e704'))
  UNION ALL
  (SELECT to_jsonb(g) FROM public.v_job_cost_events_legacy g
   WHERE job_id IN ('00000000-0000-0000-0000-00000000e703','00000000-0000-0000-0000-00000000e704')
   EXCEPT ALL SELECT to_jsonb(e)-'cost_line_id'-'cost_kind' FROM public.v_job_cost_events e
   WHERE job_id IN ('00000000-0000-0000-0000-00000000e703','00000000-0000-0000-0000-00000000e704'))
 ) THEN RAISE EXCEPTION 'P2-01.7: credit and labour line rows differ'; END IF;
END $equal$;
-- A populated, bounded plan proof, no forced planner settings or index names.
SAVEPOINT plan_fixture;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash)
SELECT ('93000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill','ZZTEST-PLAN-'||n,'1','materials',1,'on_job','fixture'
FROM generate_series(1,12000) n;
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
SELECT ('93000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,1,'job',
 '00000000-0000-0000-0000-00000000e702','materials',1 FROM generate_series(1,12000) n;
SET CONSTRAINTS ALL IMMEDIATE;
ANALYZE public.job_cost_lines;
ANALYZE public.job_cost_line_parts;
DO $plan$ DECLARE plan jsonb; relation text; BEGIN
 EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM public.v_job_cost_events WHERE job_id=''00000000-0000-0000-0000-00000000e701'''
 INTO plan;
 FOREACH relation IN ARRAY ARRAY['job_cost_lines','job_cost_line_parts'] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == $rel)',jsonb_build_object('rel',relation)) node
   WHERE node->>'Node Type'='Seq Scan' AND (node->>'Actual Loops')::numeric>0)
  OR NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == $rel)',jsonb_build_object('rel',relation)) node
   WHERE node->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan') AND (node->>'Actual Loops')::numeric>0)
  OR EXISTS(SELECT 1 FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == $rel)',jsonb_build_object('rel',relation)) node
   WHERE (node->>'Actual Loops')::numeric>0 AND
    coalesce((node->>'Actual Rows')::numeric,0)+coalesce((node->>'Rows Removed by Filter')::numeric,0)>10) THEN
   RAISE EXCEPTION 'P2-01.7: expected bounded indexed read on %: %',relation,plan;
  END IF;
 END LOOP;
 IF (plan->0->'Plan'->>'Actual Rows')::int<>1 THEN
  RAISE EXCEPTION 'P2-01.7: plan fixture returned unexpected rows'; END IF;
END $plan$;
ROLLBACK TO plan_fixture;
-- A non-counted order line reopens the unchanged PO branch.
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM public.job_cost_line_parts WHERE line_id='00000000-0000-0000-0000-00000000e720';
UPDATE public.job_cost_lines SET state=NULL,not_counted_reason='document_not_live' WHERE id='00000000-0000-0000-0000-00000000e720';
SET CONSTRAINTS ALL IMMEDIATE;
DO $po$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.v_job_cost_events WHERE source='po_committed' AND amount_ex=50 AND cost_line_id IS NULL AND cost_kind IS NULL
 AND source_id='00000000-0000-0000-0000-00000000e710') THEN RAISE EXCEPTION 'P2-01.7: PO must reopen'; END IF;
END $po$;
-- Explicit install only; marks must include departed and receiving jobs.
SELECT public.install_job_cost_events_from_cost_lines();
SELECT public.install_job_cost_events_from_cost_lines();
DELETE FROM public.job_profit_dirty;
UPDATE public.job_cost_events_cutover SET completed_at=NULL;
SELECT pg_temp.assert_legacy('marker withdrawn');
DO $cutover_marks$ BEGIN
 IF EXISTS(SELECT id FROM public.jobs EXCEPT SELECT job_id FROM public.job_profit_dirty WHERE reason='switch') THEN
  RAISE EXCEPTION 'P2-01.7: cutover invalidation'; END IF;
END $cutover_marks$;
DELETE FROM public.job_cost_events_cutover;
SELECT pg_temp.assert_legacy('marker missing');
CREATE OR REPLACE FUNCTION public.job_mark_changed(p_job_id uuid,p_source text) RETURNS void LANGUAGE sql AS 'SELECT NULL::void';
DELETE FROM public.job_profit_dirty;
SET CONSTRAINTS ALL DEFERRED;
UPDATE public.job_cost_lines SET state='on_job',not_counted_reason=NULL,amount_ex=1000 WHERE id='00000000-0000-0000-0000-00000000e720';
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex) VALUES
 ('00000000-0000-0000-0000-00000000e720',1,'job','00000000-0000-0000-0000-00000000e701','materials',1000);
DELETE FROM public.job_profit_dirty;
UPDATE public.job_cost_line_parts SET job_id='00000000-0000-0000-0000-00000000e702' WHERE line_id='00000000-0000-0000-0000-00000000e720';
DO $marks$ BEGIN
 IF (SELECT count(*) FROM public.job_profit_dirty WHERE reason='cost_line' AND job_id IN
 ('00000000-0000-0000-0000-00000000e701','00000000-0000-0000-0000-00000000e702'))<>2 THEN
  RAISE EXCEPTION 'P2-01.7: old and new job marks'; END IF;
END $marks$;
DELETE FROM public.job_profit_dirty;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_cost_events_from_cost_lines_v1';
DO $switch$ BEGIN
 IF EXISTS(SELECT id FROM public.jobs EXCEPT SELECT job_id FROM public.job_profit_dirty WHERE reason='switch') THEN
  RAISE EXCEPTION 'P2-01.7: switch invalidation'; END IF;
END $switch$;
-- Failed optional page marking cannot fail the cost write.
CREATE OR REPLACE FUNCTION public.job_mark_changed(p_job_id uuid,p_source text) RETURNS void LANGUAGE plpgsql AS $fail$ BEGIN RAISE EXCEPTION 'fixture unavailable'; END $fail$;
UPDATE public.job_cost_line_parts SET lane='other' WHERE line_id='00000000-0000-0000-0000-00000000e720';
SELECT public.remove_job_cost_events_from_cost_lines();
SELECT public.remove_job_cost_events_from_cost_lines();
DO $unchanged$ BEGIN
 IF pg_get_viewdef('public.v_job_profit'::regclass,true)<>(SELECT def FROM profit_definition) THEN
  RAISE EXCEPTION 'P2-01.7: profit definition changed'; END IF;
END $unchanged$;
SELECT 'PASS P2-01.7: zero-line fallback, cutover guard, credit/labour exact rows, bounded indexed plan, split, PO closure, marks, isolated failure';
ROLLBACK;
