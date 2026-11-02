BEGIN;
CREATE TEMP TABLE checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %', n; END IF;
 INSERT INTO checks VALUES(n,p);
END $$;
DO $test$
DECLARE f jsonb; j uuid; other uuid; inv uuid; gen uuid; d jsonb; sig text; other_sig text; packet jsonb;
BEGIN
 j:=gen_random_uuid(); other:=gen_random_uuid(); inv:=gen_random_uuid(); gen:=gen_random_uuid();
 UPDATE automation_switches SET extraction=true,all_stop=false WHERE id=1;
 UPDATE context_ledger_settings SET mode='live',reader='luna-ledger:v8',job_ids=ARRAY[j],backfill_from_hour=NULL,backfill_to_hour=NULL WHERE id;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,site_suburb,metadata,created_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-97993','Fixture Customer','Testville','{}','2026-09-01'),
 (other,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-97994','Other Fixture','Testville','{}','2026-09-01');
 -- Isolate fixture insertion from operational event triggers, not the functions under test.
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,payload,metadata,
  occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
 VALUES(gen_random_uuid(),j,'client.reply','rebuild_contract','sms','outbound',
  '{"body":"Please pay invoice INV-97993. Please confirm payment. The invoice recipient is disputed."}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"staff","recipient_role":"customer","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  '2026-09-02','2026-09-02','2026-09-02','2026-09-02','direct',1,1,'2026-09-02','direct_job_id');
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_type,job_id,invoice_number,status,invoice_date,total,
  amount_due,fully_paid_on,created_at,updated_at)
 VALUES(inv,'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'ACCREC',j,'INV-97993','PAID','2026-09-01',100,0,'2026-09-05','2026-09-01','2026-09-05');
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,checks) VALUES(gen,j,'backfill','live','luna-ledger:v8',now(),(context_ledger_packet(j,NULL,now())->>'evidence_until')::timestamptz,'{}');
 DELETE FROM feature_flags WHERE flag_name='context_ledger_financial_refresh_v1';
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('missing flag preserves old non-due answer',NOT (d->>'due')::boolean);
 INSERT INTO feature_flags(flag_name,enabled) VALUES('context_ledger_financial_refresh_v1',false);
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('off flag preserves old non-due answer',NOT (d->>'due')::boolean);
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_ledger_financial_refresh_v1';
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('unwitnessed finance requests whole rebuild',(d->>'due')::boolean AND d->>'kind'='rebuild' AND d->>'reason'='financial_changed');
 sig:=context_ledger_record_signature(j);
 UPDATE context_ledger_generations SET checks=checks||jsonb_build_object('reader',jsonb_build_object('financial_signature',sig)) WHERE id=gen;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('matching consumed signature quiet',NOT (d->>'due')::boolean);
 UPDATE xero_invoices SET updated_at=now()+interval '1 second' WHERE id=inv;
 PERFORM pg_temp.prove('cache touch does not invalidate',sig=context_ledger_record_signature(j));
 UPDATE xero_invoices SET status='AUTHORISED',amount_due=100,amount_paid=0,fully_paid_on=NULL WHERE id=inv;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('reopened debt invalidates without new message',(d->>'due')::boolean AND d->>'reason'='financial_changed');
 packet:=context_ledger_record_packet(j);
 PERFORM pg_temp.prove('record packet binds source and prior witnesses',packet->>'financial_signature'=context_ledger_record_signature(j) AND packet->>'prior_financial_signature'=sig AND jsonb_typeof(packet->'story')='object');
 PERFORM pg_temp.prove('historical record packet cannot acknowledge current sources',(context_ledger_record_packet(j,now()-interval '1 minute')->>'financial_signature') IS NULL);
 sig:=context_ledger_record_signature(j);
 UPDATE context_ledger_generations SET checks=checks||jsonb_build_object('last_update',jsonb_build_object('reader',jsonb_build_object('financial_signature',sig))) WHERE id=gen;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('successful update witness supersedes build witness',NOT (d->>'due')::boolean);
 UPDATE xero_invoices SET status='PAID',amount_due=0,amount_paid=100,fully_paid_on=current_date WHERE id=inv;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('paid invoice requests whole rebuild',(d->>'due')::boolean AND d->>'reason'='financial_changed');
 UPDATE context_ledger_generations SET evidence_until=now()-interval '30 days' WHERE id=gen;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('finance plus new messages cannot select partial update',d->>'reason'='financial_changed' AND d->>'kind'='rebuild');
 sig:=context_ledger_record_signature(j); other_sig:=context_ledger_record_signature(other);
 UPDATE xero_invoices SET job_id=other WHERE id=inv;
 PERFORM pg_temp.prove('invoice moved invalidates original job',sig<>context_ledger_record_signature(j));
 PERFORM pg_temp.prove('invoice moved invalidates receiving job',other_sig<>context_ledger_record_signature(other));
 UPDATE context_ledger_settings SET job_ids=ARRAY[other] WHERE id;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('rollout exclusion retained',NOT (d->>'due')::boolean AND d->>'blocked_reason'='not_in_rollout');
 UPDATE context_ledger_settings SET mode='off' WHERE id;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[j]) x;
 PERFORM pg_temp.prove('ledger off retained',NOT (d->>'due')::boolean AND d->>'blocked_reason'='ledger_off');
 PERFORM pg_temp.prove('anon cannot read signature',NOT has_function_privilege('anon','context_ledger_record_signature(uuid)','EXECUTE'));
 PERFORM pg_temp.prove('authenticated cannot read record packet',NOT has_function_privilege('authenticated','context_ledger_record_packet(uuid,timestamptz)','EXECUTE'));
 PERFORM pg_temp.prove('service role can read packet',has_function_privilege('service_role','context_ledger_record_packet(uuid,timestamptz)','EXECUTE'));
END $test$;
SELECT jsonb_build_object('checked_at',now(),'checks',jsonb_agg(to_jsonb(checks)),'scope','Synthetic local transaction, rolled back; actual SQL scheduling and source functions, no models or production writes') FROM checks;
ROLLBACK;
