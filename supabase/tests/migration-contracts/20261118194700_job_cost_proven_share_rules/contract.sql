-- P2-13.2 follow-up contract (#1616). All ids, job numbers and figures are ZZTEST fixtures.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '120s';

-- Rule 17: re-apply prerequisites if an earlier contract dropped them, and
-- re-apply this migration over either 20261118124326 or itself (leaving a
-- deliberate break-contract body untouched so the behaviour check fails on it).
SELECT to_regprocedure('public.job_cost_proven_share(uuid[])') IS NULL AS zz_need_base \gset
\if :zz_need_base
\ir ../../../migrations/20261118124326_job_cost_proven_share.sql
\endif
SELECT to_regclass('public.supplier_credit_drafts') IS NULL AS zz_need_drafts \gset
\if :zz_need_drafts
\ir ../../../migrations/20261118114119_supplier_credit_drafts.sql
\endif
SELECT coalesce(
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.job_cost_proven_share(uuid[])'))
    IN ('317bbcbdc920b45a9752ba25d07d413f', 'b7e6c59ac5be46981791590c2c206c73')
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.job_profit_store_proven_share(uuid[])'))
    IN ('72a8fbd89744351d172f7552d2bc7d3f', 'a2eec1f3e0954992b90927f40e99e6f3'),
  false) AS zz_reapply_ok \gset
\if :zz_reapply_ok
\ir ../../../migrations/20261118194700_job_cost_proven_share_rules.sql
\endif

CREATE FUNCTION pg_temp.check_share_rules(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'share_rules_contract: %', label; END IF;
END $$;

SELECT pg_temp.check_share_rules(
  NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_items'::regclass AND tgname='job_profit_reconcile_item_changed')
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_refresh_many(uuid[])'::regprocedure)='5bf1ad820296062f851290ae4d750426',
  'inert on merge');

SELECT pg_temp.check_share_rules(
  has_function_privilege('service_role','public.job_cost_proven_share(uuid[])','execute')
  AND NOT has_function_privilege('authenticated','public.job_cost_proven_share(uuid[])','execute')
  AND NOT has_function_privilege('anon','public.job_cost_proven_share(uuid[])','execute')
  AND NOT has_function_privilege('service_role','public.job_profit_store_proven_share(uuid[])','execute')
  AND NOT has_function_privilege('service_role','public.job_profit_install_proven_share()','execute'),
  'service and director boundaries');

CREATE FUNCTION pg_temp.jf(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ZZTEST-share-fu-job-'||n)::uuid $$;
CREATE FUNCTION pg_temp.lf(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ZZTEST-share-fu-line-'||n)::uuid $$;

INSERT INTO public.organisations(id,name) VALUES(pg_temp.jf(0),'ZZTEST-FU');
INSERT INTO public.jobs(id,org_id,type,status,job_number,metadata,pricing_json,created_at)
  SELECT pg_temp.jf(n),pg_temp.jf(0),'fencing','complete','ZZTEST-SHFU-'||n,'{}','{}','2026-06-01'
  FROM generate_series(1,14) n;

CREATE FUNCTION pg_temp.add_fu_line(n int,j int,doc text,amount numeric,who text,kind text DEFAULT 'xero_bill',line_no int DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,line_no,lane,
    amount_ex,state,decided_by_kind,source_hash)
  VALUES(pg_temp.lf(n),pg_temp.jf(0),
    CASE kind WHEN 'xero_credit_note' THEN 'supplier_credit' WHEN 'trade_invoice' THEN 'trade_line' ELSE 'supplier_bill' END,
    kind,doc,'line-'||n,line_no,'materials',amount,
    CASE WHEN j IS NULL THEN 'needs_person' ELSE 'on_job' END,who,'ZZTEST');
  IF j IS NOT NULL THEN
    INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
    VALUES(pg_temp.lf(n),1,'job',pg_temp.jf(j),'materials',amount);
  END IF;
END $$;

CREATE FUNCTION pg_temp.raise_fu_item(doc text,j int,kind text) RETURNS uuid LANGUAGE sql AS $$
  SELECT public.reconcile_item_raise(kind,'cost_document',doc,ARRAY[pg_temp.jf(j)],NULL,'{"reason":"needs_person"}','contract')
$$;

-- Job 1: normal valid share (proven 1500, clues 500, priced pending 400 -> 62.50, reason NULL)
SELECT pg_temp.add_fu_line(1,1,'fu-person',1000,'person');
SELECT pg_temp.add_fu_line(2,1,'fu-keys',500,'matcher');
SELECT pg_temp.add_fu_line(3,1,'fu-clues',500,'legacy');
SELECT pg_temp.add_fu_line(4,NULL,'fu-pending-priced',400,'legacy');
INSERT INTO public.match_clues(org_id,subject_kind,subject_id,run_id,clue_code,class,family,root,outcome,job_id,names_one,rule_version)
  SELECT pg_temp.jf(0),'cost_document','xero_bill:fu-keys',pg_temp.jf(0),code,'key','test',code,'job',pg_temp.jf(1),true,'v1'
  FROM (VALUES ('job_number'),('order_number')) v(code);
WITH dec AS (
  INSERT INTO public.reconcile_decisions(org_id,subject_kind,subject_id,action,clue_ids,"by")
  SELECT org_id,subject_kind,subject_id,'place',array_agg(id ORDER BY id),'matcher:v1'
  FROM public.match_clues WHERE org_id=pg_temp.jf(0) GROUP BY org_id,subject_kind,subject_id
  RETURNING id,subject_id
) UPDATE public.job_cost_lines l SET decision_id=dec.id FROM dec
  WHERE l.org_id=pg_temp.jf(0) AND dec.subject_id=l.document_kind||':'||l.document_id;
SELECT pg_temp.raise_fu_item('xero_bill:fu-pending-priced',1,'bill');

-- Job 2: zero cost (no lines at all) -> share_no_cost, no review
-- Job 3: placed proven bill +100 and follower credit -100 cancelling to 0 -> share_no_cost, no review
SELECT pg_temp.add_fu_line(5,3,'fu-cancel-bill',100,'person');
SELECT pg_temp.add_fu_line(6,3,'fu-cancel-credit',-100,'source','xero_credit_note');
UPDATE public.job_cost_lines SET follows_line_id=pg_temp.lf(5) WHERE id=pg_temp.lf(6);

-- Job 4: open credit where proven > total (proven 100, open credit -99 -> total 1) -> share_unknown_credit_open
SELECT pg_temp.add_fu_line(7,4,'fu-oc1-bill',100,'person');
SELECT pg_temp.add_fu_line(8,NULL,'fu-oc1-credit',-99,'source','xero_credit_note');
SELECT pg_temp.raise_fu_item('xero_credit_note:fu-oc1-credit',4,'credit');

-- Job 5: open credit where total > 0 and 0 <= proven <= total (proven 100, clues 200, open credit -50 -> total 250)
-- Must STILL be share_unknown_credit_open with null pct and go to a person.
SELECT pg_temp.add_fu_line(9,5,'fu-oc2-proven',100,'person');
SELECT pg_temp.add_fu_line(10,5,'fu-oc2-clues',200,'legacy');
SELECT pg_temp.add_fu_line(11,NULL,'fu-oc2-credit',-50,'source','xero_credit_note');
SELECT pg_temp.raise_fu_item('xero_credit_note:fu-oc2-credit',5,'credit');

-- Job 6: unpriced open credit (amount_ex NULL) alongside placed cost and unpriced bill -> share_unknown_credit_open wins over partial
SELECT pg_temp.add_fu_line(12,6,'fu-oc3-proven',100,'person');
SELECT pg_temp.add_fu_line(13,NULL,'fu-oc3-credit-null',NULL,'source','xero_credit_note');
SELECT pg_temp.add_fu_line(14,NULL,'fu-oc3-bill-null',NULL,'legacy');
SELECT pg_temp.raise_fu_item('xero_credit_note:fu-oc3-credit-null',6,'credit');
SELECT pg_temp.raise_fu_item('xero_bill:fu-oc3-bill-null',6,'bill');

-- Job 7: proposed supplier credit draft (credit_note_proposed on supplier_credit_drafts) -> share_unknown_credit_open
SELECT pg_temp.add_fu_line(15,7,'fu-oc4-proven',100,'person');
INSERT INTO public.supplier_credit_drafts(id,org_id,supplier_name,credit_number,matched_job_id,state)
VALUES(pg_temp.lf(90),pg_temp.jf(0),'ZZTEST Supplier','ZZTEST-CN-1',pg_temp.jf(7),'proposed');
SELECT public.reconcile_item_raise('credit_note_proposed','supplier_credit_drafts',pg_temp.lf(90)::text,
  ARRAY[pg_temp.jf(7)],NULL,'{"reason":"credit_proposed"}','phase3:books');

-- Job 8: out-of-range share above 100% (proven 200, placed credit on clues -50 -> total 150) -> share_out_of_range
SELECT pg_temp.add_fu_line(16,8,'fu-oor1-proven',200,'person');
SELECT pg_temp.add_fu_line(17,8,'fu-oor1-clues',100,'legacy');
SELECT pg_temp.add_fu_line(18,8,'fu-oor1-credit',-150,'source','xero_credit_note');
UPDATE public.job_cost_lines SET follows_line_id=pg_temp.lf(17) WHERE id=pg_temp.lf(18);

-- Job 9: out-of-range share below 0% (proven -50, clues 200 -> total 150) -> share_out_of_range
SELECT pg_temp.add_fu_line(19,9,'fu-oor2-proven-bill',50,'person');
SELECT pg_temp.add_fu_line(20,9,'fu-oor2-proven-credit',-100,'person','xero_credit_note');
SELECT pg_temp.add_fu_line(21,9,'fu-oor2-clues',200,'legacy');

-- Job 10: out-of-range nonpositive denominator with non-zero buckets (proven 100, clues -100 -> total 0) -> share_out_of_range
SELECT pg_temp.add_fu_line(22,10,'fu-oor3-proven',100,'person');
SELECT pg_temp.add_fu_line(23,10,'fu-oor3-clues',-100,'legacy','xero_credit_note');

-- Job 11: out-of-range negative total (proven 0, clues -40 -> total -40) -> share_out_of_range
SELECT pg_temp.add_fu_line(24,11,'fu-oor4-clues',-40,'legacy','xero_credit_note');

-- Job 12: partial result with single unpriced open bill (amount_ex NULL) -> 'partial', cost_unknown_ex NULL, pct NULL, no review
SELECT pg_temp.add_fu_line(25,NULL,'fu-part1-null',NULL,'legacy');
SELECT pg_temp.raise_fu_item('xero_bill:fu-part1-null',12,'bill');

-- Job 13: partial-sum case with placed costs + priced open bill (400) + unpriced open bill (NULL)
-- -> cost_unknown_items = 2, cost_unknown_ex = 400 (partial sum), pct NULL, reason 'partial', no review
SELECT pg_temp.add_fu_line(26,13,'fu-part2-proven',1000,'person');
SELECT pg_temp.add_fu_line(27,13,'fu-part2-clues',500,'legacy');
SELECT pg_temp.add_fu_line(28,NULL,'fu-part2-priced',400,'legacy');
SELECT pg_temp.add_fu_line(29,NULL,'fu-part2-unpriced',NULL,'legacy');
SELECT pg_temp.raise_fu_item('xero_bill:fu-part2-priced',13,'bill');
SELECT pg_temp.raise_fu_item('xero_bill:fu-part2-unpriced',13,'bill');

-- Job 14: partial-sum case on one open multi-line document (250 + NULL)
-- -> cost_unknown_items = 1, cost_unknown_ex = 250, pct NULL, reason 'partial', no review
SELECT pg_temp.add_fu_line(30,NULL,'fu-part3-doc',250,'legacy','xero_bill',1);
SELECT pg_temp.add_fu_line(31,NULL,'fu-part3-doc',NULL,'legacy','xero_bill',2);
SELECT pg_temp.raise_fu_item('xero_bill:fu-part3-doc',14,'bill');

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- Calculation checks for each case
SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (1500::numeric,500::numeric,400::numeric,1,62.50::numeric,NULL::text),
  'normal valid share') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(1)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (0::numeric,0::numeric,0::numeric,0,NULL::numeric,'share_no_cost'::text),
  'zero cost job is share_no_cost') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(2)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (0::numeric,0::numeric,0::numeric,0,NULL::numeric,'share_no_cost'::text),
  'cancelled-to-zero bucket is share_no_cost') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(3)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (100::numeric,-99::numeric,1,NULL::numeric,'share_unknown_credit_open'::text),
  'open credit with proven > total') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(4)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (100::numeric,200::numeric,-50::numeric,1,NULL::numeric,'share_unknown_credit_open'::text),
  'open credit with in-range ratio still blocks pct and marks credit_open') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(5)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (100::numeric,NULL::numeric,2,NULL::numeric,'share_unknown_credit_open'::text),
  'unpriced open credit takes precedence over partial') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(6)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (100::numeric,0::numeric,0,NULL::numeric,'share_unknown_credit_open'::text),
  'proposed credit draft marks share_unknown_credit_open') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(7)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (200::numeric,-50::numeric,NULL::numeric,'share_out_of_range'::text),
  'out-of-range share above 100%') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(8)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (-50::numeric,200::numeric,NULL::numeric,'share_out_of_range'::text),
  'out-of-range share below 0%') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(9)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (100::numeric,-100::numeric,NULL::numeric,'share_out_of_range'::text),
  'zero net total with opposite buckets is share_out_of_range') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(10)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (0::numeric,-40::numeric,NULL::numeric,'share_out_of_range'::text),
  'negative net total is share_out_of_range') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(11)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (0::numeric,0::numeric,NULL::numeric,1,NULL::numeric,'partial'::text),
  'single unpriced open item is partial with null unknown amount') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(12)]);

