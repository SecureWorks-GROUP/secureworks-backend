-- Party roles (gap plan B-6): every message row says who sent it and who
-- received it.
--
-- Why (owner's ruling, 5 Oct 2026): "It should be able to distinguish who's
-- communicating to who because we should actually have crew communication in
-- there to an extent ... but obviously you should be able to tell the
-- difference between who's communicating to who."
--
-- What it does. One classifier, public.context_message_party_roles(e),
-- reads a business_events message row (a text, call, call transcript or
-- email, in or out) and returns metadata.party_roles:
--   {version, sender_role, recipient_role, counterpart_role, basis, audience}
-- Roles are customer, crew, staff, supplier, insurer_builder or unknown.
-- Our side of a message (our five lines, our mailboxes) is staff. The other
-- side (the counterpart) is decided from facts the data already holds, first
-- match wins:
--   1. L1d's label (20261005090000): a row the ladder marked
--      metadata.audience internal with recipient_role crew or staff, or a
--      writer-marked crew/staff text the ladder has not decided yet, is
--      copied as it is (basis ladder_internal / writer). Never re-decided.
--   2. internal direction (staff.email_internal): staff to staff.
--   3. one of our domains: staff (our_domain).
--   4. this job's customer: jobs.ghl_contact_id, client_email or client_phone
--      (job_customer); a party on this job in job_contacts (job_party).
--   5. a person in public.users by email or phone: crew for the installer
--      roles, staff otherwise (users).
--   6. a GHL contact our own tools have texted as crew or staff (a writer
--      marker on an earlier row, writer_marked_contact).
--   7. a supplier: a supplier.* event, sender_kind supplier, or the address,
--      domain or phone of public.suppliers (supplier).
--   8. an insurer or builder: makesafe_companies sender_patterns,
--      invoice_email or report_recipient, or Prime's notification domain
--      primeeco.tech (builder_company).
--   9. the customer or a party of any other job (any_job_customer).
--  10. otherwise unknown, with why (council, automated, not_job_customer
--      for L1d's other_party rows, no_contact, no_match).
-- audience is the ladder's metadata.audience when it set one, else internal
-- for crew/staff, customer for a customer, other_party for supplier and
-- insurer_builder, unknown otherwise.
--
-- Where it runs. A new BEFORE INSERT OR UPDATE trigger,
-- context_party_roles_business_event, stamps metadata.party_roles on every
-- message row. Trigger names fire in alphabetical order, so it runs after
-- context_attribute_business_event (the ladder) at capture, and after every
-- re-decision that writes job_id, contact_id, direction or metadata
-- (reconsideration, Luna, bucket re-runs, a hand relink). A classifier error
-- never blocks capture: the row is stamped unknown with basis error and the
-- SQLSTATE.
--
-- What it never does. It never sets job_id, attribution or any placement key,
-- never writes metadata.recipient_role, metadata.audience or
-- metadata.recipient_role_source (ladder-owned; a ladder-owned recipient_role
-- here would read as a writer marker at the next decision), never moves a row,
-- binds no thread, calls no model, sends nothing. Non-message rows are left
-- without party_roles. Existing rows are stamped only by the separate
-- hand-run backfill (dry run first); this migration writes no row.
--
-- New, private: context_party_user_role(text,text), context_party_builder_address(text),
--   context_message_party_roles(business_events), context_stamp_party_roles(),
--   trigger context_party_roles_business_event, indexes
--   business_events_writer_marked_contact and jobs_ghl_contact_party_roles.
-- Replaced: none. Read, not replaced (live bodies pinned): context_email_key,
--   context_phone_key, attribute_business_event (P4) and its trigger.
-- Rollback: supabase/rollbacks/20261005200000_context_party_roles_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 -- Read, not replaced.
 FOR x IN SELECT * FROM (VALUES
  ('public.context_email_key(text)'),('public.context_phone_key(text)'),('public.attribute_business_event()')
 ) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s is missing',x.sig); END IF;
 END LOOP;
 -- New: absent, or already this migration's.
 FOR x IN SELECT * FROM (VALUES
  ('public.context_party_user_role(text,text)','17bdaa22bb55de8635c1dd8563d070d1'),
  ('public.context_party_builder_address(text)','ccd5e9acd5d51228007c3af14054c474'),
  ('public.context_message_party_roles(public.business_events)','786fa5e9c40aa3845184fe78519fb5ee'),
  ('public.context_stamp_party_roles()','de974f45ef3174e9391a3d31369df179')
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NOT NULL AND live<>x.accepted THEN problems:=problems||format('%s md5 %s',x.sig,live); END IF;
 END LOOP;
 -- The ladder's insert trigger must exist and sort before this one.
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.business_events') AND NOT t.tgisinternal
   AND t.tgname='context_attribute_business_event' AND t.tgfoid=to_regprocedure('public.attribute_business_event()')) THEN
  problems:=problems||'business_events trigger context_attribute_business_event (the ladder) is missing'::text;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.business_events') AND NOT t.tgisinternal
   AND t.tgname='context_party_roles_business_event' AND t.tgfoid<>coalesce(to_regprocedure('public.context_stamp_party_roles()'),0::oid)) THEN
  problems:=problems||'a business_events trigger named context_party_roles_business_event calls another function'::text;
 END IF;
 FOR x IN SELECT * FROM (VALUES
  ('business_events','job_id','uuid'),('business_events','event_type','text'),('business_events','channel','text'),
  ('business_events','direction','text'),('business_events','contact_id','text'),('business_events','payload','jsonb'),
  ('business_events','metadata','jsonb'),('business_events','occurred_at','timestamp with time zone'),
  ('jobs','id','uuid'),('jobs','ghl_contact_id','text'),('jobs','client_email','text'),('jobs','client_phone','text'),
  ('job_contacts','job_id','uuid'),('job_contacts','ghl_contact_id','text'),('job_contacts','client_email','text'),('job_contacts','client_phone','text'),
  ('users','email','text'),('users','phone','text'),('users','role','text'),
  ('suppliers','email','text'),('suppliers','phone','text'),
  ('makesafe_companies','sender_patterns','text[]'),('makesafe_companies','invoice_email','text'),
  ('makesafe_companies','report_recipient','text'),('makesafe_companies','active','boolean')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_party_roles_preimage_mismatch: %; read the live definitions before adding the party-role trigger',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. A person in public.users, by email or phone key: crew for the installer
-- roles, staff for every other role. No row: nothing.
CREATE OR REPLACE FUNCTION public.context_party_user_role(p_email_key text,p_phone_key text) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN lower(coalesce(u.role,'')) IN ('installer','lead_installer','crew','trade','subcontractor','apprentice')
  THEN 'crew' ELSE 'staff' END
 FROM public.users u
 WHERE (p_email_key IS NOT NULL AND lower(btrim(u.email))=p_email_key)
    OR (p_phone_key IS NOT NULL AND public.context_phone_key(u.phone)=p_phone_key)
 ORDER BY CASE WHEN lower(coalesce(u.role,'')) IN ('installer','lead_installer','crew','trade','subcontractor','apprentice') THEN 1 ELSE 0 END
 LIMIT 1
$$;
COMMENT ON FUNCTION public.context_party_user_role(text,text) IS
 'Party roles (20261005200000): crew or staff for a person in public.users matched by email key or phone key (staff wins a tie); null when nobody matches. Private; read by context_message_party_roles.';

-- 2. An insurer or builder address: a makesafe_companies sender pattern (an
-- address pattern matches exactly, a domain pattern matches the domain or a
-- subdomain), invoice_email or report_recipient, or Prime's notification
-- domain (builders dispatch work orders through it).
CREATE OR REPLACE FUNCTION public.context_party_builder_address(p_address text) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT p_address IS NOT NULL AND (
  split_part(p_address,'@',2) ~ '(^|\.)primeeco\.tech$'
  OR EXISTS (SELECT 1 FROM public.makesafe_companies c
   WHERE coalesce(c.active,true) AND (
    lower(btrim(coalesce(c.invoice_email,'')))=p_address
    OR lower(btrim(coalesce(c.report_recipient,'')))=p_address
    OR EXISTS (SELECT 1 FROM unnest(coalesce(c.sender_patterns,'{}'::text[])) s(pat)
     WHERE btrim(s.pat)<>'' AND CASE WHEN position('@' in s.pat)>0 THEN lower(btrim(s.pat))=p_address
      ELSE split_part(p_address,'@',2)=lower(btrim(s.pat)) OR split_part(p_address,'@',2) LIKE '%.'||lower(btrim(s.pat)) END))))
$$;
COMMENT ON FUNCTION public.context_party_builder_address(text) IS
 'Party roles (20261005200000): true when a lower-case address is an insurer or builder (makesafe_companies sender_patterns, invoice_email, report_recipient, or Prime''s primeeco.tech). Private; read by context_message_party_roles.';

-- 3. The classifier.
CREATE OR REPLACE FUNCTION public.context_message_party_roles(e public.business_events) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
 dir text; cid text; raw_addr text; addr text; dom text; ek text; pk text; urole text;
 crole text; cbasis text; aud text; srole text; rrole text; to_first text;
BEGIN
 -- Message rows only: texts, calls, call transcripts, emails (and the older
 -- event types that carry no channel).
 IF NOT (coalesce(e.channel,'') IN ('sms','email','call')
   OR e.event_type IN ('client.reply','client.email_in','client.email_out','client.sms_in','client.sms_out','client.call_complete',
    'client.call_logged','client.message_in','supplier.email_in','staff.email_internal','call.transcript_completed','sms_sent','client_replied'))
 THEN RETURN NULL; END IF;

 dir:=lower(coalesce(e.direction,''));
 IF dir NOT IN ('inbound','outbound','internal') THEN
  dir:=CASE
   WHEN e.event_type IN ('client.reply','client.email_in','client.sms_in','client.message_in','supplier.email_in','client_replied') THEN 'inbound'
   WHEN e.event_type IN ('client.email_out','client.sms_out','sms_sent') THEN 'outbound'
   WHEN e.event_type='staff.email_internal' THEN 'internal'
   ELSE 'unknown' END;
 END IF;

 -- 1. L1d's internal label, or a writer marker the ladder has not decided
 -- yet: copied, never re-decided.
 IF (e.metadata->>'audience'='internal' AND e.metadata->>'recipient_role' IN ('crew','staff'))
   OR (dir='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role'
       AND coalesce(e.metadata->>'recipient_role_source','writer')='writer') THEN
  RETURN jsonb_build_object('version','party_roles_v1','sender_role','staff','recipient_role',e.metadata->>'recipient_role',
   'counterpart_role',e.metadata->>'recipient_role',
   'basis',CASE WHEN e.metadata->>'audience'='internal' THEN 'ladder_internal' ELSE 'writer' END,'audience','internal');
 END IF;

 cid:=nullif(btrim(coalesce(e.contact_id,'')),'');
 -- The counterpart's address: the sender of an inbound row, the outside
 -- recipient of an outbound one (payload.email is the outside party on the
 -- email reader's rows).
 IF jsonb_typeof(e.payload->'to')='array' THEN
  SELECT t.a INTO to_first FROM jsonb_array_elements_text(e.payload->'to') WITH ORDINALITY t(a,n)
  WHERE public.context_email_key(t.a) IS NOT NULL ORDER BY t.n LIMIT 1;
 ELSE to_first:=e.payload->>'to';
 END IF;
 raw_addr:=CASE WHEN dir='inbound' THEN coalesce(e.payload->>'from',e.payload->>'from_email',e.payload->>'sender',e.payload->>'email')
  WHEN dir='outbound' THEN coalesce(e.payload->>'email',to_first,e.payload->>'to_email',e.payload->>'recipient',e.payload->>'customer_email') END;
 addr:=lower(btrim(coalesce(substring(raw_addr from '<([^<>]*)>'),raw_addr,'')));
 IF addr !~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' THEN addr:=NULL; END IF;
 dom:=split_part(addr,'@',2);
 ek:=public.context_email_key(addr);
 pk:=public.context_phone_key(CASE WHEN dir='inbound' THEN coalesce(e.payload->>'phone',e.payload->>'customer_phone',e.payload->>'from_number',
   CASE WHEN position('@' in coalesce(e.payload->>'from',''))=0 THEN e.payload->>'from' END)
  WHEN dir='outbound' THEN coalesce(e.payload->>'customer_phone',e.payload->>'phone',e.payload->>'to_number',
   CASE WHEN jsonb_typeof(e.payload->'to')='string' AND position('@' in coalesce(e.payload->>'to',''))=0 THEN e.payload->>'to' END) END);

 IF dir='internal' THEN crole:='staff'; cbasis:='internal_direction';
 ELSIF dom ~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN crole:='staff'; cbasis:='our_domain';
 ELSIF e.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id=e.job_id AND (
   (cid IS NOT NULL AND j.ghl_contact_id=cid)
   OR (ek IS NOT NULL AND public.context_email_key(j.client_email)=ek)
   OR (pk IS NOT NULL AND public.context_phone_key(j.client_phone)=pk))) THEN crole:='customer'; cbasis:='job_customer';
 ELSIF e.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.job_contacts jc WHERE jc.job_id=e.job_id AND (
   (cid IS NOT NULL AND jc.ghl_contact_id=cid)
   OR (ek IS NOT NULL AND public.context_email_key(jc.client_email)=ek)
   OR (pk IS NOT NULL AND public.context_phone_key(jc.client_phone)=pk))) THEN crole:='customer'; cbasis:='job_party';
 ELSE
  urole:=CASE WHEN ek IS NOT NULL OR pk IS NOT NULL THEN public.context_party_user_role(ek,pk) END;
  IF urole IS NOT NULL THEN crole:=urole; cbasis:='users';
  ELSIF cid IS NOT NULL AND EXISTS (SELECT 1 FROM public.business_events b
    WHERE b.contact_id=cid AND b.metadata->>'recipient_role' IN ('crew','staff')
     AND coalesce(b.metadata->>'recipient_role_source','writer')='writer' AND b.metadata->>'written_as'='service_role') THEN
   SELECT b.metadata->>'recipient_role' INTO crole FROM public.business_events b
   WHERE b.contact_id=cid AND b.metadata->>'recipient_role' IN ('crew','staff')
    AND coalesce(b.metadata->>'recipient_role_source','writer')='writer' AND b.metadata->>'written_as'='service_role'
   ORDER BY b.occurred_at DESC NULLS LAST LIMIT 1;
   cbasis:='writer_marked_contact';
  ELSIF e.event_type LIKE 'supplier.%' OR e.payload->>'sender_kind'='supplier'
   OR (ek IS NOT NULL AND EXISTS (SELECT 1 FROM public.suppliers s WHERE s.email LIKE '%@%' AND (lower(btrim(s.email))=ek
      OR (dom NOT IN ('gmail.com','googlemail.com','hotmail.com','hotmail.com.au','outlook.com','outlook.com.au','live.com','live.com.au',
          'yahoo.com','yahoo.com.au','bigpond.com','bigpond.net.au','icloud.com','me.com','iinet.net.au','optusnet.com.au','westnet.com.au')
       AND (dom=lower(btrim(split_part(s.email,'@',2))) OR dom LIKE '%.'||lower(btrim(split_part(s.email,'@',2))))))))
   OR (pk IS NOT NULL AND EXISTS (SELECT 1 FROM public.suppliers s WHERE public.context_phone_key(s.phone)=pk)) THEN
   crole:='supplier'; cbasis:='supplier';
  ELSIF public.context_party_builder_address(addr) THEN crole:='insurer_builder'; cbasis:='builder_company';
  ELSIF (cid IS NOT NULL AND (EXISTS (SELECT 1 FROM public.jobs j WHERE j.ghl_contact_id=cid)
      OR EXISTS (SELECT 1 FROM public.job_contacts jc WHERE jc.ghl_contact_id=cid)))
   OR (ek IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE lower(btrim(j.client_email))=ek))
   OR (pk IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE right(regexp_replace(j.client_phone,'[^0-9]','','g'),9)=pk)) THEN
   crole:='customer'; cbasis:='any_job_customer';
  ELSE
   crole:='unknown';
   cbasis:=CASE WHEN dom ~ '(^|\.)gov\.au$' OR e.payload->>'sender_kind'='council' THEN 'council'
    WHEN e.payload->>'sender_kind'='automated' THEN 'automated'
    WHEN e.metadata->>'audience'='other_party' THEN 'not_job_customer'
    WHEN cid IS NULL AND addr IS NULL AND pk IS NULL THEN 'no_contact'
    ELSE 'no_match' END;
  END IF;
 END IF;

 aud:=coalesce(nullif(e.metadata->>'audience',''),CASE WHEN crole IN ('crew','staff') THEN 'internal' WHEN crole='customer' THEN 'customer'
  WHEN crole IN ('supplier','insurer_builder') THEN 'other_party' ELSE 'unknown' END);
 srole:=CASE dir WHEN 'outbound' THEN 'staff' WHEN 'internal' THEN 'staff' WHEN 'inbound' THEN crole ELSE 'unknown' END;
 rrole:=CASE dir WHEN 'inbound' THEN 'staff' WHEN 'internal' THEN 'staff' WHEN 'outbound' THEN crole ELSE 'unknown' END;
 RETURN jsonb_build_object('version','party_roles_v1','sender_role',srole,'recipient_role',rrole,'counterpart_role',crole,
  'basis',cbasis,'audience',aud);
