-- Party roles v2: fewer unknown parties (row 2 follow-up to B-6, #962).
--
-- Why. After #962's backfill, 16,249 message rows carry party_roles and both
-- sides are known on 10,378 (64%). The rest is mostly "unknown -> staff"
-- (inbound from a contact on no job) and "staff -> unknown". Most of those
-- are GHL texts and calls: the row carries a GHL contact id and nothing else,
-- so v1 can only match the contact to a job.
--
-- What changes. public.context_message_party_roles(e) is replaced. Every v1
-- rule (1 to 9 in 20261005200000) runs first, unchanged and in the same
-- order, so a row v1 decided reads exactly the same apart from
-- version party_roles_v2. Only where v1 ends in unknown does v2 look further,
-- at facts the data already holds:
--   a. the row's own email or phone (when it has one): a party (job_contacts)
--      on any job (any_job_party); a lead in contact_matches (lead); an
--      address that has sent supplier mail and never customer mail
--      (supplier_seen);
--   b. the row's GHL contact:
--      - a lead: a contact_matches row (GHL lead and attribution capture),
--        a GHL opportunity stage change (ghl.stage_changed, unless its
--        pipeline is named for recruiting, crew, staff, suppliers or trades),
--        a GHL appointment (client.appointment, ghl.appointment_*), or a
--        sales booking executed for the contact (lead);
--      - the email addresses and phone numbers the contact is known by
--        (contact_matches, and the phone/email keys on its other rows, at
--        most its 50 newest), each read against every key rule: our
--        domains, public.users (crew or staff), public.suppliers, the
--        insurer/builder companies, an address seen sending supplier mail,
--        a job's client email or phone, a job party, a lead
--        (contact_<rule>).
-- Never a guess: every signal is collected and a role is taken only when all
-- of them name the same role. When they disagree the row stays unknown with
-- basis conflict and conflicting_roles listing what disagreed.
--
-- What it never does (unchanged from v1). L1d's internal rows and undecided
-- writer markers are copied as they are, never re-decided (rule 1 is the
-- first rule, untouched). It never sets job_id, attribution or any placement
-- key, never writes recipient_role, audience or recipient_role_source, never
-- moves a row, binds no thread, calls no model or provider, sends nothing.
-- This migration writes no row; existing rows are re-stamped only by the
-- separate hand-run backfill (data/cio-ctx-roles-unknown/backfill.sql, dry
-- run first), through the same live trigger.
--
-- Replaced: public.context_message_party_roles(public.business_events)
--   (20261005200000 body, md5 786fa5e9c40aa3845184fe78519fb5ee).
-- New, private: context_party_supplier_key(text,text),
--   context_party_key_roles(text,text), context_party_contact_roles(text),
--   indexes business_events_party_contact_keys,
--   business_events_party_lead_contact, business_events_party_mail_from.
-- Read, not replaced (live bodies pinned): context_party_user_role,
--   context_party_builder_address, context_stamp_party_roles and its
--   trigger, context_email_key, context_phone_key.
-- Rollback: supabase/rollbacks/20261006000000_context_party_roles_unknown_down.sql
-- restores the 20261005200000 classifier byte for byte.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_email_key(text)'),('public.context_phone_key(text)')
 ) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s is missing',x.sig); END IF;
 END LOOP;
 -- Read, not replaced: exactly #962's bodies.
 FOR x IN SELECT * FROM (VALUES
  ('public.context_party_user_role(text,text)','17bdaa22bb55de8635c1dd8563d070d1'),
  ('public.context_party_builder_address(text)','ccd5e9acd5d51228007c3af14054c474'),
  ('public.context_stamp_party_roles()','de974f45ef3174e9391a3d31369df179')
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.accepted THEN problems:=problems||format('%s md5 %s, expected %s',x.sig,coalesce(live,'<missing>'),x.accepted); END IF;
 END LOOP;
 -- Replaced: #962's body, or already this migration's.
 live:=NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_message_party_roles(public.business_events)');
 IF live IS NULL OR live NOT IN ('786fa5e9c40aa3845184fe78519fb5ee','8d5bb9cfa80a631ee39497282e54f967') THEN
  problems:=problems||format('public.context_message_party_roles(public.business_events) md5 %s',coalesce(live,'<missing>'));
 END IF;
 -- New: absent, or already this migration's.
 FOR x IN SELECT * FROM (VALUES
  ('public.context_party_supplier_key(text,text)','92a1eb902c4a0aa0aab05d1aa7707352'),
  ('public.context_party_key_roles(text,text)','4da54e7c7107e927b350947697f440e7'),
  ('public.context_party_contact_roles(text)','8c1f5381cb41d2cdcb0f33b530cc3070')
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NOT NULL AND live<>x.accepted THEN problems:=problems||format('%s md5 %s',x.sig,live); END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.business_events') AND NOT t.tgisinternal
   AND t.tgname='context_party_roles_business_event' AND t.tgfoid=to_regprocedure('public.context_stamp_party_roles()')) THEN
  problems:=problems||'business_events trigger context_party_roles_business_event (party roles, 20261005200000) is missing'::text;
 END IF;
 FOR x IN SELECT * FROM (VALUES
  ('business_events','contact_id','text'),('business_events','event_type','text'),('business_events','payload','jsonb'),
  ('business_events','occurred_at','timestamp with time zone'),
  ('jobs','client_email','text'),('jobs','client_phone','text'),
  ('job_contacts','client_email','text'),('job_contacts','client_phone','text'),
  ('contact_matches','ghl_contact_id','text'),('contact_matches','email','text'),('contact_matches','phone','text'),
  ('sales_booking_executions','contact_id','text'),
  ('suppliers','email','text'),('suppliers','phone','text')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_party_roles_v2_preimage_mismatch: %; read the live definitions before replacing the party-role classifier',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. A supplier by email key or phone key: the supplier's own address, its
-- domain or a subdomain of it (never a free-mail domain), or its phone. The
-- same test v1 ran inline for the row's own address.
CREATE OR REPLACE FUNCTION public.context_party_supplier_key(p_email_key text,p_phone_key text) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT (p_email_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.suppliers s WHERE s.email LIKE '%@%' AND (lower(btrim(s.email))=p_email_key
   OR (split_part(p_email_key,'@',2) NOT IN ('gmail.com','googlemail.com','hotmail.com','hotmail.com.au','outlook.com','outlook.com.au','live.com','live.com.au',
       'yahoo.com','yahoo.com.au','bigpond.com','bigpond.net.au','icloud.com','me.com','iinet.net.au','optusnet.com.au','westnet.com.au')
    AND (split_part(p_email_key,'@',2)=lower(btrim(split_part(s.email,'@',2)))
     OR split_part(p_email_key,'@',2) LIKE '%.'||lower(btrim(split_part(s.email,'@',2))))))))
  OR (p_phone_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.suppliers s WHERE public.context_phone_key(s.phone)=p_phone_key))
