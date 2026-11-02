SELECT to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NOT NULL AS restore_credit_20261030190230 \gset
\if :restore_credit_20261030190230
\ir ../../../rollbacks/20261031010000_context_story_credit_refresh_down.sql
\endif
\set ON_ERROR_STOP on
\if :{?expect_legacy}
\else
\set expect_legacy false
\endif
BEGIN;
SELECT set_config('test.oncost_legacy', :'expect_legacy', true);
CREATE TEMP TABLE oncost_checks(name text,passed boolean);
CREATE FUNCTION pg_temp.oncost_assert(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'story oncost contract: %',n;END IF;
 INSERT INTO oncost_checks VALUES(n,p);
END $$;
DO $test$
DECLARE j uuid:=gen_random_uuid();otherj uuid:=gen_random_uuid();u uuid:=gen_random_uuid();i uuid;line uuid;
 s0 text;s1 text;r0 text;k integer;expected boolean:=NOT current_setting('test.oncost_legacy')::boolean;
BEGIN
 INSERT INTO jobs(id,org_id,status,type,job_number,client_name,metadata,created_at) VALUES
 (j,'00000000-0000-0000-0000-000000000001','in_progress','fencing','SWF-ONCOST','Synthetic oncost job','{}','2026-09-01'),
 (otherj,'00000000-0000-0000-0000-000000000001','in_progress','fencing','SWF-OTHER','Synthetic other job','{}','2026-09-01');
 INSERT INTO users(id,org_id,name) VALUES(u,'00000000-0000-0000-0000-000000000001','Synthetic crew');
 FOR k IN 1..3 LOOP
  i:=gen_random_uuid();line:=gen_random_uuid();
  INSERT INTO trade_invoices(id,org_id,user_id,week_start,status,subtotal_ex,invoice_number,gst,total_inc,gst_on,super_rate,super_amount,gross_earned,net_pay,super_basis)
  VALUES(i,'00000000-0000-0000-0000-000000000001',u,'2026-10-19','draft',100,'ONCOST-'||k,0,100,false,0.12,12,100,100,'employer_12_v2');
  UPDATE trade_invoices SET gst_on=NULL,super_rate=NULL,super_amount=NULL,gross_earned=NULL,net_pay=NULL,super_basis=NULL WHERE id=i;
  INSERT INTO trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,description,line_total_ex,total_hours,line_date)
  VALUES(line,i,CASE WHEN k=1 THEN j END,CASE WHEN k=2 THEN 'SWF-ONCOST' END,'labour',CASE WHEN k=3 THEN 'Work on SWF-ONCOST' ELSE 'Synthetic labour' END,100,2,'2026-10-20');
  s0:=context_job_story_money_sig(j);r0:=context_ledger_record_signature(j);
  -- Original missing native fields become the existing valid employer12v2 values.
  UPDATE trade_invoices SET gst_on=false,super_rate=0.12,super_amount=12,gross_earned=100,net_pay=100,super_basis='employer_12_v2' WHERE id=i;
  s1:=context_job_story_money_sig(j);
  PERFORM pg_temp.oncost_assert('case '||k||' oncost metadata moves signature',(s1<>s0)=expected);
  PERFORM pg_temp.oncost_assert('case '||k||' financial reader follows',(context_ledger_record_signature(j)<>r0)=expected);
  PERFORM pg_temp.oncost_assert('case '||k||' claim covers current money',context_job_story_claim_state(j)->>'money_sig'=s1);
  UPDATE trade_invoices SET created_at=clock_timestamp() WHERE id=i;
  PERFORM pg_temp.oncost_assert('case '||k||' timestamp touch unchanged',context_job_story_money_sig(j)=s1);
  PERFORM set_config('TimeZone','America/New_York',true);
  PERFORM pg_temp.oncost_assert('case '||k||' timezone stable',context_job_story_money_sig(j)=s1);
  -- Existing legacy split basis also valid; no policy is changed by the test.
  UPDATE trade_invoices SET net_pay=94,super_basis=NULL WHERE id=i;
  PERFORM pg_temp.oncost_assert('case '||k||' employee versus employer split observed',(context_job_story_money_sig(j)<>s1)=expected);
  UPDATE trade_invoices SET gst_on=NULL,super_rate=NULL,super_amount=NULL,gross_earned=NULL,net_pay=NULL,super_basis=NULL WHERE id=i;
  PERFORM pg_temp.oncost_assert('case '||k||' absent source restored',context_job_story_money_sig(j)=s0);
  -- An explicitly placed other-job line cannot wake this job via matching text.
  UPDATE trade_invoice_lines SET job_id=otherj WHERE id=line;
  s0:=context_job_story_money_sig(j);
  UPDATE trade_invoices SET gst_on=false,super_rate=0.12,super_amount=12,gross_earned=100,net_pay=100,super_basis='employer_12_v2' WHERE id=i;
  PERFORM pg_temp.oncost_assert('case '||k||' other job does not move signature',context_job_story_money_sig(j)=s0);
  DELETE FROM trade_invoice_lines WHERE id=line;DELETE FROM trade_invoices WHERE id=i;
 END LOOP;
 -- Composition must retain TP-13 variation freshness alongside native on-costs.
 IF to_regprocedure('public.job_profit_partial_cost_policy()') IS NOT NULL THEN
  s0:=context_job_story_money_sig(j);i:=gen_random_uuid();
  INSERT INTO job_variations(id,job_id,variation_number,description,amount,gst_included,status,accepted_at,cost_estimate,created_at)
  VALUES(i,j,1,'Synthetic extra panel',330,true,'accepted','2026-10-20',NULL,'2026-10-19');
  s1:=context_job_story_money_sig(j);r0:=context_ledger_record_signature(j);
  PERFORM pg_temp.oncost_assert('accepted variation retained alongside oncost',s1<>s0);
  UPDATE job_variations SET cost_estimate=0 WHERE id=i;
  PERFORM pg_temp.oncost_assert('variation cost correction moves story',context_job_story_money_sig(j)<>s1);
  PERFORM pg_temp.oncost_assert('variation cost correction moves reader',context_ledger_record_signature(j)<>r0);
  DELETE FROM job_variations WHERE id=i;
  PERFORM pg_temp.oncost_assert('variation removal restores original signature',context_job_story_money_sig(j)=s0);
 END IF;
 PERFORM pg_temp.oncost_assert('service role only',has_function_privilege('service_role','context_job_story_money_sig(uuid)','EXECUTE') AND NOT has_function_privilege('anon','context_job_story_money_sig(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','context_job_story_money_sig(uuid)','EXECUTE'));
END $test$;
SELECT count(*) AS assertions FROM oncost_checks;
ROLLBACK;
\if :expect_legacy
\else
\ir ../../../migrations/20261030190230_context_story_oncost_refresh.sql
\endif

\if :restore_credit_20261030190230
\ir ../../../migrations/20261031010000_context_story_credit_refresh.sql
\endif