SELECT pg_temp.check_share_rules(
  (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (1000::numeric,500::numeric,400::numeric,2,NULL::numeric,'partial'::text),
  'mixed priced and unpriced open items store partial sum and label partial') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(13)]);

SELECT pg_temp.check_share_rules(
  (cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
  IS NOT DISTINCT FROM (250::numeric,1,NULL::numeric,'partial'::text),
  'same-document priced and unpriced lines store partial sum and label partial') FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(14)]);

SELECT pg_temp.check_share_rules(
  NOT EXISTS(SELECT FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(-1)])),
  'missing job returns empty set');

-- Install and refresh all 14 jobs in one batch: verify review routing
SELECT public.job_profit_install_proven_share();
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_profit_refresh_v1';
SET LOCAL statement_timeout = '120s';
SELECT public.job_profit_refresh_many(ARRAY(SELECT pg_temp.jf(n) FROM generate_series(1,14) n));

-- share_no_cost raises NO review
SELECT pg_temp.check_share_rules(
  NOT EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share'
    AND job_ids && ARRAY[pg_temp.jf(2),pg_temp.jf(3)]),
  'share_no_cost raises no review');

-- partial raises NO review
SELECT pg_temp.check_share_rules(
  NOT EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share'
    AND job_ids && ARRAY[pg_temp.jf(12),pg_temp.jf(13),pg_temp.jf(14)]),
  'partial raises no review');

