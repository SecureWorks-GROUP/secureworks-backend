-- Follow-up 58 fixtures: synthetic jobs, bills and supplier credit notes, one per case.
-- Job numbers and amounts are made up. No person, price list or pay rate.
--   CS-0  a bill and no credit (credits exist on other jobs)        -> NULL
--   CS-1  bill on the job (xero_invoices.job_id), two notes on it   -> placed
--   CS-2A/2B one bill split by materials facts across two jobs      -> placed on both
--   CS-3  a note allocated to a bill on no job                      -> NULL everywhere
--   CS-4  a voided note on this job's bill                          -> NULL (not placed)
--   CS-5  bill on no job, a bookkeeping evidence line on this job   -> placed
--   SWF-958006 bill on no job, the job number in the line text       -> placed
--   CS-7A/7B bill on no job, a line split by bookkeeping parts      -> placed on both
--   CS-8  a draft bill on this job with a note (gate hit, no place) -> NULL
DO $fixtures$
DECLARE
 org uuid := '00000000-0000-0000-0000-000000000001';
 n jsonb := jsonb_build_object('credit_note_type','ACCPAYCREDIT','status','AUTHORISED','currency_code','AUD',
   'credit_note_date','2026-10-02','sub_total',100,'total_tax',10,'total',110,'remaining_credit',0,
   'xero_updated_at','2026-10-20T00:00:00Z','raw_json','{}'::jsonb);
 r record;
/* fixture block */ BEGIN
 INSERT INTO public.organisations(id,name) VALUES(org,'Synthetic organisation') ON CONFLICT(id) DO NOTHING;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,pricing_json,created_at)
 SELECT ('c5000000-0000-4000-8000-0000000000'||k)::uuid, org, 'in_progress', 'fencing', num, '{}', '{}', '2026-09-01'
   FROM (VALUES ('00','CS-0'),('01','CS-1'),('2a','CS-2A'),('2b','CS-2B'),('03','CS-3'),('04','CS-4'),
                ('05','CS-5'),('06','SWF-958006'),('7a','CS-7A'),('7b','CS-7B'),('08','CS-8')) v(k,num);
 INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,sub_total,total,invoice_date,line_items,raw_json,job_id)
 SELECT org, 'cs-bill-'||b, 'CS-BILL-'||b, 'ACCPAY', st, 1000, 1100, '2026-10-01',
        jsonb_build_array(jsonb_build_object('LineItemID','cs-line-'||b,'Description',d,'AccountCode','310','LineAmount',1000)),
        '{"Total":1100}', j::uuid
   FROM (VALUES
    ('0','AUTHORISED','Steel','c5000000-0000-4000-8000-000000000000'),
    ('1','AUTHORISED','Steel','c5000000-0000-4000-8000-000000000001'),
    ('2','AUTHORISED','Steel',NULL),
    ('3','AUTHORISED','Steel',NULL),
    ('4','PAID','Steel','c5000000-0000-4000-8000-000000000004'),
    ('5','AUTHORISED','Steel',NULL),
    ('6','AUTHORISED','Steel for SWF-958006',NULL),
    ('7','AUTHORISED','Steel',NULL),
    ('8','DRAFT','Steel','c5000000-0000-4000-8000-000000000008')) v(b,st,d,j);
 -- The split bill: both shares are facts, so the bill line itself stands aside.
 UPDATE public.xero_invoices SET job_id = 'c5000000-0000-4000-8000-00000000002a'::uuid WHERE xero_invoice_id = 'cs-bill-2';
 INSERT INTO public.job_materials_facts(xero_invoice_id,job_id,lane,kind,amount_ex_gst,automation_source,fact_date) VALUES
  ('cs-bill-2','c5000000-0000-4000-8000-00000000002a'::uuid,'materials','actual',600,'manual_split','2026-10-01'),
  ('cs-bill-2','c5000000-0000-4000-8000-00000000002b'::uuid,'materials','actual',400,'manual_split','2026-10-01');
 INSERT INTO public.bookkeeping_evidence_revisions(revision,stream,status,emitted_at)
 VALUES ('cs-rev-5','cs','current','2026-10-05T00:00:00Z'),('cs-rev-7','cs','current','2026-10-05T00:00:00Z');
 INSERT INTO public.bookkeeping_line_evidence(revision,xero_invoice_id,xero_line_item_id,amount_ex_gst,allocation,job_id,evidenced)
 VALUES ('cs-rev-5','cs-bill-5','cs-line-5',1000,'job','c5000000-0000-4000-8000-000000000005',true);
 -- Some earlier contract setups stand the current-evidence view up as a plain table.
 IF (SELECT relkind FROM pg_class WHERE oid = 'public.v_bookkeeping_line_evidence_current'::regclass) = 'r' THEN
  INSERT INTO public.v_bookkeeping_line_evidence_current(revision,xero_invoice_id,xero_line_item_id,amount_ex_gst,allocation,job_id,evidenced,stream,emitted_at)
  VALUES ('cs-rev-5','cs-bill-5','cs-line-5',1000,'job','c5000000-0000-4000-8000-000000000005',true,'cs','2026-10-05T00:00:00Z');
 END IF;
 INSERT INTO public.bookkeeping_line_evidence_parts(revision,xero_invoice_id,xero_line_item_id,part,parts,line_ex,amount_ex_gst,allocation,job_id,evidenced)
 VALUES ('cs-rev-7','cs-bill-7','cs-line-7',1,2,1000,700,'job','c5000000-0000-4000-8000-00000000007a'::uuid,true),
        ('cs-rev-7','cs-bill-7','cs-line-7',2,2,1000,300,'job','c5000000-0000-4000-8000-00000000007b'::uuid,true);
 FOR r IN SELECT * FROM (VALUES
   ('cs-cn-0','cs-bill-0x',110,'AUTHORISED'),  -- a note on a bill nobody has: credits exist, none on CS-0
   ('cs-cn-1','cs-bill-1',110,'AUTHORISED'),
   ('cs-cn-1b','cs-bill-1',55,'PAID'),
   ('cs-cn-2','cs-bill-2',110,'AUTHORISED'),
   ('cs-cn-3','cs-bill-3',110,'AUTHORISED'),
   ('cs-cn-4','cs-bill-4',110,'VOIDED'),
   ('cs-cn-5','cs-bill-5',110,'AUTHORISED'),
   ('cs-cn-6','cs-bill-6',110,'AUTHORISED'),
   ('cs-cn-7','cs-bill-7',110,'AUTHORISED'),
   ('cs-cn-8','cs-bill-8',110,'AUTHORISED')) v(cn,bill,amt,st)
 LOOP
  PERFORM public.xero_supplier_credit_note_copy(org,
    n || jsonb_build_object('xero_credit_note_id',r.cn,'credit_note_number',upper(r.cn),'status',r.st),
    jsonb_build_array(jsonb_build_object('xero_invoice_id',r.bill,'amount',r.amt,'allocation_date','2026-10-02','is_deleted',false)));
 END LOOP;
END $fixtures$;