$$;
COMMENT ON FUNCTION public.context_party_supplier_key(text,text) IS
 'Party roles v2 (20261006000000): true when an email key or phone key is a supplier''s (address, non-free-mail domain or subdomain, or phone in public.suppliers). Private; read by context_message_party_roles and context_party_key_roles.';

-- 2. Every role one email address and one phone key point to, with why.
-- Rows, not a decision: the classifier takes a role only when all agree.
CREATE OR REPLACE FUNCTION public.context_party_key_roles(p_address text,p_phone_key text) RETURNS TABLE(r_role text,r_basis text)
LANGUAGE sql STABLE AS $$
 WITH k AS (
  SELECT a.addr, split_part(a.addr,'@',2) AS dom, public.context_email_key(a.addr) AS ek, nullif(btrim(coalesce(p_phone_key,'')),'') AS pk
  FROM (SELECT CASE WHEN x ~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' THEN x END AS addr
        FROM (SELECT lower(btrim(coalesce(substring(p_address from '<([^<>]*)>'),p_address,''))) AS x) y) a
 )
 SELECT 'staff'::text,'our_domain'::text FROM k WHERE k.dom ~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
 UNION ALL
 SELECT u.r,'users' FROM k CROSS JOIN LATERAL (SELECT public.context_party_user_role(k.ek,k.pk) AS r) u
  WHERE (k.ek IS NOT NULL OR k.pk IS NOT NULL) AND u.r IS NOT NULL
 UNION ALL
 SELECT 'supplier','supplier' FROM k WHERE (k.ek IS NOT NULL OR k.pk IS NOT NULL) AND public.context_party_supplier_key(k.ek,k.pk)
 UNION ALL
 SELECT 'insurer_builder','builder_company' FROM k WHERE k.addr IS NOT NULL AND public.context_party_builder_address(k.addr)
 UNION ALL
 SELECT 'supplier','supplier_seen' FROM k WHERE k.ek IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.business_events b WHERE b.event_type='supplier.email_in'
   AND lower(btrim(coalesce(substring(b.payload->>'from' from '<([^<>]*)>'),b.payload->>'from')))=k.ek)
  AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.event_type='client.email_in'
   AND lower(btrim(coalesce(substring(b.payload->>'from' from '<([^<>]*)>'),b.payload->>'from')))=k.ek)
 UNION ALL
 SELECT 'customer','any_job_customer' FROM k
  WHERE (k.ek IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE lower(btrim(j.client_email))=k.ek))
   OR (k.pk IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE right(regexp_replace(j.client_phone,'[^0-9]','','g'),9)=k.pk))
 UNION ALL
 SELECT 'customer','any_job_party' FROM k
  WHERE (k.ek IS NOT NULL AND EXISTS (SELECT 1 FROM public.job_contacts jc WHERE public.context_email_key(jc.client_email)=k.ek))
   OR (k.pk IS NOT NULL AND EXISTS (SELECT 1 FROM public.job_contacts jc WHERE public.context_phone_key(jc.client_phone)=k.pk))
 UNION ALL
 SELECT 'customer','lead' FROM k
  WHERE (k.ek IS NOT NULL AND EXISTS (SELECT 1 FROM public.contact_matches m WHERE public.context_email_key(m.email)=k.ek))
   OR (k.pk IS NOT NULL AND EXISTS (SELECT 1 FROM public.contact_matches m WHERE public.context_phone_key(m.phone)=k.pk))