-- normal valid share raises NO review
SELECT pg_temp.check_share_rules(
  NOT EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share'
    AND job_ids && ARRAY[pg_temp.jf(1)]),
  'valid share raises no review');

-- ONLY open credit (4..7) and out-of-range share (8..11) raise reviews, with matching reason and no amounts in evidence
SELECT pg_temp.check_share_rules(
  (SELECT count(*) FROM public.reconcile_items WHERE kind='job_cost_share' AND status='open'
    AND job_ids && ARRAY(SELECT pg_temp.jf(n) FROM generate_series(1,14) n))=8
  AND (SELECT count(*) FROM public.reconcile_items WHERE kind='job_cost_share' AND status='open'
    AND job_ids && ARRAY[pg_temp.jf(4),pg_temp.jf(5),pg_temp.jf(6),pg_temp.jf(7)]
    AND reason='share_unknown_credit_open' AND amount_ex IS NULL
    AND evidence - ARRAY['reason','facts_hash'] = '{}'::jsonb)=4
  AND (SELECT count(*) FROM public.reconcile_items WHERE kind='job_cost_share' AND status='open'
    AND job_ids && ARRAY[pg_temp.jf(8),pg_temp.jf(9),pg_temp.jf(10),pg_temp.jf(11)]
    AND reason='share_out_of_range' AND amount_ex IS NULL
    AND evidence - ARRAY['reason','facts_hash'] = '{}'::jsonb)=4,
  'only open credit and out-of-range share go to a person');

