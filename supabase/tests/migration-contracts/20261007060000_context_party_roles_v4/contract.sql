-- Contract for 20261007060000_context_party_roles_v4. Every fixture write is
-- rolled back; ids, job numbers, contacts, addresses, numbers and text are
-- synthetic.
--
-- Proves, through the real insert trigger (the ladder runs first):
--   A. A prospect: a GHL contact with an open opportunity in a cached CRM
--      roster (sales_booking_packs kind roster), and no job, reads customer
--      (basis open_opportunity, audience customer) on texts in and out, calls
--      and emails, by its contact id or by the roster contact's own email or
--      phone; either roster (fencing or patio) counts, the latest of each.
--      Not a prospect: an opportunity that is not open or only in an older
--      roster, a message sent more than 30 days before the opportunity was
--      created, a contact our records name as one of our crew (the roster
--      contact's phone) or that our tools texted as crew (conflict, never
--      customer), a prospect's text placed on another customer's job (an
--      opportunity elsewhere says nothing of that job's customer). A job's
--      customer with an opportunity reads as the job's customer, as before.
--   B. Domains in our records. A gov.au domain is a council (council to
--      staff in, staff to council out, basis council as in v3, audience
--      other_party). Our own material order (subject "Material Order Ref",
--      "Material Quote Request Ref" or "Material Order Inquiry Ref") reads
--      staff to supplier, and so does every later email with the address it
--      went to (supplier_order_address) or another address at its domain or
--      a subdomain (supplier_order_domain); a free-mail recipient names only
--      itself; a reply or forward subject is no order. The domain of a
--      make-safe company's own invoice or report address is that builder
--      (builder_domain); a sender pattern that is a whole address still names
--      only that address.
--   C. A Xero bill named in an inbound email's subject is a supplier's
--      (xero_bill) when the bill is live, its Xero contact is a known
--      supplier and none of our users, no trade invoice pushed it, and the
--      number is none we issued and none of our job references; the same
--      number in an outbound email decides nothing.
--   D. A call transcript reads as its call, but never over its own job's
--      customer or a party on its job: the transcript, on the customer's own
--      job, of a call the supplier list reads on no job reads customer
--      (job_customer), as the same contact's text there does; so does a job
--      party's (job_party) whose call reads crew. A transcript whose own
--      counterpart is unknown (no match, or a conflict) takes a crew call's
--      roles and basis (users, from_call) from another job or none, paired by
--      payload.ghl_call_id or only by its ghltx: key; one that names someone
--      (another job's customer) keeps its own reading of a call on another
--      job, and takes the call's on the same job; where the two agree it
--      keeps its own basis (job_customer); a transcript whose call is unknown
--      reads by its own rules; a call that reads a customer passes it on
--      only to a transcript on the same job (or both on none), with its basis
--      (any_job_customer stays any_job_customer).
--   E. Every v3 decision these fixtures make is unchanged, stamped v4: L1d's
--      label and our crew templates first, the job's customer, a supplier by
--      the supplier list, a builder by its company address, the customer of
--      another job, a lead, a stranger, a row with no counterpart; v4 writes
--      no ladder-owned key; a non-message row carries none.
--   F. Structure: bodies, comments, grants, the index and its predicate, the
--      classifier a STABLE invoker with no SET clause, the pinned helpers and
--      the trigger untouched.
--   G. A re-apply is a no-op.
--   H. v3_message_party_roles.sql (the pinned v3 body the 20261006034000
--      case stands back up for its re-apply) is v3's body and comment byte
--      for byte, and loading it moves no other function.
--   I. The service role previews the classifier, in a fresh session: a
--      prospect, a council and a material-order supplier read as above.
--   J. Row 2's read, context_party_roles_lanes(as_of, days): per lane over
--      the rows captured in the window (capture times pinned inside the
--      fixture transaction), the messages, how many name both sides, the
--      unknown ones by basis, the rows still stamped by an older classifier
--      version, and the customers with no job yet (a prospect's text, call
--      and the transcript that took the call's roles).
--   K. A reader keyed on a council's basis reads v4's council as it read
--      v3's: Jev's later truth (20261007030000), where it is live, reads a
--      council's email, stamped by the live classifier, as another party at
--      sender_role and as a council at email_triage.
-- A to D run in one block that names every failing rule at once, so the
-- break proof shows each v4 rule fail when it is unwired.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.p4_job(p_number text,p_contact text,p_email text DEFAULT NULL,p_phone text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_email,client_phone,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_contact,p_email,p_phone,now()-interval '60 days');
 RETURN j;
END $$;

-- One row through the real insert trigger, sent p_ago before now.
CREATE FUNCTION pg_temp.p4_ev(p_channel text,p_direction text,p_event text,p_contact text,p_payload jsonb,
 p_meta jsonb DEFAULT '{}'::jsonb,p_ago interval DEFAULT interval '1 day',p_key text DEFAULT NULL) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES(p_contact,'contact',coalesce(p_contact,'none'),p_direction,p_channel,p_event,'party_roles_v4_contract',
   coalesce(p_key,'p4:'||replace(gen_random_uuid()::text,'-','')),p_payload,p_meta||'{"capture_mode":"live"}',now()-p_ago,now()-p_ago)
  RETURNING * INTO e;
 RETURN e;
END $$;

CREATE FUNCTION pg_temp.p4_on(e public.business_events,p_job uuid) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE r public.business_events;
BEGIN
 UPDATE public.business_events SET job_id=p_job WHERE id=e.id RETURNING * INTO r;
 RETURN r;
END $$;

-- '' when the row reads as expected (stamped party_roles_v4), else what differs.
CREATE FUNCTION pg_temp.p4_roles(what text,e public.business_events,p_sender text,p_recipient text,p_basis text,p_audience text)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN r IS NULL OR r->>'version' IS DISTINCT FROM 'party_roles_v4' OR r->>'sender_role' IS DISTINCT FROM p_sender
   OR r->>'recipient_role' IS DISTINCT FROM p_recipient
   OR r->>'counterpart_role' IS DISTINCT FROM CASE WHEN p_sender='staff' THEN p_recipient ELSE p_sender END
   OR r->>'basis' IS DISTINCT FROM p_basis OR r->>'audience' IS DISTINCT FROM p_audience
   OR (p_basis<>'conflict' AND r ? 'conflicting_roles')
  THEN format('%s must read %s to %s (basis %s, audience %s, party_roles_v4), got %s',what,p_sender,p_recipient,p_basis,p_audience,coalesce(r::text,'none'))
  ELSE '' END
 FROM (SELECT e.metadata->'party_roles' AS r) x
$$;

-- A cached CRM roster (the sales booking door's kind roster row).
CREATE FUNCTION pg_temp.p4_roster(p_resource text,p_opps jsonb) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.sales_booking_packs(resource,week_start,kind,as_of,payload,published_by)
 VALUES(p_resource,'1970-01-05','roster',now(),jsonb_build_object('opportunities',p_opps,'total',jsonb_array_length(p_opps),'exhausted',true),'party_roles_v4_contract')
$$;
CREATE FUNCTION pg_temp.p4_opp(p_id text,p_contact text,p_status text,p_created timestamptz,p_email text DEFAULT NULL,p_phone text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('id',p_id,'contactId',p_contact,'status',p_status,'pipelineId','p4-pipeline',
  'createdAt',to_char(p_created AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'contact',jsonb_strip_nulls(jsonb_build_object('id',p_contact,'email',p_email,'phone',p_phone)))
$$;

-- A to D.
BEGIN;
DO $$
DECLARE
 problems text[]:='{}'; miss text[]; k text; j1 uuid; j2 uuid; e public.business_events; c public.business_events; r jsonb;
BEGIN
 j1:=pg_temp.p4_job('SWF-997001','p4-cust','client.four@example.com','0412 444 900');
 INSERT INTO public.users(id,org_id,name,role,email,phone,xero_contact_id) VALUES
  (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','Fixture Crew Four','installer','crew.four@gmail.com','0499 444 111','xc-p4-crew');
 INSERT INTO public.suppliers(id,name,email,phone,xero_contact_id) VALUES
  (gen_random_uuid(),'Fixture Supply Four',NULL,NULL,'xc-p4-sup'),
  (gen_random_uuid(),'Fixture Crew Four Pty',NULL,NULL,'xc-p4-crew');
 INSERT INTO public.makesafe_companies(slug,name,sender_patterns,invoice_email,report_recipient) VALUES
  ('p4-builder','Fixture Builder Four',ARRAY['claims@fixtureinsure4.com'],'accounts@fixturebuilder4.com.au','reports@fixturebuilder4-reports.com.au');
 PERFORM pg_temp.p4_roster('marnin',jsonb_build_array(
  pg_temp.p4_opp('p4-opp-1','p4-prospect','open',now()-interval '5 days','prospect.four@example.com','0412 444 001'),
  pg_temp.p4_opp('p4-opp-2','p4-lost','lost',now()-interval '5 days'),
  pg_temp.p4_opp('p4-opp-3','p4-crewopp','open',now()-interval '5 days',NULL,'+61 499 444 111'),
  pg_temp.p4_opp('p4-opp-4','p4-labelled','open',now()-interval '5 days'),
  pg_temp.p4_opp('p4-opp-5','p4-late','open',now()-interval '5 days'),
  pg_temp.p4_opp('p4-opp-6','p4-cust','open',now()-interval '5 days'),
  pg_temp.p4_opp('p4-opp-7',NULL,'open',now()-interval '5 days','lead.by.email4@example.com',NULL)));
 PERFORM pg_temp.p4_roster('nithin',jsonb_build_array(
  pg_temp.p4_opp('p4-opp-8','p4-patio','open',now()-interval '40 days')));

 -- A. Prospects.
 BEGIN
  miss:='{}';
  e:=pg_temp.p4_ev('sms','inbound','client.reply','p4-prospect',jsonb_build_object('body','Can you quote my fence?'));
  k:=pg_temp.p4_roles('a text from a contact with an open opportunity',e,'customer','staff','open_opportunity','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('sms','outbound','client.sms_out','p4-prospect',jsonb_build_object('body','Hi, thanks for your enquiry'));
  k:=pg_temp.p4_roles('a text to a contact with an open opportunity',e,'staff','customer','open_opportunity','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('call','inbound','client.call_logged','p4-prospect',jsonb_build_object('call_status','completed'));
  k:=pg_temp.p4_roles('a call from a contact with an open opportunity',e,'customer','staff','open_opportunity','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- The message came before the opportunity, inside the lead window, and on the patio roster.
  e:=pg_temp.p4_ev('sms','inbound','client.reply','p4-patio',jsonb_build_object('body','Following up'),'{}'::jsonb,interval '60 days');
  k:=pg_temp.p4_roles('a text 20 days before its patio opportunity',e,'customer','staff','open_opportunity','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- By the roster contact's own email and phone, with no GHL contact on the row.
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','Lead <Lead.By.Email4@example.com>','body','My enquiry'));
  k:=pg_temp.p4_roles('an email from an opportunity''s email',e,'customer','staff','open_opportunity','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('sms','inbound','client.sms_in',NULL,jsonb_build_object('phone','+61412444001','body','Is this SecureWorks?'));
  k:=pg_temp.p4_roles('a text from an opportunity''s phone',e,'customer','staff','open_opportunity','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('prospect rule not built: '||array_to_string(miss,'; ')); END IF;

  -- Never a guess.
  miss:='{}';
  e:=pg_temp.p4_ev('sms','inbound','client.reply','p4-lost',jsonb_build_object('body','Changed my mind'));
  k:=pg_temp.p4_roles('a contact whose opportunity is not open',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- Only the latest roster of a resource counts (the door's read rule): an
  -- older one listing the contact is not read.
  INSERT INTO public.sales_booking_packs(resource,week_start,kind,as_of,payload,published_by)
   VALUES('marnin','1970-01-05','roster',now()-interval '1 day',jsonb_build_object('opportunities',
    jsonb_build_array(pg_temp.p4_opp('p4-opp-old','p4-stale','open',now()-interval '5 days'))),'party_roles_v4_contract');
  e:=pg_temp.p4_ev('sms','inbound','client.reply','p4-stale',jsonb_build_object('body','Still keen'));
  k:=pg_temp.p4_roles('a contact only an older roster lists',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('sms','inbound','client.reply','p4-late',jsonb_build_object('body','Hello from last year'),'{}'::jsonb,interval '90 days');
  k:=pg_temp.p4_roles('a text 85 days before its opportunity',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('sms','inbound','client.reply','p4-crewopp',jsonb_build_object('body','On site'));
  k:=pg_temp.p4_roles('an opportunity whose contact phone is our crew',e,'unknown','staff','conflict','unknown');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles'->'conflicting_roles' IS DISTINCT FROM '["crew","customer"]'::jsonb THEN
   miss:=miss||format('the crew conflict must name crew and customer, got %s',e.metadata->'party_roles');
  END IF;
  -- Our crew job text went to this contact (the ladder's label or our
  -- template stamp marks it), so its opportunity is no proof of a customer.
  PERFORM pg_temp.p4_ev('sms','outbound','client.sms_out','p4-labelled',jsonb_build_object('body',E'Job ready for crew: SWF-997001 - Fixture\nStage: scheduled'));
  e:=pg_temp.p4_ev('sms','inbound','client.reply','p4-labelled',jsonb_build_object('body','Yep'));
  k:=pg_temp.p4_roles('an opportunity whose contact our tools texted as crew',e,'unknown','staff','conflict','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_on(pg_temp.p4_ev('sms','inbound','client.reply','p4-cust',jsonb_build_object('body','Thanks')),j1);
  k:=pg_temp.p4_roles('the job''s customer with an opportunity',e,'customer','staff','job_customer','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- On another customer's job, an opportunity elsewhere says nothing about
  -- that job's customer.
  e:=pg_temp.p4_on(pg_temp.p4_ev('sms','inbound','client.reply','p4-prospect',jsonb_build_object('body','About the job next door')),j1);
  k:=pg_temp.p4_roles('a prospect''s text placed on another customer''s job',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('prospect rule guessed: '||array_to_string(miss,'; ')); END IF;
 EXCEPTION WHEN OTHERS THEN
  problems:=problems||format('prospect rule not built: the fixtures failed with SQLSTATE %s (%s)',SQLSTATE,SQLERRM);
 END;

 -- B. Domains in our records.
 BEGIN
  miss:='{}';
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','planning@fixture4.wa.gov.au','body','Approval'));
  k:=pg_temp.p4_roles('a council email',e,'council','staff','council','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','approvals@fixture4.wa.gov.au',
   'to',jsonb_build_array('approvals@fixture4.wa.gov.au'),'subject','Building application','body','Attached'));
  k:=pg_temp.p4_roles('an email to a council',e,'staff','council','council','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('council rule not built: '||array_to_string(miss,'; ')); END IF;

  miss:='{}';
  e:=pg_temp.p4_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','orders@fixturesupply4.com.au',
   'to',jsonb_build_array('Orders <Orders@FixtureSupply4.com.au>'),'subject','Material Order Ref SWF-997001','body','Please supply'));
  k:=pg_temp.p4_roles('our material order',e,'staff','supplier','supplier_order_address','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','orders@fixturesupply4.com.au','subject','RE: Material Order Ref SWF-997001','body','Confirmed'));
  k:=pg_temp.p4_roles('a reply from the address our order went to',e,'supplier','staff','supplier_order_address','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','Jane <jane@fixturesupply4.com.au>','body','Delivery Tuesday'));
  k:=pg_temp.p4_roles('another address at the supplier''s domain',e,'supplier','staff','supplier_order_domain','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','dispatch@depot.fixturesupply4.com.au','body','On the truck'));
  k:=pg_temp.p4_roles('a subdomain of the supplier''s domain',e,'supplier','staff','supplier_order_domain','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  PERFORM pg_temp.p4_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','sole.trader4@gmail.com',
   'to',jsonb_build_array('sole.trader4@gmail.com'),'subject','Material Quote Request Ref SWP-997002','body','Price please'));
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','sole.trader4@gmail.com','body','Quote attached'));
  k:=pg_temp.p4_roles('a free-mail address our order went to',e,'supplier','staff','supplier_order_address','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','another.person4@gmail.com','body','Hi'));
  k:=pg_temp.p4_roles('another free-mail address',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  PERFORM pg_temp.p4_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','client.forward4@example.org',
   'to',jsonb_build_array('client.forward4@example.org'),'subject','Fw: Material Order Ref SWF-997001','body','FYI'));
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','someone@example.org','body','Thanks'));
  k:=pg_temp.p4_roles('the domain of a forwarded order''s recipient',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('supplier order rule not built: '||array_to_string(miss,'; ')); END IF;

  miss:='{}';
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','site.super@fixturebuilder4.com.au','body','Site access'));
  k:=pg_temp.p4_roles('an address at a builder''s invoice domain',e,'insurer_builder','staff','builder_domain','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','pm@fixturebuilder4-reports.com.au',
   'to',jsonb_build_array('pm@fixturebuilder4-reports.com.au'),'subject','Photos','body','Attached'));
  k:=pg_temp.p4_roles('an address at a builder''s report domain',e,'staff','insurer_builder','builder_domain','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','someone.else@fixtureinsure4.com','body','Hi'));
  k:=pg_temp.p4_roles('another address at an address-pattern domain',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('builder domain rule not built: '||array_to_string(miss,'; ')); END IF;
 EXCEPTION WHEN OTHERS THEN
  problems:=problems||format('domain rules not built: the fixtures failed with SQLSTATE %s (%s)',SQLSTATE,SQLERRM);
 END;

 -- C. A Xero bill named in an inbound email.
 BEGIN
  miss:='{}';
  INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,xero_contact_id) VALUES
   ('00000000-0000-0000-0000-000000000001','xi-p4-1','INV-77001','ACCPAY','AUTHORISED','xc-p4-sup'),
   ('00000000-0000-0000-0000-000000000001','xi-p4-2','INV-77002','ACCPAY','AUTHORISED','xc-p4-crew'),
   ('00000000-0000-0000-0000-000000000001','xi-p4-3','INV-77003','ACCPAY','VOIDED','xc-p4-sup'),
   ('00000000-0000-0000-0000-000000000001','xi-p4-4','INV-77004','ACCPAY','AUTHORISED','xc-p4-sup'),
   ('00000000-0000-0000-0000-000000000001','xi-p4-5','INV-77004','ACCREC','AUTHORISED','xc-p4-client'),
   ('00000000-0000-0000-0000-000000000001','xi-p4-6','SWF-997001','ACCPAY','AUTHORISED','xc-p4-sup'),
   ('00000000-0000-0000-0000-000000000001','xi-p4-7','INV-77007','ACCPAY','AUTHORISED','xc-p4-sup'),
   ('00000000-0000-0000-0000-000000000001','xi-p4-8','INV-77008','ACCPAY','AUTHORISED','xc-p4-stranger');
  -- A trade invoice we pushed to Xero as a bill (the live money split filled in).
  INSERT INTO public.trade_invoices(id,status,xero_bill_id,subtotal_ex,gst,total_inc,gst_on,super_rate,super_amount,gross_earned,net_pay)
   VALUES (gen_random_uuid(),'pushed_to_xero','xi-p4-7',100,0,100,false,0.12,12,100,94);
  e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','messaging-service@post.xero.example',
   'subject','Invoice INV-77001 from Fixture Supply Four for SecureWorks','body','Your invoice'));
  k:=pg_temp.p4_roles('an email naming a supplier''s Xero bill',e,'supplier','staff','xero_bill','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_ev('email','inbound','supplier.email_in',NULL,jsonb_build_object('from','accounts@unknown-supplier4.example',
   'subject','Statement','body','Balance'),'{}'::jsonb,interval '1 day');
  IF e.metadata->'party_roles'->>'basis' IS DISTINCT FROM 'supplier' THEN
   miss:=miss||format('fixture: the supplier event type must still read supplier, got %s',e.metadata->'party_roles'); END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('xero bill rule not built: '||array_to_string(miss,'; ')); END IF;

  miss:='{}';
  FOR k IN SELECT unnest(ARRAY['Invoice INV-77002 from a crew member','Invoice INV-77003 voided','Invoice INV-77004 ours too',
    'Invoice SWF-997001 job ref','Invoice INV-77007 trade bill','Invoice INV-77008 not a known supplier','Invoice 7700 short']) LOOP
   e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','messaging-service@post.xero.example','subject',k,'body','x'));
   IF e.metadata->'party_roles'->>'basis' IS DISTINCT FROM 'no_match' THEN
    miss:=miss||format('subject "%s" must decide nothing, got %s',k,e.metadata->'party_roles'); END IF;
  END LOOP;
  e:=pg_temp.p4_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','stranger4@example.net',
   'to',jsonb_build_array('stranger4@example.net'),'subject','About INV-77001','body','x'));
  k:=pg_temp.p4_roles('an outbound email naming a supplier''s bill',e,'staff','unknown','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('xero bill rule guessed: '||array_to_string(miss,'; ')); END IF;
 EXCEPTION WHEN OTHERS THEN
  problems:=problems||format('xero bill rule not built: the fixtures failed with SQLSTATE %s (%s)',SQLSTATE,SQLERRM);
 END;

 -- D. A call transcript reads as its call, but never over its own job's
 -- customer or a party on its job.
 BEGIN
  miss:='{}';
  -- The job's customer on file, whose phone is also on the supplier list:
  -- the call carried that phone and the ladder left it on no job, so the
  -- supplier list reads it. Its transcript, on the customer's own job,
  -- carried only the contact. v1 reads a job's own customer before the
  -- supplier list, so the transcript reads customer (job_customer), as the
  -- same contact's text on that job does, wherever the call sits.
  j2:=pg_temp.p4_job('SWF-997002','p4-supcust');
  INSERT INTO public.suppliers(id,name,email,phone) VALUES (gen_random_uuid(),'Fixture Supply Four Phone',NULL,'0412 444 777');
  -- The ladder may place the call on the contact's job; it is taken off again.
  c:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged','p4-supcust',jsonb_build_object('phone','0412444777','call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call1'),NULL);
  k:=pg_temp.p4_roles('fixture: the call from a phone on the supplier list, on no job',c,'supplier','staff','supplier','other_party');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','call.transcript_completed','p4-supcust',
   jsonb_build_object('ghl_call_id','p4call1','transcript','About my fence'),'{}'::jsonb,interval '1 hour','ghltx:p4call1'),j2);
  k:=pg_temp.p4_roles('the transcript, on the customer''s own job, of a call the supplier list reads',e,'customer','staff','job_customer','customer');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles' ? 'from_call' THEN
   miss:=miss||format('a transcript of the job''s own customer keeps its own reading, got %s',e.metadata->'party_roles'); END IF;
  e:=pg_temp.p4_on(pg_temp.p4_ev('sms','inbound','client.reply','p4-supcust',jsonb_build_object('body','Thanks')),j2);
  k:=pg_temp.p4_roles('the same contact''s text on that job',e,'customer','staff','job_customer','customer');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- A party on job 2 (job_contacts) whose call came from our crew's phone and
  -- sits on no job: the transcript on job 2 keeps job_party.
  INSERT INTO public.job_contacts(job_id,ghl_contact_id,contact_type) VALUES (j2,'p4-party','neighbour');
  c:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged','p4-party',jsonb_build_object('phone','0499444111','call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call9'),NULL);
  k:=pg_temp.p4_roles('fixture: the job party''s call from our crew''s phone, on no job',c,'crew','staff','users','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','call.transcript_completed','p4-party',jsonb_build_object('ghl_call_id','p4call9','transcript','The side gate'),
   '{}'::jsonb,interval '1 hour','ghltx:p4call9'),j2);
  k:=pg_temp.p4_roles('the transcript, on the job, of a party on that job whose call our records read as crew',e,'customer','staff','job_party','customer');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles' ? 'from_call' THEN
   miss:=miss||format('a transcript of a party on its job keeps its own reading, got %s',e.metadata->'party_roles'); END IF;
  -- Our crew's call on no job, and its transcript, paired by its ghltx: key
  -- alone and written first, carrying only a contact our records do not
  -- name, on job 1: the transcript's own counterpart is unknown, and crew
  -- are crew on any job, so it reads as its call.
  e:=pg_temp.p4_ev('call','inbound','call.transcript_completed','p4-stranger',jsonb_build_object('transcript','Second part'),
   '{}'::jsonb,interval '50 minutes','ghltx:p4call1b');
  PERFORM pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged','p4-crewonly',jsonb_build_object('phone','0499444111'),
   '{}'::jsonb,interval '3 hours','ghl:p4call1b'),NULL);
  -- The transcript came first; a writer's later update re-stamps it.
  UPDATE public.business_events SET job_id=j1 WHERE id=e.id RETURNING * INTO e;
  r:=e.metadata->'party_roles';
  IF r->>'version' IS DISTINCT FROM 'party_roles_v4' OR r->>'sender_role' IS DISTINCT FROM 'crew' OR r->>'recipient_role' IS DISTINCT FROM 'staff'
   OR r->>'counterpart_role' IS DISTINCT FROM 'crew' OR r->>'basis' IS DISTINCT FROM 'users' OR r->'from_call' IS DISTINCT FROM 'true'::jsonb
   OR r->>'audience' IS DISTINCT FROM 'internal' THEN
   miss:=miss||format('the transcript of a crew call, its own counterpart unknown, must read crew to staff (the call''s basis users, from_call, audience internal), got %s',r);
  END IF;
  -- A transcript whose own reading is a conflict (an open opportunity whose
  -- roster contact's phone is our crew's), on no job, of a call our records
  -- read as crew on job 1: a conflict names no one, so it reads as its call.
  PERFORM pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged',NULL,jsonb_build_object('phone','0499444111','call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call6'),j1);
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','call.transcript_completed','p4-crewopp',jsonb_build_object('ghl_call_id','p4call6','transcript','On my way'),
   '{}'::jsonb,interval '1 hour','ghltx:p4call6'),NULL);
  k:=pg_temp.p4_roles('the transcript, its own reading a conflict, of a crew call on another job',e,'crew','staff','users','internal');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles'->'from_call' IS DISTINCT FROM 'true'::jsonb THEN
   miss:=miss||format('a transcript that took its call''s reading is marked from_call, got %s',e.metadata->'party_roles'); END IF;
  -- The customer of another job (any_job_customer), on no job, of a call our
  -- records read as crew on job 1: the transcript names someone and the call
  -- sits elsewhere, so it keeps its own reading.
  PERFORM pg_temp.p4_job('SWF-997004','p4-cust4');
  PERFORM pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged',NULL,jsonb_build_object('phone','0499444111','call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call7'),j1);
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','call.transcript_completed','p4-cust4',jsonb_build_object('ghl_call_id','p4call7','transcript','Next week'),
   '{}'::jsonb,interval '1 hour','ghltx:p4call7'),NULL);
  k:=pg_temp.p4_roles('the transcript, on no job, of another job''s customer whose call our records read as crew on job 1',e,'customer','staff','any_job_customer','customer');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles' ? 'from_call' THEN
   miss:=miss||format('a transcript that names someone keeps its own reading of a call on another job, got %s',e.metadata->'party_roles'); END IF;
  -- The same pair on the same job: they are the same people, so the
  -- transcript reads as its call (v1 reads our users before another job's
  -- customer).
  PERFORM pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged',NULL,jsonb_build_object('phone','0499444111','call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call8'),j1);
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','call.transcript_completed','p4-cust4',jsonb_build_object('ghl_call_id','p4call8','transcript','Gate code'),
   '{}'::jsonb,interval '1 hour','ghltx:p4call8'),j1);
  k:=pg_temp.p4_roles('the transcript, on the same job, of another job''s customer whose call our records read as crew',e,'crew','staff','users','internal');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles'->'from_call' IS DISTINCT FROM 'true'::jsonb THEN
   miss:=miss||format('a transcript that took its call''s reading is marked from_call, got %s',e.metadata->'party_roles'); END IF;
  -- Where call and transcript agree, the transcript keeps its own basis.
  c:=pg_temp.p4_on(pg_temp.p4_ev('call','outbound','client.call_logged','p4-cust',jsonb_build_object('call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call2'),j1);
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','outbound','call.transcript_completed','p4-cust',
   jsonb_build_object('ghl_call_id','p4call2','transcript','About the gate'),'{}'::jsonb,interval '1 hour','ghltx:p4call2'),j1);
  k:=pg_temp.p4_roles('the transcript of a call with the job''s customer',e,'staff','customer','job_customer','customer');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles' ? 'from_call' THEN
   miss:=miss||format('a transcript that agrees with its call keeps its own reading, got %s',e.metadata->'party_roles'); END IF;
  -- A call that reads a customer passes it on only where the transcript
  -- sits: the job's customer's call on job 1 says nothing of a transcript on
  -- no job.
  PERFORM pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged','p4-cust',jsonb_build_object('call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call4'),j1);
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','call.transcript_completed',NULL,jsonb_build_object('ghl_call_id','p4call4','transcript','The side gate'),
   '{}'::jsonb,interval '1 hour','ghltx:p4call4'),NULL);
  k:=pg_temp.p4_roles('the transcript, on no job, of a customer''s call on a job',e,'unknown','staff','no_contact','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- On the same job, the call's customer and its basis pass on: the customer
  -- of another job reads as any_job_customer on the transcript too.
  PERFORM pg_temp.p4_job('SWF-997003','p4-cust3');
  PERFORM pg_temp.p4_on(pg_temp.p4_ev('call','inbound','client.call_logged','p4-cust3',jsonb_build_object('call_status','completed'),
   '{}'::jsonb,interval '2 hours','ghl:p4call5'),j1);
  e:=pg_temp.p4_on(pg_temp.p4_ev('call','inbound','call.transcript_completed',NULL,jsonb_build_object('ghl_call_id','p4call5','transcript','Mine is next week'),
   '{}'::jsonb,interval '1 hour','ghltx:p4call5'),j1);
  k:=pg_temp.p4_roles('the transcript of another job''s customer''s call on the same job',e,'customer','staff','any_job_customer','customer');
  IF k<>'' THEN miss:=miss||k;
  ELSIF e.metadata->'party_roles'->'from_call' IS DISTINCT FROM 'true'::jsonb THEN
   miss:=miss||format('a transcript that took its call''s reading is marked from_call, got %s',e.metadata->'party_roles'); END IF;
  -- A call nobody knows: the transcript reads by its own rules.
  PERFORM pg_temp.p4_ev('call','inbound','client.call_logged','p4-nobody',jsonb_build_object('call_status','completed'),'{}'::jsonb,interval '2 hours','ghl:p4call3');
  e:=pg_temp.p4_ev('call','inbound','call.transcript_completed','p4-nobody',jsonb_build_object('ghl_call_id','p4call3','transcript','Who is this'),
   '{}'::jsonb,interval '1 hour','ghltx:p4call3');
  k:=pg_temp.p4_roles('the transcript of an unknown call',e,'unknown','staff','no_match','unknown');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('transcript rule not built: '||array_to_string(miss,'; ')); END IF;
 EXCEPTION WHEN OTHERS THEN
  problems:=problems||format('transcript rule not built: the fixtures failed with SQLSTATE %s (%s)',SQLSTATE,SQLERRM);
 END;

 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'party roles v4 contract: %',array_to_string(problems,' | ');
 END IF;
END $$;
ROLLBACK;

-- E. Every v3 decision these fixtures make is unchanged, stamped v4.
BEGIN;
DO $$
DECLARE miss text[]:='{}'; k text; j1 uuid; j2 uuid; e public.business_events; words text; n bigint;
BEGIN
 j1:=pg_temp.p4_job('SWF-997101','p4e-cust','client.e4@example.com','0412 445 900');
 j2:=pg_temp.p4_job('SWF-997102','p4e-cust2');
 INSERT INTO public.suppliers(id,name,email,phone) VALUES (gen_random_uuid(),'Fixture Steel E4','orders@fixturesteel-e4.com.au',NULL);
 INSERT INTO public.makesafe_companies(slug,name,sender_patterns) VALUES ('p4e-builder','Fixture Builder E4',ARRAY['fixturebuilder-e4.com.au']);
 INSERT INTO public.contact_matches(ghl_contact_id) VALUES('p4e-lead');
 e:=pg_temp.p4_on(pg_temp.p4_ev('sms','inbound','client.reply','p4e-cust',jsonb_build_object('body','See you then')),j1);
 k:=pg_temp.p4_roles('a reply from the job''s customer',e,'customer','staff','job_customer','customer'); IF k<>'' THEN miss:=miss||k; END IF;
 words:=E'New job assigned: SWF-997101 - Fixture Client\nSite: 4 Fixture St';
 e:=pg_temp.p4_ev('sms','outbound','client.sms_out','p4e-cust',jsonb_build_object('body',words,'text',words,'message',words));
 k:=pg_temp.p4_roles('our crew template to the job''s customer contact',e,'staff','crew','our_template','internal'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('sms','outbound','client.sms_out','p4e-crew2',jsonb_build_object('body',words,'text',words,'message',words));
 IF e.metadata->>'audience' IS DISTINCT FROM 'internal' THEN miss:=miss||format('fixture: L1d must label the crew text internal, got %s',e.metadata); END IF;
 k:=pg_temp.p4_roles('L1d''s crew text',e,'staff','crew','ladder_internal','internal'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','accounts@fixturesteel-e4.com.au','body','Statement'));
 k:=pg_temp.p4_roles('a supplier by the supplier list',e,'supplier','staff','supplier','other_party'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','wo@fixturebuilder-e4.com.au','body','Work order'));
 k:=pg_temp.p4_roles('a builder by its company pattern',e,'insurer_builder','staff','builder_company','other_party'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_on(pg_temp.p4_ev('sms','inbound','client.reply','p4e-cust2',jsonb_build_object('body','Any update?')),NULL);
 k:=pg_temp.p4_roles('the customer of another job',e,'customer','staff','any_job_customer','customer'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('sms','inbound','client.reply','p4e-lead',jsonb_build_object('body','Can I get a quote?'));
 k:=pg_temp.p4_roles('a lead',e,'customer','staff','lead','customer'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','random.e4@gmail.com','body','Hello'));
 k:=pg_temp.p4_roles('a free-mail stranger',e,'unknown','staff','no_match','unknown'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('body','no sender at all'));
 k:=pg_temp.p4_roles('a row with no counterpart',e,'unknown','staff','no_contact','unknown'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('email','internal','staff.email_internal',NULL,jsonb_build_object('from','shaun@secureworkswa.com.au','body','Check this'));
 k:=pg_temp.p4_roles('internal mail',e,'staff','staff','internal_direction','internal'); IF k<>'' THEN miss:=miss||k; END IF;
 e:=pg_temp.p4_ev('status','system','job.status_changed','p4e-cust','{"to":"scheduled"}'::jsonb);
 IF e.metadata ? 'party_roles' THEN miss:=miss||format('a non-message row must carry no party roles, got %s',e.metadata); END IF;
 SELECT count(*) INTO n FROM public.business_events
 WHERE source='party_roles_v4_contract' AND metadata ? 'party_roles' AND coalesce(metadata->>'audience','')=''
  AND (metadata ? 'recipient_role' OR metadata ? 'recipient_role_source');
 IF n<>0 THEN miss:=miss||format('%s rows gained a ladder-owned key',n); END IF;
 IF cardinality(miss)>0 THEN RAISE EXCEPTION 'party roles v4 regression: %',array_to_string(miss,'; '); END IF;
END $$;
ROLLBACK;

-- F. Structure.
DO $$
DECLARE p record; r text;
BEGIN
 FOR p IN SELECT * FROM (VALUES
  ('public.context_message_party_roles(public.business_events)','17a10cf9b9180a6380e8465d2dce503b','Party roles v4 (20261007060000):%Service role may call it to preview.'),
  ('public.context_party_crm_roles(text,text,text,timestamp with time zone)','b5b0d82f9d9809cc7f6a7db6b1fde458','Party roles v4 (20261007060000):%'),
  ('public.context_party_domain_roles(text)','93624d7e20f4ab3f292a1b0e2a8777d9','Party roles v4 (20261007060000):%'),
  ('public.context_party_xero_bill(text)','2aef40c5509b118cee06a35cd951a64f','Party roles v4 (20261007060000):%'),
  ('public.context_party_call_roles(public.business_events)','c71771892098899f2195b45605901729','Party roles v4 (20261007060000):%'),
  ('public.context_party_roles_lanes(timestamp with time zone,integer)','ff6797dcd0d2788d01ac1ff21143a18a','Party roles v4 (20261007060000): row 2''s read for the scorecard.%')
 ) AS t(sig,md5,note) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(p.sig)) IS DISTINCT FROM p.md5 THEN
   RAISE EXCEPTION 'party roles v4: % is not this migration''s body',p.sig; END IF;
  IF coalesce(obj_description(to_regprocedure(p.sig),'pg_proc'),'') NOT LIKE p.note THEN
   RAISE EXCEPTION 'party roles v4: % comment is not this migration''s',p.sig; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','public'] LOOP
   IF has_function_privilege(r,p.sig,'EXECUTE') THEN RAISE EXCEPTION 'party roles v4: % can call %',r,p.sig; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role',p.sig,'EXECUTE') THEN RAISE EXCEPTION 'party roles v4: the service role must call %',p.sig; END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_proc pr WHERE pr.oid='public.context_message_party_roles(public.business_events)'::regprocedure
    AND NOT pr.prosecdef AND pr.provolatile='s' AND pr.proconfig IS NULL) THEN
  RAISE EXCEPTION 'party roles v4: the classifier must stay a STABLE invoker function with no SET clause'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc pr WHERE pr.oid IN ('public.context_party_crm_roles(text,text,text,timestamptz)'::regprocedure,
    'public.context_party_domain_roles(text)'::regprocedure,'public.context_party_xero_bill(text)'::regprocedure,
    'public.context_party_call_roles(public.business_events)'::regprocedure,'public.context_party_roles_lanes(timestamptz,integer)'::regprocedure)
    AND (pr.prosecdef OR pr.provolatile<>'s' OR pr.proconfig IS NOT NULL)) THEN
  RAISE EXCEPTION 'party roles v4: the helpers must be STABLE invoker functions with no SET clause'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='business_events' AND indexname='business_events_party_material_orders'
   AND indexdef LIKE '%(occurred_at) WHERE %' AND indexdef LIKE '%''client.email_out''%'
   AND indexdef LIKE '%material (order|quote request|order inquiry) ref%') THEN
  RAISE EXCEPTION 'party roles v4: the material order index is missing or reads another predicate'; END IF;
 -- Read, not replaced.
 FOR p IN SELECT * FROM (VALUES
  ('public.context_party_key_roles(text,text)','4da54e7c7107e927b350947697f440e7'),
  ('public.context_party_contact_roles(text)','8c1f5381cb41d2cdcb0f33b530cc3070'),
  ('public.context_party_supplier_key(text,text)','92a1eb902c4a0aa0aab05d1aa7707352'),
  ('public.context_party_user_role(text,text)','17bdaa22bb55de8635c1dd8563d070d1'),
  ('public.context_party_builder_address(text)','ccd5e9acd5d51228007c3af14054c474'),
  ('public.context_stamp_party_roles()','de974f45ef3174e9391a3d31369df179')
 ) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(p.sig)) IS DISTINCT FROM p.md5 THEN
   RAISE EXCEPTION 'party roles v4: % changed',p.sig; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass AND NOT t.tgisinternal
   AND t.tgname='context_party_roles_business_event' AND t.tgfoid='public.context_stamp_party_roles()'::regprocedure)<>1 THEN
  RAISE EXCEPTION 'party roles v4: the party-role trigger changed'; END IF;
END $$;

-- The domain helper reads our material orders through the partial index.
BEGIN;
SET LOCAL enable_seqscan = off;
DO $$
DECLARE plan text;
BEGIN
 EXECUTE 'EXPLAIN (FORMAT TEXT) SELECT 1 FROM public.business_events b WHERE b.event_type=''client.email_out'''
  ||' AND coalesce(b.payload->>''subject'','''') ~* ''^\s*material (order|quote request|order inquiry) ref\y''' INTO plan;
 IF plan NOT LIKE '%business_events_party_material_orders%' THEN
  RAISE EXCEPTION 'party roles v4: the material order read does not use its partial index: %',plan; END IF;
END $$;
ROLLBACK;

-- G. A re-apply is a no-op.
BEGIN;
CREATE TEMP TABLE p4_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid,'pg_proc') AS note, p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid IN ('public.context_message_party_roles(public.business_events)'::regprocedure,
  'public.context_party_crm_roles(text,text,text,timestamptz)'::regprocedure,'public.context_party_domain_roles(text)'::regprocedure,
  'public.context_party_xero_bill(text)'::regprocedure,'public.context_party_call_roles(public.business_events)'::regprocedure,
  'public.context_party_roles_lanes(timestamptz,integer)'::regprocedure);
\ir ../../../migrations/20261007060000_context_party_roles_v4.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM p4_before)<>6 OR EXISTS (SELECT 1 FROM p4_before b JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.m OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note OR p.proacl::text IS DISTINCT FROM b.acl)
 THEN RAISE EXCEPTION 'party roles v4: a re-apply changed a body, comment or grant'; END IF;
 IF (SELECT count(*) FROM pg_indexes WHERE indexname='business_events_party_material_orders')<>1 THEN
  RAISE EXCEPTION 'party roles v4: a re-apply duplicated the index'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='context_party_roles_business_event')<>1 THEN
  RAISE EXCEPTION 'party roles v4: a re-apply duplicated the trigger'; END IF;