$$;
COMMENT ON FUNCTION public.context_party_key_roles(text,text) IS
 'Party roles v2 (20261006000000): every role an email address and a phone key point to, one row per signal (role, basis): our_domain, users, supplier, builder_company, supplier_seen (sent supplier mail, never customer mail), any_job_customer, any_job_party, lead (contact_matches). Private; read by context_message_party_roles.';

-- 3. Every role a GHL contact points to: a lead (contact_matches, an
-- opportunity stage change outside the recruiting/crew/staff/supplier/trade
-- pipelines, an appointment, an executed sales booking), and every role of
-- the addresses and phones it is known by (contact_<basis>).
CREATE OR REPLACE FUNCTION public.context_party_contact_roles(p_contact text) RETURNS TABLE(r_role text,r_basis text)
LANGUAGE sql STABLE AS $$
 SELECT 'customer'::text,'lead'::text WHERE p_contact IS NOT NULL AND (
  EXISTS (SELECT 1 FROM public.contact_matches m WHERE m.ghl_contact_id=p_contact)
  OR EXISTS (SELECT 1 FROM public.sales_booking_executions x WHERE x.contact_id=p_contact)
  OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.contact_id=p_contact
   AND b.event_type IN ('ghl.stage_changed','client.appointment','ghl.appointment_created','ghl.appointment_updated','ghl.appointment_deleted')
   AND coalesce(b.payload->>'pipeline','') !~* '(recruit|crew|staff|employ|hiring|supplier|subcontract|trade)'))
 UNION ALL
 SELECT kr.r_role,'contact_'||kr.r_basis
 FROM (
  SELECT DISTINCT k.addr, k.pk FROM (
   SELECT m.email AS addr, public.context_phone_key(m.phone) AS pk FROM public.contact_matches m WHERE m.ghl_contact_id=p_contact
   UNION ALL
   SELECT v.addr, v.pk FROM (
    SELECT b.payload FROM public.business_events b
    WHERE p_contact IS NOT NULL AND b.contact_id=p_contact
     AND b.payload ?| ARRAY['phone','customer_phone','contact_phone','email','customer_email','contact_email']
    ORDER BY b.occurred_at DESC NULLS LAST LIMIT 50
   ) r CROSS JOIN LATERAL (VALUES
    (r.payload->>'email',public.context_phone_key(r.payload->>'phone')),
    (r.payload->>'customer_email',public.context_phone_key(r.payload->>'customer_phone')),
    (r.payload->>'contact_email',public.context_phone_key(r.payload->>'contact_phone'))
   ) v(addr,pk)
  ) k
  WHERE p_contact IS NOT NULL AND (nullif(btrim(coalesce(k.addr,'')),'') IS NOT NULL OR k.pk IS NOT NULL)
 ) l CROSS JOIN LATERAL public.context_party_key_roles(l.addr,l.pk) kr