-- Idempotent repeat refresh reports 0 changes and preserves reviews
SET LOCAL statement_timeout = '120s';
SELECT pg_temp.check_share_rules(
  (public.job_profit_refresh_many(ARRAY(SELECT pg_temp.jf(n) FROM generate_series(1,14) n))->>'changed')::int=0,
  'idempotent refresh');

-- Transition 1: open credit (job 5) placed on clues as -250 -> transitions to share_out_of_range, updating review reason in place
SELECT public.reconcile_item_withdraw('credit','cost_document','xero_credit_note:fu-oc2-credit','placed_on_clues');
UPDATE public.job_cost_lines SET state='on_job',decided_by_kind='legacy',amount_ex=-250 WHERE id=pg_temp.lf(11);
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
VALUES(pg_temp.lf(11),1,'job',pg_temp.jf(5),'materials',-250);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL statement_timeout = '120s';
SELECT public.job_profit_refresh_many(ARRAY[pg_temp.jf(5)]);
SELECT pg_temp.check_share_rules(
  (SELECT proven_share_reason FROM public.job_profit_stored WHERE job_id=pg_temp.jf(5))='share_out_of_range'
  AND (SELECT count(*) FROM public.reconcile_items WHERE kind='job_cost_share' AND subject_id=pg_temp.jf(5)::text
       AND status='open' AND reason='share_out_of_range')=1,
  'transition from credit_open to out_of_range updates open review');