END $$;
COMMENT ON FUNCTION public.context_message_party_roles(public.business_events) IS
 'Party roles (20261005200000): for a message row (text, call, call transcript, email) {version, sender_role, recipient_role, counterpart_role, basis, audience}; roles customer, crew, staff, supplier, insurer_builder or unknown; our side is staff. L1d''s internal label and an undecided writer marker are copied, never re-decided. Null for any other row. Computes; never places, never writes. Service role may call it to preview.';

-- 4. The trigger function: stamp metadata.party_roles on a message row, take
-- a stale one off any other row. Never blocks a write.
CREATE OR REPLACE FUNCTION public.context_stamp_party_roles() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb;
BEGIN
 BEGIN
  r:=public.context_message_party_roles(NEW);
 EXCEPTION WHEN OTHERS THEN
  r:=jsonb_build_object('version','party_roles_v1','sender_role','unknown','recipient_role','unknown','counterpart_role','unknown',
   'basis','error','audience','unknown','error',SQLSTATE);
 END;
 IF r IS NULL THEN
  IF NEW.metadata ? 'party_roles' THEN NEW.metadata:=NEW.metadata-'party_roles'; END IF;
 ELSIF NEW.metadata->'party_roles' IS DISTINCT FROM r THEN
  NEW.metadata:=coalesce(NEW.metadata,'{}'::jsonb)||jsonb_build_object('party_roles',r);
 END IF;
 RETURN NEW;
