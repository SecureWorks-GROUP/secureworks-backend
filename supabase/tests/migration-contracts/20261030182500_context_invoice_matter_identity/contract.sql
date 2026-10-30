BEGIN;
CREATE TEMP TABLE identity_expect(legacy boolean);
\if :{?expect_legacy}
INSERT INTO identity_expect VALUES(true);
\else
INSERT INTO identity_expect VALUES(false);
\endif
DO $test$
DECLARE item jsonb; items jsonb:='[]'; rec jsonb; story jsonb; rule text; closing text;
 legacy boolean:=(SELECT legacy FROM identity_expect); k integer:=0; debt jsonb;
BEGIN
 FOREACH closing IN ARRAY ARRAY['record','reply','invoice_issued','person','unknown','payment'] LOOP
  k:=k+1;
  item:=jsonb_build_object('item_key','matter:'||k,'item_type','request','status','open','what','Independent matter '||k,
    'about_key','invoice:inv-fixture','closes_on',CASE WHEN closing='unknown' THEN NULL ELSE closing END,
    'from_role','us','to_role','customer','opened_at','2026-10-01T00:00:00Z','cites_ok',true,
    'written_by','model:fixture','opened_by',jsonb_build_array(jsonb_build_object('table','business_events','id','source-'||k)));
  items:=items||jsonb_build_array(item);
 END LOOP;
 FOREACH rule IN ARRAY ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft'] LOOP
  debt:=jsonb_build_object('rule',rule,'loop_key','debt','shown_as','loop','owner','customer','counterparty','us',
    'what','Invoice owes $40','why','Provider balance','opened_at','2026-10-01T00:00:00Z',
    'about_key','invoice:inv-fixture','amount',40,'closes_when','Payment received','source_table','xero_invoices','source_id','invoice-id');
  rec:=jsonb_build_object('loops',jsonb_build_array(debt));
  story:=context_job_story_assemble('{"id":"fixture","status":"scheduled","type":"fencing","created_at":"2026-09-01"}',
   rec,jsonb_build_object('status','live','generation',jsonb_build_object('id','gen','status','live'),'items',items,'unread_ids','[]'::jsonb),'{}','2026-10-30');
  IF jsonb_array_length(story->'loops') <> (CASE WHEN legacy THEN 1 ELSE 6 END) THEN
   RAISE EXCEPTION 'invoice matter identity: independent matters hidden under %',rule;
  END IF;
  FOR k IN 1..5 LOOP
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(story->'loops') l WHERE l->>'key'='matter:'||k) = legacy THEN
    RAISE EXCEPTION 'invoice matter identity: separate key absent under %',rule;
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(story->'loops') l WHERE l->>'key'='matter:6') THEN
   RAISE EXCEPTION 'invoice matter identity: payment counted twice';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(story->'loops') l WHERE l->>'key'='debt' AND l->>'what'='Invoice owes $40') THEN
   RAISE EXCEPTION 'invoice matter identity: debt changed';
  END IF;
 END LOOP;
 -- Non-money same-object grouping is unchanged; no general regrouping is introduced.
 FOREACH rule IN ARRAY ARRAY['R7_quote_waiting','R8_not_yet_invoiced'] LOOP
 debt:=debt||jsonb_build_object('rule',rule);rec:=jsonb_build_object('loops',jsonb_build_array(debt));
 story:=context_job_story_assemble('{"id":"fixture","status":"quoted","type":"fencing","created_at":"2026-09-01"}',
  rec,jsonb_build_object('status','live','generation',jsonb_build_object('id','gen','status','live'),'items',items,'unread_ids','[]'::jsonb),'{}','2026-10-30');
 IF jsonb_array_length(story->'loops')<>1 THEN RAISE EXCEPTION 'invoice matter identity: unrelated grouping changed'; END IF;
 END LOOP;
 IF has_function_privilege('anon','context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)','EXECUTE')
 OR NOT has_function_privilege('service_role','context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)','EXECUTE') THEN
  RAISE EXCEPTION 'invoice matter identity: access changed';
 END IF;
END $test$;
ROLLBACK;