-- Transition 2: out-of-range job (job 11) has its negative line removed -> becomes share_no_cost and withdraws review
DELETE FROM public.job_cost_line_parts WHERE line_id=pg_temp.lf(24);
UPDATE public.job_cost_lines SET state=NULL,not_counted_reason='document_not_live' WHERE id=pg_temp.lf(24);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL statement_timeout = '120s';
SELECT public.job_profit_refresh_many(ARRAY[pg_temp.jf(11)]);
SELECT pg_temp.check_share_rules(
  (SELECT proven_share_reason='share_no_cost' AND proven_share_pct IS NULL FROM public.job_profit_stored WHERE job_id=pg_temp.jf(11))
  AND EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share' AND subject_id=pg_temp.jf(11)::text AND status='withdrawn')
  AND NOT EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share' AND subject_id=pg_temp.jf(11)::text AND status='open'),
  'transition to share_no_cost withdraws open review');

-- Transition 3: open-credit job (job 4) withdraws credit and adds unpriced bill -> becomes partial and withdraws review
SELECT public.reconcile_item_withdraw('credit','cost_document','xero_credit_note:fu-oc1-credit','voided');
SELECT pg_temp.add_fu_line(32,NULL,'fu-oc1-now-partial',NULL,'legacy');
SELECT pg_temp.raise_fu_item('xero_bill:fu-oc1-now-partial',4,'bill');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL statement_timeout = '120s';
SELECT public.job_profit_refresh_many(ARRAY[pg_temp.jf(4)]);
SELECT pg_temp.check_share_rules(
  (SELECT proven_share_reason='partial' AND proven_share_pct IS NULL FROM public.job_profit_stored WHERE job_id=pg_temp.jf(4))
  AND EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share' AND subject_id=pg_temp.jf(4)::text AND status='withdrawn')
  AND NOT EXISTS(SELECT FROM public.reconcile_items WHERE kind='job_cost_share' AND subject_id=pg_temp.jf(4)::text AND status='open'),
  'transition to partial withdraws open review');

