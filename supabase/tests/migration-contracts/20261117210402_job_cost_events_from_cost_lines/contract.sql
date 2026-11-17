BEGIN;
SET LOCAL TimeZone='UTC';
CREATE TEMP TABLE profit_definition AS SELECT pg_get_viewdef('public.v_job_profit'::regclass,true) def;
DO $schema$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN
 ('job_cost_events_parts_dirty','job_cost_events_lines_dirty','job_cost_events_switch_dirty')) THEN
  RAISE EXCEPTION 'P2-01.7: triggers installed on merge';
 END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_events_from_cost_lines_v1' AND enabled) THEN
  RAISE EXCEPTION 'P2-01.7: switch on at merge';
 END IF;
 IF has_table_privilege('authenticated','public.v_job_cost_events_lines','SELECT')
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
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_events_from_cost_lines_v1';
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
CREATE OR REPLACE FUNCTION public.job_mark_changed(uuid,text) RETURNS void LANGUAGE sql AS 'SELECT';
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
CREATE OR REPLACE FUNCTION public.job_mark_changed(uuid,text) RETURNS void LANGUAGE plpgsql AS $fail$ BEGIN RAISE EXCEPTION 'fixture unavailable'; END $fail$;
UPDATE public.job_cost_line_parts SET lane='other' WHERE line_id='00000000-0000-0000-0000-00000000e720';
SELECT public.remove_job_cost_events_from_cost_lines();
SELECT public.remove_job_cost_events_from_cost_lines();
DO $unchanged$ BEGIN
 IF pg_get_viewdef('public.v_job_profit'::regclass,true)<>(SELECT def FROM profit_definition) THEN
  RAISE EXCEPTION 'P2-01.7: profit definition changed'; END IF;
END $unchanged$;
SELECT 'PASS P2-01.7: switch parity, split, excluded line, PO closure, identity, marks and isolated failure';
ROLLBACK;
