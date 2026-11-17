BEGIN;
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('40000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST-990201','fencing','accepted'),
 ('40000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST-990202','patio','accepted');
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_lines_sync_v1';
DO $$
DECLARE org uuid := '00000000-0000-0000-0000-000000000001'; bill uuid; credit uuid; unallocated uuid;
BEGIN
 INSERT INTO public.organisations(id,name) VALUES (org,'Organisation') ON CONFLICT(id) DO NOTHING;
 PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(jsonb_build_object('org_id',org,
  'document_kind','xero_bill','document_id','ZZTEST-credit-bill','document_status','AUTHORISED','live',true,
  'lines','[{"line_key":"1","kind":"supplier_bill","lane":"materials","amount_ex":1000}]'::jsonb)));
 SELECT id INTO bill FROM public.job_cost_lines WHERE document_id='ZZTEST-credit-bill';
 PERFORM public.job_cost_lines_set_state(bill,'on_job',
  '[{"target":"job","job_id":"40000000-0000-4000-8000-000000000001","amount_ex":1000}]','matcher',NULL,NULL);
 INSERT INTO public.xero_supplier_credit_notes(org_id,xero_credit_note_id,credit_note_type,credit_note_number,
   status,sub_total,total,remaining_credit,allocations_returned,raw_json) VALUES
   (org,'ZZTEST-credit-sync','ACCPAYCREDIT','ZZTEST-CN','AUTHORISED',100,110,0,true,'{}');
 INSERT INTO public.xero_supplier_credit_note_allocations(org_id,xero_credit_note_id,n,xero_invoice_id,amount,is_deleted,raw_json)
 VALUES(org,'ZZTEST-credit-sync',1,'ZZTEST-credit-bill',110,false,'{}');
 PERFORM public.job_cost_lines_sync_credit_notes(ARRAY['ZZTEST-credit-sync']);
 SELECT id INTO credit FROM public.job_cost_lines WHERE document_id='ZZTEST-credit-sync' AND line_key='alloc:1';
 IF NOT EXISTS(SELECT 1 FROM public.job_cost_lines l JOIN public.job_cost_line_parts p ON p.line_id=l.id
   WHERE l.id=credit AND l.state='on_job' AND l.amount_ex=-100 AND p.amount_ex=-100
     AND p.job_id='40000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'credit sync: allocation not followed'; END IF;
 PERFORM public.job_cost_lines_set_state(bill,'split',
  '[{"target":"job","job_id":"40000000-0000-4000-8000-000000000001","amount_ex":600},{"target":"job","job_id":"40000000-0000-4000-8000-000000000002","amount_ex":400}]','matcher',NULL,NULL);
 PERFORM public.job_cost_lines_sync_credit_notes(ARRAY['ZZTEST-credit-sync']);
 IF (SELECT array_agg(amount_ex ORDER BY part_no) FROM public.job_cost_line_parts WHERE line_id=credit)
   <> ARRAY[-60,-40]::numeric[] THEN RAISE EXCEPTION 'credit sync: split proportions'; END IF;
 PERFORM public.job_cost_lines_set_state(bill,'needs_person','[]','source',NULL,'new');
 PERFORM public.job_cost_lines_sync_credit_notes(ARRAY['ZZTEST-credit-sync']);
 IF NOT EXISTS(SELECT 1 FROM public.job_cost_lines WHERE id=credit AND state='needs_person' AND needs_reason='follows_undecided')
   OR EXISTS(SELECT 1 FROM public.job_cost_line_parts WHERE line_id=credit) THEN RAISE EXCEPTION 'credit sync: undecided bill'; END IF;
 UPDATE public.xero_supplier_credit_notes SET remaining_credit=55 WHERE xero_credit_note_id='ZZTEST-credit-sync';
 PERFORM public.job_cost_lines_sync_credit_notes(ARRAY['ZZTEST-credit-sync']);
 SELECT id INTO unallocated FROM public.job_cost_lines WHERE document_id='ZZTEST-credit-sync' AND line_key='unallocated';
 IF NOT EXISTS(SELECT 1 FROM public.job_cost_lines WHERE id=unallocated AND state='needs_person'
   AND needs_reason='credit_not_allocated' AND amount_ex=-50) THEN RAISE EXCEPTION 'credit sync: unallocated credit'; END IF;
 UPDATE public.xero_supplier_credit_notes SET status='VOIDED' WHERE xero_credit_note_id='ZZTEST-credit-sync';
 PERFORM public.job_cost_lines_sync_credit_notes(ARRAY['ZZTEST-credit-sync']);
 IF EXISTS(SELECT 1 FROM public.job_cost_lines WHERE document_id='ZZTEST-credit-sync' AND state IS NOT NULL) THEN
   RAISE EXCEPTION 'credit sync: voided credit counted'; END IF;
 IF has_function_privilege('authenticated','public.job_cost_lines_sync_credit_notes(text[])','EXECUTE') THEN
   RAISE EXCEPTION 'credit sync: browser execution allowed'; END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