$$;
COMMENT ON FUNCTION public.context_party_contact_roles(text) IS
 'Party roles v2 (20261006000000): every role a GHL contact points to, one row per signal (role, basis): lead (contact_matches, a sales-pipeline stage change, an appointment, an executed sales booking), and contact_<basis> for each email or phone the contact is known by (contact_matches and the phone/email keys of its 50 newest rows) read through context_party_key_roles. Private; read by context_message_party_roles.';

-- 4. The classifier. Rules 1 to 9 are v1's, unchanged; v2 only adds what
-- runs where v1 would say unknown.
CREATE OR REPLACE FUNCTION public.context_message_party_roles(e public.business_events) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
 dir text; cid text; raw_addr text; addr text; dom text; ek text; pk text; urole text;
 crole text; cbasis text; aud text; srole text; rrole text; to_first text; roles text[]; conflict text[];
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
  RETURN jsonb_build_object('version','party_roles_v2','sender_role','staff','recipient_role',e.metadata->>'recipient_role',
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
   OR public.context_party_supplier_key(ek,pk) THEN
   crole:='supplier'; cbasis:='supplier';
  ELSIF public.context_party_builder_address(addr) THEN crole:='insurer_builder'; cbasis:='builder_company';
  ELSIF (cid IS NOT NULL AND (EXISTS (SELECT 1 FROM public.jobs j WHERE j.ghl_contact_id=cid)
      OR EXISTS (SELECT 1 FROM public.job_contacts jc WHERE jc.ghl_contact_id=cid)))
   OR (ek IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE lower(btrim(j.client_email))=ek))
   OR (pk IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE right(regexp_replace(j.client_phone,'[^0-9]','','g'),9)=pk)) THEN
   crole:='customer'; cbasis:='any_job_customer';
  ELSE
   -- 10 (v2). Where v1 says unknown: every signal the row's own email or
   -- phone and its GHL contact give. One role only when all agree.
   SELECT array_agg(DISTINCT s.r_role ORDER BY s.r_role),
    (array_agg(s.r_basis ORDER BY array_position(ARRAY['any_job_party','lead','supplier_seen',
      'contact_our_domain','contact_users','contact_supplier','contact_builder_company','contact_supplier_seen',
      'contact_any_job_customer','contact_any_job_party','contact_lead'],s.r_basis) NULLS LAST,s.r_basis))[1]
   INTO roles, cbasis
   FROM (
    -- An address that sent supplier mail is no supplier on its own
    -- customer mail (the row itself is not in the table yet at capture).
    SELECT k.r_role,k.r_basis FROM public.context_party_key_roles(addr,pk) k WHERE (addr IS NOT NULL OR pk IS NOT NULL)
     AND NOT (k.r_basis='supplier_seen' AND e.event_type='client.email_in')
    UNION ALL
    SELECT c.r_role,c.r_basis FROM public.context_party_contact_roles(cid) c WHERE cid IS NOT NULL
   ) s;
   IF cardinality(roles)=1 THEN crole:=roles[1];
   ELSIF cardinality(roles)>1 THEN crole:='unknown'; cbasis:='conflict'; conflict:=roles;
   ELSE
    crole:='unknown';
    cbasis:=CASE WHEN dom ~ '(^|\.)gov\.au$' OR e.payload->>'sender_kind'='council' THEN 'council'
     WHEN e.payload->>'sender_kind'='automated' THEN 'automated'
     WHEN e.metadata->>'audience'='other_party' THEN 'not_job_customer'
     WHEN cid IS NULL AND addr IS NULL AND pk IS NULL THEN 'no_contact'
     ELSE 'no_match' END;
   END IF;
  END IF;
 END IF;

 aud:=coalesce(nullif(e.metadata->>'audience',''),CASE WHEN crole IN ('crew','staff') THEN 'internal' WHEN crole='customer' THEN 'customer'
  WHEN crole IN ('supplier','insurer_builder') THEN 'other_party' ELSE 'unknown' END);
 srole:=CASE dir WHEN 'outbound' THEN 'staff' WHEN 'internal' THEN 'staff' WHEN 'inbound' THEN crole ELSE 'unknown' END;
 rrole:=CASE dir WHEN 'inbound' THEN 'staff' WHEN 'internal' THEN 'staff' WHEN 'outbound' THEN crole ELSE 'unknown' END;
 RETURN jsonb_build_object('version','party_roles_v2','sender_role',srole,'recipient_role',rrole,'counterpart_role',crole,
  'basis',cbasis,'audience',aud)
  || CASE WHEN conflict IS NOT NULL THEN jsonb_build_object('conflicting_roles',to_jsonb(conflict)) ELSE '{}'::jsonb END;
