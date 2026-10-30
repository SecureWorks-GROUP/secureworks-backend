BEGIN;
CREATE TEMP TABLE note_checks(name text,passed boolean);
CREATE TEMP TABLE note_journey(payload jsonb);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'note current invoice: %',n; END IF;
 INSERT INTO note_checks VALUES(n,p);
END $$;
DO $test$
DECLARE item jsonb; ledger jsonb; money jsonb; projected jsonb; x jsonb;
 j uuid:=gen_random_uuid(); ev uuid:=gen_random_uuid(); gen uuid:=gen_random_uuid(); inv uuid:=gen_random_uuid();
 before_rows jsonb; story jsonb; writer jsonb; missing jsonb; reopened jsonb; before_hash text;
BEGIN
 item:='{"item_key":"issue:recipient","item_type":"issue","status":"open","about_key":"invoice:inv-97996","what":"Invoice INV-97996 is owing; recipient names conflict.","closes_on":"record","person_locked":true,"cites_ok":true,"opened_by":[{"table":"business_events","id":"fixture","excerpt":"recipient names conflict"}]}'::jsonb;
 ledger:=jsonb_build_object('items',jsonb_build_array(item),'status','live');
 money:='[{"invoices":[{"id":"fixture-invoice","number":"INV-97996","status":"PAID","owing":0}]}]'::jsonb;
 projected:=context_job_story_note_current_invoice(ledger,money,'2026-10-30');x:=projected->'items'->0;
 PERFORM pg_temp.prove('paid state explicitly precedes historical wording',x->>'what' LIKE 'Invoice record: INV-97996 PAID; owing $0.00.%Preserved note (historical wording): Invoice INV-97996 is owing; recipient names conflict.');
 PERFORM pg_temp.prove('original immutable matter remains open and source linked',x->>'source_what'=item->>'what' AND x->>'item_key'=item->>'item_key' AND x->>'status'='open' AND x->'opened_by'=item->'opened_by' AND x->'person_locked'='true' AND x->>'closes_on'='record');
 x:=context_job_story_note_current_invoice(jsonb_set(ledger,'{items,0,status}','"disputed"'),money,'2026-10-30')->'items'->0;
 PERFORM pg_temp.prove('staff disputed note is not asserted as an owed matter',x->>'status'='disputed' AND x->>'what' LIKE '%Note remains disputed.%' AND x->>'what' NOT LIKE '%Matter remains unresolved.%');
 PERFORM pg_temp.prove('annotation idempotent',context_job_story_note_current_invoice(projected,money,'2026-10-30')=projected);
 x:=context_job_story_note_current_invoice(ledger,'[]','2026-10-30')->'items'->0;
 PERFORM pg_temp.prove('missing invoice unknown never zero',x#>>'{current_invoice_evidence,resolution}'='missing' AND x->>'what' LIKE '%payment state Unknown%' AND x#>'{current_invoice_evidence,owing}'='null');
 x:=context_job_story_note_current_invoice(ledger,'[{"invoices":[{"id":"a","number":"INV-97996","status":"PAID","owing":null}]}]','2026-10-30')->'items'->0;
 PERFORM pg_temp.prove('null balance unknown never zero',x->>'what' LIKE '%owing Unknown.%' AND x#>'{current_invoice_evidence,owing}'='null');
 x:=context_job_story_note_current_invoice(ledger,'[{"invoices":[{"id":"a","number":"INV-97996","status":"PAID","owing":0},{"id":"b","number":"INV-97996","status":"AUTHORISED","owing":100}]}]','2026-10-30')->'items'->0;
 PERFORM pg_temp.prove('ambiguous number cannot select paid invoice',x#>>'{current_invoice_evidence,resolution}'='ambiguous' AND x->>'what' LIKE '%payment state Unknown%');
 x:=context_job_story_note_current_invoice(jsonb_set(ledger,'{items,0,about_key}','"invoice:fixture-invoice"'),money,'2026-10-30')->'items'->0;
 PERFORM pg_temp.prove('exact invoice ID supported',x#>>'{current_invoice_evidence,source_id}'='fixture-invoice');
 x:=context_job_story_note_current_invoice(jsonb_set(ledger,'{items,0,about_key}','"invoice:inv-9799"'),money,'2026-10-30')->'items'->0;
 PERFORM pg_temp.prove('invoice substring is not identity',x#>>'{current_invoice_evidence,resolution}'='missing');
 PERFORM pg_temp.prove('uncertain placement untouched',context_job_story_note_current_invoice(jsonb_set(ledger,'{items,0,job_certain}','false'),money,'2026-10-30')=jsonb_set(ledger,'{items,0,job_certain}','false'));
 PERFORM pg_temp.prove('invalid citation untouched',context_job_story_note_current_invoice(jsonb_set(ledger,'{items,0,cites_ok}','false'),money,'2026-10-30')=jsonb_set(ledger,'{items,0,cites_ok}','false'));
 PERFORM pg_temp.prove('payment obligation uses existing closure logic',context_job_story_note_current_invoice(jsonb_set(ledger,'{items,0,closes_on}','"payment"'),money,'2026-10-30')=jsonb_set(ledger,'{items,0,closes_on}','"payment"'));
 PERFORM pg_temp.prove('closed history unchanged',context_job_story_note_current_invoice(jsonb_set(ledger,'{items,0,status}','"closed"'),money,'2026-10-30')=jsonb_set(ledger,'{items,0,status}','"closed"'));

 INSERT INTO jobs(id,org_id,status,type,job_number,client_name,site_suburb,metadata,created_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-97996','Fixture Customer','Testville','{}','2026-09-01');
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO business_events(id,job_id,event_type,source,channel,direction,payload,metadata,occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
 VALUES(ev,j,'client.reply','note_invoice_contract','sms','outbound','{"body":"Invoice INV-97996 is owing; recipient names conflict. Please confirm payment of INV-97996."}',
 '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"staff","recipient_role":"customer","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
 '2026-09-02','2026-09-02','2026-09-02','2026-09-02','direct',1,1,'2026-09-02','direct_job_id');
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO xero_invoices(id,org_id,xero_invoice_id,invoice_type,job_id,invoice_number,status,invoice_date,total,amount_due,amount_paid,created_at,updated_at)
 VALUES(inv,'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'ACCREC',j,'INV-97996','AUTHORISED','2026-09-01',100,100,0,'2026-09-01','2026-09-02');
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,checks)
 VALUES(gen,j,'backfill','live','luna-ledger:v8',now()-interval '1 hour',now(),'{}');
 INSERT INTO context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,what,about_key,opened_at,opened_by,closes_on,needs_reply,written_by,person_locked)
 SELECT gen,j,v.key,v.kind,'open','us','customer',v.words,'invoice:inv-97996','2026-09-02',
 jsonb_build_array(jsonb_build_object('table','business_events','id',ev,'excerpt',v.words)),v.closes,v.needs,'model:luna-ledger:v8',false
 FROM (VALUES ('issue:recipient','issue','Invoice INV-97996 is owing; recipient names conflict.','record',false),
 ('request:confirmation','request','Please confirm payment of INV-97996.','reply',true)) v(key,kind,words,closes,needs);
 SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) INTO before_rows FROM context_ledger_items i WHERE generation_id=gen;
 ledger:=context_job_story_ledger(j); before_hash:=context_job_story_writer_input(j)->>'card_hash';
 PERFORM pg_temp.prove('ordinary read begins with current owing source',ledger->'items'->0->>'what' LIKE '%AUTHORISED; owing $100.00.%');
 UPDATE xero_invoices SET status='PAID',amount_due=0,amount_paid=100,fully_paid_on=current_date,updated_at=now() WHERE id=inv;
 ledger:=context_job_story_ledger(j);story:=context_job_story(p_job_id=>j);writer:=context_job_story_writer_input(j);
 PERFORM pg_temp.prove('source payment updates canonical note without model rerun',ledger->'items'->0->>'what' LIKE '%PAID; owing $0.00.%');
 PERFORM pg_temp.prove('both separate obligations retain keys and closure rules',jsonb_array_length(ledger->'items')=2 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ledger->'items') i WHERE i->>'status'<>'open') AND EXISTS(SELECT 1 FROM jsonb_array_elements(ledger->'items') i WHERE i->>'item_key'='request:confirmation' AND i->>'closes_on'='reply' AND i->'needs_reply'='true'));
 PERFORM pg_temp.prove('story and writer share canonical corrected words',story::text LIKE '%Invoice record: INV-97996 PAID; owing $0.00.%' AND writer->'notes'=ledger);
 PERFORM pg_temp.prove('payment correction invalidates writer hash',writer->>'card_hash'<>before_hash);
 PERFORM pg_temp.prove('paid source does not create payment obligation',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(story->'loops') l WHERE l->>'rule' IN ('R1_overdue','R2_part_paid','M1_money_due')));
 PERFORM pg_temp.prove('stored notes were never rewritten',before_rows=(SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) FROM context_ledger_items i WHERE generation_id=gen));
 UPDATE xero_invoices SET status='AUTHORISED',amount_due=40,amount_paid=60,fully_paid_on=NULL,updated_at=now() WHERE id=inv;
 reopened:=context_job_story_ledger(j);
 PERFORM pg_temp.prove('late correction updates owing while preserving same note',reopened->'items'->0->>'what' LIKE '%AUTHORISED; owing $40.00.%' AND reopened->'items'->0->>'source_what'=ledger->'items'->0->>'source_what');
 UPDATE xero_invoices SET job_id=NULL WHERE id=inv;
 missing:=context_job_story_ledger(j);
 PERFORM pg_temp.prove('moved invoice is not proof on former job',missing->'items'->0#>>'{current_invoice_evidence,resolution}'='missing' AND missing->'items'->0->>'what' LIKE '%payment state Unknown%');
 INSERT INTO note_journey VALUES(jsonb_build_object('paid_story',story,'paid_notes',ledger,'paid_writer_notes',writer->'notes','reopened_notes',reopened,'missing_notes',missing));
 PERFORM pg_temp.prove('service only projection',has_function_privilege('service_role','context_job_story_note_current_invoice(jsonb,jsonb,timestamptz)','execute') AND NOT has_function_privilege('authenticated','context_job_story_note_current_invoice(jsonb,jsonb,timestamptz)','execute') AND NOT has_function_privilege('anon','context_job_story_note_current_invoice(jsonb,jsonb,timestamptz)','execute'));
END $test$;
SELECT jsonb_build_object('checked_at',now(),'checks',jsonb_agg(to_jsonb(note_checks)),'journey',(SELECT payload FROM note_journey),'scope','Synthetic disposable SQL; no production or model calls') FROM note_checks;
ROLLBACK;