-- Transition 4: unpriced bill on job 13 gets priced at 100 -> complete sum 500, valid share 1000/2000 = 50.00, reason NULL
UPDATE public.job_cost_lines SET amount_ex=100 WHERE id=pg_temp.lf(29);
SET LOCAL statement_timeout = '120s';
SELECT public.job_profit_refresh_many(ARRAY[pg_temp.jf(13)]);
SELECT pg_temp.check_share_rules(
  (SELECT (cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)
          IS NOT DISTINCT FROM (500::numeric,2,50.00::numeric,NULL::text)
   FROM public.job_profit_stored WHERE job_id=pg_temp.jf(13)),
  'pricing missing item turns partial sum into complete share');

-- Bad path: failed source read raises (never counts as zero or partial), and retry after recovery succeeds
SAVEPOINT zz_read_fault;
ALTER TABLE public.match_clues RENAME TO zztest_share_fu_clues_unavailable;
DO $$ BEGIN
  PERFORM * FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(1)]);
  RAISE EXCEPTION 'read failure returned a measurement';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
ROLLBACK TO zz_read_fault;
SELECT pg_temp.check_share_rules(
  (SELECT proven_share_pct FROM public.job_cost_proven_share(ARRAY[pg_temp.jf(1)]))=62.50,
  'retry after read fault');

-- Office move of a reconcile item enqueues old and new jobs
CREATE TEMP TABLE zz_event_floor AS SELECT coalesce(max(id),0) AS id FROM public.job_profit_change_events;
UPDATE public.reconcile_items SET job_ids=ARRAY[pg_temp.jf(2),pg_temp.jf(2)] WHERE subject_id='xero_bill:fu-pending-priced';
SELECT pg_temp.check_share_rules(
  (SELECT array_agg(job_id ORDER BY job_id) FROM public.job_profit_change_events
   WHERE id>(SELECT id FROM zz_event_floor) AND reason='reconcile_item')=
  (SELECT array_agg(id ORDER BY id) FROM unnest(ARRAY[pg_temp.jf(1),pg_temp.jf(2)]) id),
  'office move marks old and new jobs');

SELECT public.job_profit_remove_proven_share();
SELECT pg_temp.check_share_rules(
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_refresh_many(uuid[])'::regprocedure)='5bf1ad820296062f851290ae4d750426'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_mark(uuid,text)'::regprocedure)='3f3c3d56c36b1721a3c7f808ccfac958'
  AND NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_items'::regclass AND tgname='job_profit_reconcile_item_changed'),
  'director remove restores prior bodies');

-- Rule 16: 3,000-row background plan proof (no Seq Scan, indexed scan, <= 10 rows per table)
SAVEPOINT zz_indexed_plan;
INSERT INTO public.jobs(id,org_id,type,status,job_number)
  SELECT pg_temp.jf(n),pg_temp.jf(0),'fencing','complete','ZZTEST-SHFU-PLAN-'||n FROM generate_series(100,3099) n;
INSERT INTO public.job_cost_lines(id,org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,decided_by_kind,source_hash)
  SELECT pg_temp.lf(n),pg_temp.jf(0),'supplier_bill','xero_bill','fu-plan-'||n,'one','materials',1,
    CASE WHEN n%2=0 THEN 'on_job' ELSE 'needs_person' END,'legacy','ZZTEST' FROM generate_series(100,3099) n;
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,job_id,lane,amount_ex)
  SELECT pg_temp.lf(n),1,'job',pg_temp.jf(n),'materials',1 FROM generate_series(100,3098,2) n;
INSERT INTO public.reconcile_items(org_id,kind,subject_table,subject_id,job_ids,reason,evidence_hash,raised_by)
  SELECT pg_temp.jf(0),'bill','cost_document','xero_bill:fu-plan-'||n,ARRAY[pg_temp.jf(n)],'needs_person','test','contract'
  FROM generate_series(101,3099,2) n;