END $$;
COMMENT ON FUNCTION public.context_message_party_roles(public.business_events) IS
 'Party roles v2 (20261006000000): for a message row (text, call, call transcript, email) {version, sender_role, recipient_role, counterpart_role, basis, audience[, conflicting_roles]}; roles customer, crew, staff, supplier, insurer_builder or unknown; our side is staff. v1''s rules (20261005200000) run first, unchanged; where they end in unknown, the row''s own email/phone and its GHL contact (leads, the addresses and phones it is known by) are read, and a role is taken only when every signal agrees (else unknown, basis conflict). L1d''s internal label and an undecided writer marker are copied, never re-decided. Null for any other row. Computes; never places, never writes. Service role may call it to preview.';

-- 5. Lookups for v2's contact and address signals (all partial, small).
CREATE INDEX IF NOT EXISTS business_events_party_contact_keys ON public.business_events(contact_id,occurred_at DESC)
 WHERE contact_id IS NOT NULL AND payload ?| ARRAY['phone','customer_phone','contact_phone','email','customer_email','contact_email'];
COMMENT ON INDEX public.business_events_party_contact_keys IS
 'Party roles v2 (20261006000000): the rows of a GHL contact that carry a phone or email, read by context_party_contact_roles.';
CREATE INDEX IF NOT EXISTS business_events_party_lead_contact ON public.business_events(contact_id)
 WHERE event_type IN ('ghl.stage_changed','client.appointment','ghl.appointment_created','ghl.appointment_updated','ghl.appointment_deleted');
COMMENT ON INDEX public.business_events_party_lead_contact IS
 'Party roles v2 (20261006000000): GHL contacts with an opportunity stage change or an appointment (leads), read by context_party_contact_roles.';
CREATE INDEX IF NOT EXISTS business_events_party_mail_from ON public.business_events((lower(btrim(coalesce(substring(payload->>'from' from '<([^<>]*)>'),payload->>'from')))))
 WHERE event_type IN ('supplier.email_in','client.email_in');
COMMENT ON INDEX public.business_events_party_mail_from IS
 'Party roles v2 (20261006000000): who sent supplier and customer mail, by address, read by context_party_key_roles (supplier_seen).';

-- 6. Grants: nothing reachable by the public key or a signed-in login; the
-- helpers are readable by the service role for previews and the backfill.
REVOKE ALL ON FUNCTION
 public.context_party_supplier_key(text,text),
 public.context_party_key_roles(text,text),
 public.context_party_contact_roles(text),
 public.context_message_party_roles(public.business_events)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_party_supplier_key(text,text),
 public.context_party_key_roles(text,text),
 public.context_party_contact_roles(text),
 public.context_message_party_roles(public.business_events)
TO service_role;