END $$;
COMMENT ON FUNCTION public.context_stamp_party_roles() IS
 'Party roles (20261005200000): BEFORE INSERT OR UPDATE trigger on business_events; stamps metadata.party_roles from context_message_party_roles after the ladder has decided the row. A classifier error stamps unknown with basis error. Writes nothing else. Private.';

-- 5. The contacts our tools have texted as crew or staff (rule 6).
CREATE INDEX IF NOT EXISTS business_events_writer_marked_contact ON public.business_events(contact_id,occurred_at)
 WHERE metadata->>'recipient_role' IN ('crew','staff');
COMMENT ON INDEX public.business_events_writer_marked_contact IS
 'Party roles (20261005200000): contacts our own tools texted as crew or staff, read by context_message_party_roles.';

-- Rule 9 looks up a GHL contact on any job.
CREATE INDEX IF NOT EXISTS jobs_ghl_contact_party_roles ON public.jobs(ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;
COMMENT ON INDEX public.jobs_ghl_contact_party_roles IS
 'Party roles (20261005200000): the job a GHL contact is the customer of, read by context_message_party_roles.';

-- 6. The trigger. Its name sorts after context_attribute_business_event, so
-- at capture it runs after the ladder has placed the row.
DROP TRIGGER IF EXISTS context_party_roles_business_event ON public.business_events;
CREATE TRIGGER context_party_roles_business_event
 BEFORE INSERT OR UPDATE OF job_id,contact_id,direction,metadata,payload,event_type,channel ON public.business_events
 FOR EACH ROW EXECUTE FUNCTION public.context_stamp_party_roles();

-- 7. Grants: nothing reachable by the public key or a signed-in login; the
-- classifier is readable by the service role for previews and the backfill.
REVOKE ALL ON FUNCTION
 public.context_party_user_role(text,text),
 public.context_party_builder_address(text),
 public.context_message_party_roles(public.business_events),
 public.context_stamp_party_roles()
FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_stamp_party_roles() FROM service_role;
GRANT EXECUTE ON FUNCTION
 public.context_party_user_role(text,text),
 public.context_party_builder_address(text),
 public.context_message_party_roles(public.business_events)
TO service_role;