ANALYZE public.jobs;
ANALYZE public.job_cost_lines;
ANALYZE public.job_cost_line_parts;
ANALYZE public.reconcile_items;
DO $plan$ DECLARE q text; plan jsonb; rel text;
BEGIN
  SELECT prosrc INTO q FROM pg_proc WHERE oid='public.job_cost_proven_share(uuid[])'::regprocedure;
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) '||replace(q,'p_job_ids',format('ARRAY[%L::uuid]',pg_temp.jf(1))) INTO plan;
  FOREACH rel IN ARRAY ARRAY['jobs','job_cost_lines','job_cost_line_parts','reconcile_items'] LOOP
    IF jsonb_path_exists(plan,'$.** ? (@."Relation Name" == $rel && @."Node Type" == "Seq Scan")',jsonb_build_object('rel',rel))
      OR NOT jsonb_path_exists(plan,'$.** ? (@."Relation Name" == $rel && (@."Node Type" == "Index Scan" || @."Node Type" == "Bitmap Heap Scan" || @."Node Type" == "Index Only Scan"))',jsonb_build_object('rel',rel))
      OR jsonb_path_exists(plan,'$.** ? (@."Relation Name" == $rel && @."Actual Rows" > 10)',jsonb_build_object('rel',rel))
    THEN RAISE EXCEPTION 'share_rules_unbounded_plan %',rel; END IF;
  END LOOP;
END $plan$;
ROLLBACK TO zz_indexed_plan;

-- Exact body hashes, Rule 15 collision refusal, and rollback round trip
SELECT pg_temp.check_share_rules(
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_cost_proven_share(uuid[])'::regprocedure)='b7e6c59ac5be46981791590c2c206c73'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_store_proven_share(uuid[])'::regprocedure)='a2eec1f3e0954992b90927f40e99e6f3',
  'installed body hashes');

\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.job_cost_proven_share(p_job_ids uuid[])
RETURNS TABLE(job_id uuid,cost_proven_ex numeric,cost_on_clues_ex numeric,
              cost_unknown_ex numeric,cost_unknown_items integer,proven_share_pct numeric,
              proven_share_reason text)
LANGUAGE sql AS $other$ SELECT NULL::uuid,0::numeric,0::numeric,0::numeric,0,0::numeric,NULL::text WHERE false $other$;
\ir ../../../migrations/20261118194700_job_cost_proven_share_rules.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_calc_apply_error \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.job_profit_store_proven_share(p_job_ids uuid[])
RETURNS void LANGUAGE sql AS $other$ SELECT $other$;
\ir ../../../migrations/20261118194700_job_cost_proven_share_rules.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply_error \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.job_profit_store_proven_share(p_job_ids uuid[])
RETURNS void LANGUAGE sql AS $other$ SELECT $other$;
\ir ../../../rollbacks/20261118194700_job_cost_proven_share_rules_down.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.check_share_rules(:'collide_calc_apply_error' LIKE '%Rule 15, another body is installed%',
  're-apply refuses unknown calculation body');
SELECT pg_temp.check_share_rules(:'collide_apply_error' LIKE '%Rule 15, another body is installed%',
  're-apply refuses unknown body');
SELECT pg_temp.check_share_rules(:'collide_down_error' LIKE '%rollback: another body is installed%',
  'rollback refuses unknown body');

SAVEPOINT zz_roundtrip;
\ir ../../../rollbacks/20261118194700_job_cost_proven_share_rules_down.sql
SELECT pg_temp.check_share_rules(
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_cost_proven_share(uuid[])'::regprocedure)='317bbcbdc920b45a9752ba25d07d413f'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_store_proven_share(uuid[])'::regprocedure)='72a8fbd89744351d172f7552d2bc7d3f',
  'rollback restores 20261118124326 bodies');
\ir ../../../migrations/20261118194700_job_cost_proven_share_rules.sql
RELEASE SAVEPOINT zz_roundtrip;

ROLLBACK;
\echo PASS P2-13.2 follow-up: share_no_cost no review, open credit and out-of-range reviews, partial sums, transitions, plans and rollback