END $$;
ROLLBACK;

-- J. Row 2's read. Capture times are pinned inside the fixture transaction
-- (2099-01-01, far from any real row), so the window holds these rows only.
BEGIN;
DO $$
DECLARE r record; miss text[]:='{}'; e public.business_events; cap timestamptz:='2099-01-01T00:00:00Z';
BEGIN
 PERFORM pg_temp.p4_job('SWF-997301','p4j-cust');
 PERFORM pg_temp.p4_roster('marnin',jsonb_build_array(pg_temp.p4_opp('p4j-opp','p4j-prospect','open',now()-interval '5 days')));
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,provider_message_id,payload,metadata,occurred_at,event_at,context_captured_at)
 VALUES
  ('p4j-cust','contact','p4j-cust','inbound','sms','client.reply','party_roles_v4_contract','p4j:1',jsonb_build_object('body','Thanks'),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '1 hour'),
  ('p4j-nobody','contact','p4j-nobody','inbound','sms','client.reply','party_roles_v4_contract','p4j:2',jsonb_build_object('body','Who?'),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '2 hours'),
  ('p4j-prospect','contact','p4j-prospect','inbound','sms','client.reply','party_roles_v4_contract','p4j:3',jsonb_build_object('body','Quote?'),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '3 hours'),
  ('p4j-old','contact','p4j-old','outbound','sms','client.sms_out','party_roles_v4_contract','p4j:4',jsonb_build_object('body','Hello'),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '4 hours'),
  (NULL,'contact','none','inbound','email','client.email_in','party_roles_v4_contract','p4j:5',jsonb_build_object('from','planning@p4j.wa.gov.au','body','Approval'),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '5 hours'),
  ('p4j-out','contact','p4j-out','inbound','sms','client.reply','party_roles_v4_contract','p4j:6',jsonb_build_object('body','Outside the window'),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '2 days');
 -- A prospect's call, then its transcript (no contact of its own): the
 -- transcript takes the call's roles and counts as a customer with no job.
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,provider_message_id,payload,metadata,occurred_at,event_at,context_captured_at)
 VALUES('p4j-prospect','contact','p4j-prospect','inbound','call','client.call_logged','party_roles_v4_contract','ghl:p4jcall',jsonb_build_object('duration',60),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '6 hours');
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,provider_message_id,payload,metadata,occurred_at,event_at,context_captured_at)
 VALUES(NULL,'contact','none','inbound','call','call.transcript_completed','party_roles_v4_contract','ghltx:p4jcall',jsonb_build_object('ghl_call_id','p4jcall','transcript','Quote please'),'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',cap-interval '6 hours');
 -- One row still carries an older classifier's stamp (as a stored row nobody re-stamped does).
 ALTER TABLE public.business_events DISABLE TRIGGER context_party_roles_business_event;
 UPDATE public.business_events SET metadata=metadata||jsonb_build_object('party_roles',jsonb_build_object('version','party_roles_v3','sender_role','staff',
  'recipient_role','unknown','counterpart_role','unknown','basis','no_match','audience','unknown')) WHERE provider_message_id='p4j:4';
 ALTER TABLE public.business_events ENABLE TRIGGER context_party_roles_business_event;
 SELECT * INTO r FROM public.context_party_roles_lanes(cap,1) l WHERE l.lane='texts';
 IF r.messages IS DISTINCT FROM 4::bigint OR r.stamped IS DISTINCT FROM 4::bigint OR r.both_known IS DISTINCT FROM 2::bigint
  OR r.both_known_pct IS DISTINCT FROM 50.0 OR r.older_stamps IS DISTINCT FROM 1::bigint
  OR r.unknown_by_basis IS DISTINCT FROM '{"no_match":2}'::jsonb OR r.no_job_customers IS DISTINCT FROM 1::bigint
  OR r.no_job_customers_on_a_job IS DISTINCT FROM 0::bigint OR r.live_version IS DISTINCT FROM 'party_roles_v4' THEN
  miss:=miss||format('the texts lane must read 4 messages, 4 stamped, 2 naming both sides (50.0), 1 older stamp, {"no_match": 2}, 1 customer with no job, live party_roles_v4, got %s',to_jsonb(r));
 END IF;
 SELECT * INTO r FROM public.context_party_roles_lanes(cap,1) l WHERE l.lane='emails_in';
 IF r.messages IS DISTINCT FROM 1::bigint OR r.both_known IS DISTINCT FROM 1::bigint OR r.unknown_by_basis IS DISTINCT FROM '{}'::jsonb THEN
  miss:=miss||format('the emails_in lane must read the council email as naming both sides, got %s',to_jsonb(r));
 END IF;
 FOR r IN SELECT * FROM public.context_party_roles_lanes(cap,1) l WHERE l.lane IN ('calls','call_transcripts') LOOP
  IF r.messages IS DISTINCT FROM 1::bigint OR r.both_known IS DISTINCT FROM 1::bigint OR r.no_job_customers IS DISTINCT FROM 1::bigint
   OR r.older_stamps IS DISTINCT FROM 0::bigint THEN
   miss:=miss||format('the %s lane must read the prospect''s call and its transcript as a customer with no job, got %s',r.lane,to_jsonb(r));
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.context_party_roles_lanes(cap,1) l WHERE l.lane IN ('calls','call_transcripts'))<>2 THEN
  miss:=miss||'the calls and call_transcripts lanes must each hold the prospect''s call'::text;
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_party_roles_lanes(cap,1) l WHERE l.lane NOT IN ('texts','emails_in','calls','call_transcripts')) THEN
  miss:=miss||'the window must hold the fixture rows only'::text;
 END IF;
 IF cardinality(miss)>0 THEN RAISE EXCEPTION 'party roles v4 contract: row 2 read not built: %',array_to_string(miss,'; '); END IF;
END $$;
ROLLBACK;

-- K. Readers keyed on a council's basis. Jev's later truth (20261007030000)
-- reads a council by basis council (v3's stamp): sender_role answers
-- other_party, email_triage answers council. v4 gives a council its own role
-- and keeps that basis, so both read v4's stamp as they read v3's. Checked
-- where the truth read is live (it is in the registered stack).
BEGIN;
DO $$
DECLARE e public.business_events; d public.context_jev_decisions; got text; miss text[]:='{}';
BEGIN
 IF to_regprocedure('public.context_jev_truth(public.context_jev_decisions)') IS NULL THEN
  RAISE NOTICE 'party roles v4 contract: no Jev truth read is live; section K has nothing to check';
  RETURN;
 END IF;
 e:=pg_temp.p4_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','Planning <planning@p4k.wa.gov.au>','body','Approval'));
 IF e.metadata->'party_roles'->>'sender_role' IS DISTINCT FROM 'council' OR e.metadata->'party_roles'->>'basis' IS DISTINCT FROM 'council' THEN
  miss:=miss||format('a council email must be stamped council, basis council, got %s',e.metadata->'party_roles');
 END IF;
 d:=jsonb_populate_record(NULL::public.context_jev_decisions,jsonb_build_object('decision_point','sender_role','row_table','business_events',
  'row_id',e.id,'requested_model','p4-contract'));
 got:=public.context_jev_truth(d);
 IF got IS DISTINCT FROM 'other_party' THEN
  miss:=miss||format('Jev''s sender_role truth must read a council''s email as other_party, got %s',coalesce(got,'null'));
 END IF;
 d:=jsonb_populate_record(NULL::public.context_jev_decisions,jsonb_build_object('decision_point','email_triage','row_table','business_events',
  'row_id',e.id,'requested_model','p4-contract'));
 got:=public.context_jev_truth(d);
 IF got IS DISTINCT FROM 'council' THEN
  miss:=miss||format('Jev''s email_triage truth must read a council''s email as council, got %s',coalesce(got,'null'));
 END IF;
 IF cardinality(miss)>0 THEN
  RAISE EXCEPTION 'party roles v4 contract: a council reads otherwise than v3''s: %',array_to_string(miss,'; ');
 END IF;
END $$;
ROLLBACK;

-- H. The pinned v3 body the 20261006034000 case stands back up for its
-- re-apply: v3's classifier and comment byte for byte, and loading it moves
-- no other function.
BEGIN;
CREATE TEMP TABLE p4_h_before AS SELECT p.oid, p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
\ir v3_message_party_roles.sql
DO $$
DECLARE moved text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_message_party_roles(public.business_events)'::regprocedure)
   IS DISTINCT FROM '36ed4eac4ec8a1b2efd253da02add409'
  OR coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
   NOT LIKE 'Party roles v3 (20261006034000):%Service role may call it to preview.' THEN
  RAISE EXCEPTION 'party roles v4: v3_message_party_roles.sql is not v3''s classifier and comment'; END IF;
 SELECT string_agg(b.sig,', ' ORDER BY b.sig COLLATE "C",b.oid) INTO moved
 FROM p4_h_before b LEFT JOIN pg_proc p ON p.oid=b.oid
 WHERE b.oid<>'public.context_message_party_roles(public.business_events)'::regprocedure
  AND (p.oid IS NULL OR md5(p.prosrc) IS DISTINCT FROM b.m OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note);
 IF moved IS NOT NULL THEN RAISE EXCEPTION 'party roles v4: loading the pinned v3 body moved %',moved; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')<>(SELECT count(*) FROM p4_h_before) THEN
  RAISE EXCEPTION 'party roles v4: loading the pinned v3 body added or dropped a function'; END IF;
END $$;
ROLLBACK;

-- I. The service role previews the classifier, in a fresh session (no plan
-- cached by postgres hides a missing grant). The fixtures are written as
-- postgres inside the transaction; the rows are built in memory.
\c
BEGIN;
INSERT INTO public.sales_booking_packs(resource,week_start,kind,as_of,payload,published_by)
 VALUES('marnin','1970-01-05','roster',now(),jsonb_build_object('opportunities',jsonb_build_array(jsonb_build_object('id','p4-opp-i',
  'contactId','p4-preview','status','open','createdAt',to_char((now()-interval '2 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),
  'party_roles_v4_contract');
INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,provider_message_id,payload,metadata,occurred_at,event_at)
 VALUES(NULL,'contact','none','outbound','email','client.email_out','party_roles_v4_contract','p4:preview-order',
  jsonb_build_object('email','orders@previewsupply4.com.au','to',jsonb_build_array('orders@previewsupply4.com.au'),'subject','Material Order Ref SWF-997201'),
  '{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day');
SET LOCAL ROLE service_role;
DO $$
DECLARE t record; r jsonb; miss text[]:='{}';
BEGIN
 FOR t IN SELECT * FROM (VALUES
   ('a text from a prospect','sms','inbound','client.reply','p4-preview',jsonb_build_object('body','Quote please'),'customer','open_opportunity'),
   ('a council email','email','inbound','client.email_in',NULL,jsonb_build_object('from','planning@preview4.wa.gov.au','body','Approval'),'council','council'),
   ('a supplier our order went to','email','inbound','client.email_in',NULL,jsonb_build_object('from','sales@previewsupply4.com.au','body','Confirmed'),'supplier','supplier_order_domain')
  ) AS v(what,ch,dir,et,contact,payload,want,basis) LOOP
  BEGIN
   r:=public.context_message_party_roles(jsonb_populate_record(NULL::public.business_events,jsonb_build_object(
    'id',gen_random_uuid(),'contact_id',t.contact,'channel',t.ch,'direction',t.dir,'event_type',t.et,
    'payload',t.payload,'metadata','{}'::jsonb,'occurred_at',now(),'event_at',now())));
   IF r->>'sender_role' IS DISTINCT FROM t.want OR r->>'recipient_role' IS DISTINCT FROM 'staff' OR r->>'basis' IS DISTINCT FROM t.basis THEN
    miss:=miss||format('%s must read %s to staff (%s), got %s',t.what,t.want,t.basis,coalesce(r::text,'none'));
   END IF;
  EXCEPTION WHEN OTHERS THEN
   miss:=miss||format('%s failed with SQLSTATE %s (%s)',t.what,SQLSTATE,SQLERRM);
  END;
 END LOOP;
 IF cardinality(miss)>0 THEN
  RAISE EXCEPTION 'party roles v4 contract: service role preview not built: %',array_to_string(miss,'; ');
 END IF;
END $$;
ROLLBACK;
