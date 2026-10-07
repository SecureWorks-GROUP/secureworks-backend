-- Party roles v4 (done-definition row 2, who-to-whom): the biggest groups of
-- messages whose other side is unknown, read from what our records already
-- hold. Measured on production read only on 7 Oct 2026 (last 30 days by
-- capture time, the scorecard's window and lane rule).
--
-- Measured (a first read, 12:13 Perth). Stored stamps name both sides on
-- texts 4,126 of 4,654 (88.7%), calls 1,192 of 1,333 (89.4%), call
-- transcripts 275 of 438 (62.8%), emails in 1,439 of 2,111 (68.2%), emails
-- out 539 of 677 (79.6%); the live v3 classifier reads the same rows the
-- same way (4 texts apart). What the unknown sides are:
--   * Texts 528, calls 141, call transcripts 163: GHL contacts on no job and
--     in no lead list, whose rows carry only the GHL contact id. 135 of them
--     (419 rows: 326 texts, 41 calls, 52 transcripts) have an OPEN
--     OPPORTUNITY in the CRM: the sales booking door caches each pipeline's
--     open opportunities (public.sales_booking_packs, kind roster: 1,060 in
--     the fencing pipeline, 513 in the patio pipeline, each with its GHL
--     contact id, email and phone). Every message was sent no earlier than 7
--     days before its opportunity was created. Where other rules decide a
--     roster contact's rows, 6,909 read customer and 16 contacts read
--     otherwise (our own people, 5 suppliers, a builder), which is why the
--     opportunity is one signal among the rest, never a decision on its own.
--     The other 117 contacts are named by nothing we hold (capture-side).
--   * Why call transcripts sit at 63%: 161 of the 163 read exactly as their
--     call. 92 of the 326 live-writer transcripts (ghl-call-transcript) pair
--     to a call that is itself unknown: transcripts are made for the long
--     answered calls, and a first enquiry from a contact with no job yet is
--     one (94 of 331 calls with a transcript are unknown, 50 of 1,007
--     without). The old writer's 110 transcripts (transcribe-call, 10 to 24
--     Sep, a synthetic call id of contact and time) pair to client.call_complete
--     rows, which sit in no capture lane, so their calls' unknowns never show
--     in the calls lane (69 of 110 unknown). The transcripts follow their
--     calls: 52 of them have an open opportunity.
--   * Emails in 672: 296 from business domains, 164 from automated or
--     platform senders, 92 posted by Xero, 75 from free-mail addresses, 45
--     from gov.au. Our records name 113 of the business senders as
--     suppliers: they are addresses and domains our own mailboxes sent a
--     material order to (our outbound emails whose subject opens "Material
--     Order Ref", "Material Quote Request Ref" or "Material Order Inquiry
--     Ref": 11 supplier domains); every one of their emails another rule
--     decides reads supplier (974 rows, none otherwise). 84 inbound emails
--     name, in their subject, the number of a live Xero bill (ACCPAY) of a
--     known Xero supplier contact (public.suppliers, synced from Xero; every
--     bill contact is one), never one of our own invoice numbers; where
--     another rule decides such an email it reads supplier (100) or our own
--     staff forwarding it (34), never a customer. 8 come from a builder's
--     domain in our records (the domain of a make-safe company's own invoice
--     or report address). 45 are councils (gov.au, the email reader's own
--     council rule): a role, council, where v3 had only the basis.
--   * Emails out 138: our material orders and replies to the same suppliers
--     (81), councils (8), a builder (1), prospects (4).
--   * Our own outbound email from our mailboxes: every such row already reads
--     us. Every emails out row reads staff as its sender, and the 662 copies
--     of our own mail the old poller captured as inbound read staff (basis
--     our_domain). No unknown row is in this group.
--
-- What changes. public.context_message_party_roles(e) is replaced by v4.
-- Rules 1 and 1b (L1d's label or a writer marker, copied; our own crew and
-- staff templates) and every v1 and v2 rule run unchanged and in the same
-- order. Only where v2's rule 10 collects signals does v4 add four, from
-- records only, never from a name or a guess, and a role is still taken only
-- when every signal agrees (else unknown, basis conflict):
--   a. context_party_crm_roles: an open opportunity in the CRM rosters for
--      the row's GHL contact, or for the row's own email or phone, created no
--      more than 30 days after the message (the ladder's lead window):
--      customer, basis open_opportunity. Read with it, never alone: the
--      roster contact's own email and phone against every key rule (users,
--      suppliers, builders, our domains, jobs, parties, leads; basis
--      crm_<rule>), and the crew or staff labels on the contact's other rows
--      (contact_internal_label), so one of our own people with an
--      opportunity reads conflict, not customer. Only on a row placed on no
--      job: on a job whose customer the contact is not, an opportunity
--      elsewhere says nothing about that job's customer (the job record has
--      read any_job_customer that way since 20261006040000); 8 of the 30
--      days' 415 prospect messages sit on such a job and keep their reading.
--   b. context_party_domain_roles: a gov.au domain is a council (role
--      council, basis council_domain); an address one of our material orders
--      went to is a supplier (supplier_order_address), and so is its domain
--      or a subdomain of it unless it is free mail (supplier_order_domain);
--      the domain of an active make-safe company's own invoice or report
--      address, never free mail, our own or the shared portal, is that
--      builder or insurer (builder_domain). A sender pattern that is a whole
--      address still names only that address (v1's rule).
--   c. context_party_xero_bill: an inbound email whose subject names a live
--      Xero bill of a known Xero supplier contact (not one of our users, not
--      a trade invoice bill, not a number we issued or one of our job or PO
--      references) came from a supplier (basis xero_bill).
--   d. Then (rule 11) a call transcript reads as its call. When the call row
--      it names (payload.ghl_call_id, or the ghltx: key) carries a stamp
--      with a known counterpart and the transcript's own reading names other
--      roles, the transcript takes the call's sender, recipient,
--      counterpart, basis and audience, marked from_call (the ladder's own
--      audience on the transcript still wins). The call's basis is kept so
--      every reader reads the transcript as it reads the call (the job
--      record's any_job_customer rule, the ledger's job_customer). A call
--      that reads a customer passes it on only when it sits where the
--      transcript sits (the same job, or both on none): whose customer it is
--      depends on the job; crew, staff, a supplier, a builder or a council
--      are who they are on any job. Where the two agree the transcript keeps
--      its own basis. A transcript's own L1d label (rule 1) wins. Measured:
--      no stored transcript reads otherwise than its call today, so the rule
--      moves no row now; it keeps the two together when a call's reading
--      changes and the transcript's own rules cannot see why.
-- New role: council (audience other_party). Every row is stamped
-- party_roles_v4.
--
-- Effect, emulated in SQL on production read only (a second read, 13:55
-- Perth, the scorecard's lanes, 30 days by capture time), once the hand-run
-- re-stamp below has run: texts 4,134 -> 4,456 of 4,666 (88.6% -> 95.5%),
-- calls 1,195 -> 1,235 of 1,340 (89.2% -> 92.2%), call transcripts 278 -> 324
-- of 439 (63.3% -> 73.8%), emails in 1,441 -> 1,680 of 2,115 (68.1% ->
-- 79.4%), emails out 543 -> 633 of 685 (79.3% -> 92.4%), crew and staff
-- texts 231 -> 243 of 243 (95.1% -> 100%: v3's templates, which no re-stamp
-- had reached). 4 rows go from known to conflict (2 emails out, 1 call, 1
-- transcript), where a new signal disagrees with an old one. Without the
-- re-stamp only new rows read v4. Row 3 (customer messages placed on a job)
-- moves too: 407 prospect messages, none on a job, become customer messages
-- with no job yet, so its share reads 4,685 of 6,557 (71.5%) instead of
-- 4,685 of 6,150 (76.2%) until the scorecard leaves customers with no job
-- out of that denominator; context_party_roles_lanes counts them
-- (no_job_customers).
--
-- New, private: the four helpers above, a partial index on our material
-- orders (business_events_party_material_orders, the 65 outbound emails), and
-- row 2's read for the scorecard, context_party_roles_lanes(as_of, days): per
-- lane the messages, how many name both sides, the unknown ones by basis, the
-- rows still stamped by an older version, and the customers with no job yet (it
-- reads stored stamps, the scorecard's own measure; it replaces no scorecard
-- function).
--
-- Stamps. The trigger context_party_roles_business_event stamps a row on
-- insert and re-stamps it whenever a writer updates job_id, contact_id,
-- direction, metadata, payload, event_type or channel, always with the live
-- classifier, so new rows read v4 from this migration on; a stored row
-- nobody writes keeps its stamp until the separate hand-run re-stamp,
-- scripts/context-party-roles-v4-backfill.sql (dry run first, never run by
-- its author; its undo is scripts/context-party-roles-v4-backfill-undo.sql).
-- A v4 stamp alone is not proof the backfill ran: its run key is. The v3
-- backfill (scripts/context-party-roles-v3-backfill.sql, not run) refuses
-- once v4 is live; the v4 backfill re-stamps its rows too.
--
-- What it never does. It writes no row, moves no row, sets no job_id,
-- attribution, placement or ladder-owned key (recipient_role, audience,
-- recipient_role_source), binds no thread, calls no model or provider, sends
-- nothing, changes no flag, cron job or other grant, and replaces no
-- scorecard function and no ladder or story function.
--
-- Replaced (the guard refuses unless it is the live body or already this
-- migration's):
--   context_message_party_roles(business_events)  36ed4eac4ec8a1b2efd253da02add409 (v3, 20261006034000)
-- Read, not replaced (pinned): context_party_key_roles, context_party_contact_roles,
--   context_party_supplier_key, context_party_user_role,
--   context_party_builder_address, context_stamp_party_roles and its trigger.
-- A later change to the classifier updates the contract touch points AGENTS.md
-- lists (the party roles paragraph).
-- Rollback: supabase/rollbacks/20261007060000_context_party_roles_v4_down.sql
-- restores v3's classifier and comment byte for byte and drops the helpers
-- and the index.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: the live body, or already this migration's.
  ('public.context_message_party_roles(public.business_events)',ARRAY['36ed4eac4ec8a1b2efd253da02add409','54b2f8b4a0bc1810495a7e9186c623b4']),
  -- Read, not replaced.
  ('public.context_party_key_roles(text,text)',ARRAY['4da54e7c7107e927b350947697f440e7']),
  ('public.context_party_contact_roles(text)',ARRAY['8c1f5381cb41d2cdcb0f33b530cc3070']),
  ('public.context_party_supplier_key(text,text)',ARRAY['92a1eb902c4a0aa0aab05d1aa7707352']),
  ('public.context_party_user_role(text,text)',ARRAY['17bdaa22bb55de8635c1dd8563d070d1']),
  ('public.context_party_builder_address(text)',ARRAY['ccd5e9acd5d51228007c3af14054c474']),
  ('public.context_stamp_party_roles()',ARRAY['de974f45ef3174e9391a3d31369df179'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- New: absent, or already this migration's.
 FOR x IN SELECT * FROM (VALUES
  ('public.context_party_crm_roles(text,text,text,timestamp with time zone)','b5b0d82f9d9809cc7f6a7db6b1fde458'),
  ('public.context_party_domain_roles(text)','b4b47ff755117eef8e1f450b015fbc10'),
  ('public.context_party_xero_bill(text)','2aef40c5509b118cee06a35cd951a64f'),
  ('public.context_party_call_roles(public.business_events)','12bef71b8f5a2d3f3c82fd890ed69acc'),
  ('public.context_party_roles_lanes(timestamp with time zone,integer)','ff6797dcd0d2788d01ac1ff21143a18a')
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NOT NULL AND live<>x.accepted THEN problems:=problems||format('%s md5 %s',x.sig,live); END IF;
 END LOOP;
 -- Called, not pinned.
 FOR x IN SELECT * FROM (VALUES ('public.context_email_key(text)'),('public.context_phone_key(text)'),
  ('public.context_event_text(public.business_events)'),('public.context_scorecard_lane_of(text,text,text,text,text,jsonb)')) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s is missing',x.sig); END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.business_events') AND NOT t.tgisinternal
   AND t.tgname='context_party_roles_business_event' AND t.tgfoid=to_regprocedure('public.context_stamp_party_roles()')) THEN
  problems:=problems||'business_events trigger context_party_roles_business_event (party roles, 20261005200000) is missing'::text;
 END IF;
 FOR x IN SELECT * FROM (VALUES
  ('business_events','event_type','text'),('business_events','payload','jsonb'),('business_events','metadata','jsonb'),
  ('business_events','contact_id','text'),('business_events','provider_message_id','text'),
  ('business_events','event_at','timestamp with time zone'),('business_events','occurred_at','timestamp with time zone'),
  ('sales_booking_packs','kind','text'),('sales_booking_packs','payload','jsonb'),
  ('makesafe_companies','invoice_email','text'),('makesafe_companies','report_recipient','text'),('makesafe_companies','active','boolean'),
  ('xero_invoices','invoice_number','text'),('xero_invoices','invoice_type','text'),('xero_invoices','status','text'),
  ('xero_invoices','xero_contact_id','text'),('xero_invoices','xero_invoice_id','text'),
  ('suppliers','xero_contact_id','text'),('users','xero_contact_id','text'),('trade_invoices','xero_bill_id','text')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_party_roles_v4_preimage_mismatch: %; read the live definitions before replacing the party-role classifier',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The CRM's open opportunities for a GHL contact, an email key or a phone
-- key. The sales booking door caches each pipeline's open opportunities
-- (public.sales_booking_packs, kind roster; docs/sales-booking-read-contract-2026-09-16.md):
-- every opportunity listed open in the latest cached roster of a resource
-- (greatest as_of, the door's own read rule) counts, created no more than 30
-- days after the message (the ladder's lead window). Rows, not a decision:
-- the opportunity (customer, open_opportunity), the roles the roster
-- contact's own email and phone point to (crm_<rule>), and the crew or staff
-- labels on the contact's other rows (contact_internal_label), so the
-- classifier sees every signal at once. Each opportunity's email and phone
-- go through the normalisation context_email_key and context_phone_key
-- apply, written out inline: the message's own key is already a valid one,
-- so the comparison is the same as calling them, and much cheaper (both
-- functions carry a SET clause; called per opportunity they cost about 90 ms
-- a message on 7 Oct 2026's 1,573 opportunities, inline about 20 ms).
CREATE OR REPLACE FUNCTION public.context_party_crm_roles(p_contact text,p_email_key text,p_phone_key text,p_at timestamptz)
RETURNS TABLE(r_role text,r_basis text)
LANGUAGE sql STABLE AS $$
 WITH opp AS MATERIALIZED (
  SELECT o.value AS o
  FROM public.sales_booking_packs p
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.payload->'opportunities')='array' THEN p.payload->'opportunities' ELSE '[]'::jsonb END) o
  WHERE p.kind='roster' AND (p_contact IS NOT NULL OR p_email_key IS NOT NULL OR p_phone_key IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.sales_booking_packs q
    WHERE q.kind='roster' AND q.resource=p.resource AND q.week_start=p.week_start AND q.as_of>p.as_of)
   AND o.value->>'status'='open'
   AND ((p_contact IS NOT NULL AND o.value->>'contactId'=p_contact)
    OR (p_email_key IS NOT NULL
     AND lower(btrim(coalesce(substring(o.value->'contact'->>'email' from '<([^<>]*)>'),o.value->'contact'->>'email','')))=p_email_key)
    OR (p_phone_key IS NOT NULL
     AND right(regexp_replace(coalesce(o.value->'contact'->>'phone',''),'[^0-9]','','g'),9)=p_phone_key
     AND regexp_replace(coalesce(o.value->'contact'->>'phone',''),'[^0-9]','','g') !~ '^(\d)\1*$'))
   AND (p_at IS NULL OR CASE WHEN coalesce(o.value->>'createdAt','') ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d'
    THEN p_at>=(o.value->>'createdAt')::timestamptz-interval '30 days' ELSE true END)
 )
 SELECT 'customer'::text,'open_opportunity'::text WHERE EXISTS (SELECT 1 FROM opp)
 UNION ALL
 SELECT kr.r_role,'crm_'||kr.r_basis
 FROM (SELECT DISTINCT opp.o->'contact'->>'email' AS addr, public.context_phone_key(opp.o->'contact'->>'phone') AS pk FROM opp) k
 CROSS JOIN LATERAL public.context_party_key_roles(k.addr,k.pk) kr
 WHERE nullif(btrim(coalesce(k.addr,'')),'') IS NOT NULL OR k.pk IS NOT NULL
 UNION ALL
 -- The contact's other rows that read as ours to crew or staff: the
 -- ladder's or a writer's label, or a stamp from our own templates.
 SELECT DISTINCT CASE WHEN b.metadata->>'recipient_role' IN ('crew','staff') THEN b.metadata->>'recipient_role'
   ELSE b.metadata->'party_roles'->>'recipient_role' END,'contact_internal_label'
 FROM public.business_events b
 WHERE p_contact IS NOT NULL AND b.contact_id=p_contact AND EXISTS (SELECT 1 FROM opp)
  AND (b.metadata->>'recipient_role' IN ('crew','staff')
   OR (b.metadata->'party_roles'->>'basis' IN ('ladder_internal','writer','our_template')
       AND b.metadata->'party_roles'->>'recipient_role' IN ('crew','staff')))
$$;
COMMENT ON FUNCTION public.context_party_crm_roles(text,text,text,timestamptz) IS
 'Party roles v4 (20261007060000): the CRM''s open opportunities (the latest sales_booking_packs roster per resource, status open) for a GHL contact, an email key or a phone key (compared in the keys'' own normalisation), created no more than 30 days after p_at: rows (customer, open_opportunity), the roles the roster contact''s own email and phone point to (crm_<rule>, through context_party_key_roles) and the crew or staff labels on the contact''s other rows (contact_internal_label). Rows, not a decision. Private; read by context_message_party_roles.';

-- 2. What our records say an email address or its domain is. Rows, not a
-- decision. A council: a gov.au domain (the email reader's own council rule,
-- outlook_mail.ts senderKind). A supplier: an address one of our material
-- orders went to (our outbound email whose subject opens "Material Order
-- Ref", "Material Quote Request Ref" or "Material Order Inquiry Ref"), and
-- that address's domain or a subdomain of it unless it is mail anyone can
-- sign up for (v2's free-mail list widened with the other Australian and
-- common providers, since a whole domain is read here). A builder or insurer:
-- the domain, or a subdomain of it, of an active make-safe company's own
-- invoice or report address, never free mail, our own domains or the shared
-- Prime portal (which context_party_builder_address reads).
CREATE OR REPLACE FUNCTION public.context_party_domain_roles(p_address text)
RETURNS TABLE(r_role text,r_basis text)
LANGUAGE sql STABLE AS $$
 WITH fm AS (
  -- Mail anyone can sign up for: never a company's domain.
  SELECT unnest(ARRAY['gmail.com','googlemail.com','hotmail.com','hotmail.com.au','hotmail.co.uk','outlook.com','outlook.com.au','live.com',
   'live.com.au','msn.com','yahoo.com','yahoo.com.au','yahoo.co.uk','ymail.com','rocketmail.com','aol.com','icloud.com','me.com','mac.com',
   'bigpond.com','bigpond.net.au','iinet.net.au','westnet.com.au','westnet.net.au','optusnet.com.au','tpg.com.au','tpgi.com.au',
   'internode.on.net','adam.com.au','aapt.net.au','dodo.com.au','iprimus.com.au','ozemail.com.au','people.net.au','netspace.net.au',
   'exetel.com.au','protonmail.com','proton.me','gmx.com','mail.com','zoho.com','fastmail.com','fastmail.fm']) AS d
 ), k AS (
  SELECT a.addr, split_part(a.addr,'@',2) AS dom, split_part(a.addr,'@',2) IN (SELECT d FROM fm) AS free_mail
  FROM (SELECT CASE WHEN x ~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' THEN x END AS addr
        FROM (SELECT lower(btrim(coalesce(substring(p_address from '<([^<>]*)>'),p_address,''))) AS x) y) a
  WHERE a.addr IS NOT NULL AND split_part(a.addr,'@',2) !~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
 ), orders AS (
  -- The outside addresses our material orders went to.
  SELECT DISTINCT lower(btrim(coalesce(substring(t.a from '<([^<>]*)>'),t.a))) AS addr
  FROM public.business_events b
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE jsonb_typeof(b.payload->'to') WHEN 'array' THEN b.payload->'to'
    WHEN 'string' THEN jsonb_build_array(b.payload->'to') ELSE '[]'::jsonb END) t(a)
  WHERE b.event_type='client.email_out'
   AND coalesce(b.payload->>'subject','') ~* '^\s*material (order|quote request|order inquiry) ref\y'
   AND EXISTS (SELECT 1 FROM k)
 )
 SELECT 'council'::text,'council_domain'::text FROM k WHERE k.dom ~ '(^|\.)gov\.au$'
 UNION ALL
 SELECT 'supplier','supplier_order_address' FROM k WHERE EXISTS (SELECT 1 FROM orders o WHERE o.addr=k.addr)
 UNION ALL
 SELECT 'supplier','supplier_order_domain' FROM k WHERE NOT k.free_mail AND EXISTS (
  SELECT 1 FROM orders o
  WHERE split_part(o.addr,'@',2) ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' AND split_part(o.addr,'@',2) NOT IN (SELECT d FROM fm)
   AND (k.dom=split_part(o.addr,'@',2) OR k.dom LIKE '%.'||split_part(o.addr,'@',2)))
 UNION ALL
 SELECT 'insurer_builder','builder_domain' FROM k WHERE NOT k.free_mail AND k.dom !~ '(^|\.)primeeco\.tech$' AND EXISTS (
  SELECT 1 FROM public.makesafe_companies c
  CROSS JOIN LATERAL (VALUES (c.invoice_email),(c.report_recipient)) v(a)
  CROSS JOIN LATERAL (SELECT split_part(lower(btrim(v.a)),'@',2) AS cdom) d
  WHERE coalesce(c.active,true) AND v.a LIKE '%@%' AND d.cdom ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' AND d.cdom NOT IN (SELECT fm.d FROM fm)
   AND d.cdom !~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au|primeeco\.tech)$'
   AND (k.dom=d.cdom OR k.dom LIKE '%.'||d.cdom))
$$;
COMMENT ON FUNCTION public.context_party_domain_roles(text) IS
 'Party roles v4 (20261007060000): what our records say an email address is: council (a gov.au domain, basis council_domain), supplier (an address one of our material orders went to, supplier_order_address, or its non-free-mail domain or a subdomain, supplier_order_domain) or insurer_builder (the non-free-mail domain of an active make-safe company''s own invoice or report address, builder_domain). Rows, not a decision. Private; read by context_message_party_roles.';

-- 3. A Xero bill named in an email subject: a token of at least 5 letters
-- and digits that is the number of a live bill (ACCPAY, not voided or
-- deleted) whose Xero contact is a known supplier (public.suppliers, synced
-- from Xero) and none of our users (public.users.xero_contact_id), that no
-- trade invoice pushed (trade_invoices.xero_bill_id), and that is none of the
-- numbers we issued and none of our job or PO references.
CREATE OR REPLACE FUNCTION public.context_party_xero_bill(p_subject text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT coalesce(p_subject,'')<>'' AND EXISTS (
  SELECT 1
  FROM regexp_matches(upper(p_subject),'[A-Z0-9][A-Z0-9/-]*[0-9][A-Z0-9/-]*','g') t(m)
  JOIN public.xero_invoices x ON upper(btrim(x.invoice_number))=t.m[1]
  WHERE length(t.m[1])>=5 AND t.m[1] !~ '^(SW[A-Z]{0,3}-?[0-9]{3,}|PO-?[0-9]{4,})$'
   AND x.invoice_type='ACCPAY' AND upper(coalesce(x.status,'')) NOT IN ('VOIDED','DELETED')
   AND EXISTS (SELECT 1 FROM public.suppliers s WHERE s.xero_contact_id=x.xero_contact_id)
   AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.xero_contact_id=x.xero_contact_id)
   AND NOT EXISTS (SELECT 1 FROM public.trade_invoices ti WHERE ti.xero_bill_id=x.xero_invoice_id)
   AND NOT EXISTS (SELECT 1 FROM public.xero_invoices y WHERE y.invoice_type IS DISTINCT FROM 'ACCPAY' AND upper(btrim(y.invoice_number))=t.m[1]))
$$;
COMMENT ON FUNCTION public.context_party_xero_bill(text) IS
 'Party roles v4 (20261007060000): true when an email subject names the number of a live Xero bill (ACCPAY) of a known Xero supplier contact (public.suppliers), not one of our users, not a trade invoice bill, and not a number we issued or one of our job or PO references. Private; read by context_message_party_roles.';

-- 4. The stamp of the call a transcript is the words of: the call row keyed
-- ghl:<payload.ghl_call_id> (the transcript writer's pairing, the same the
-- story's context_ledger_call_customer reads), or ghl:<id> from the
-- transcript's own ghltx:<id> key. Null when there is none, and when the call
-- reads a customer but sits elsewhere than the transcript (another job, or
-- one of them on none): whose customer it is depends on the job. Crew,
-- staff, a supplier, a builder or a council are who they are on any job.
CREATE OR REPLACE FUNCTION public.context_party_call_roles(e public.business_events)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
 SELECT c.metadata->'party_roles'
 FROM public.business_events c
 WHERE e.event_type='call.transcript_completed'
  AND c.provider_message_id='ghl:'||coalesce(nullif(btrim(e.payload->>'ghl_call_id'),''),
   CASE WHEN e.provider_message_id LIKE 'ghltx:%' THEN substr(e.provider_message_id,7) END)
  AND c.event_type<>'call.transcript_completed' AND c.id IS DISTINCT FROM e.id
  AND (c.metadata->'party_roles'->>'counterpart_role' IS DISTINCT FROM 'customer' OR c.job_id IS NOT DISTINCT FROM e.job_id)
 LIMIT 1
$$;
COMMENT ON FUNCTION public.context_party_call_roles(public.business_events) IS
 'Party roles v4 (20261007060000): the party_roles stamp of the call a call transcript is the words of (the row keyed ghl:<payload.ghl_call_id>, or ghl:<id> from the transcript''s ghltx:<id> key), or null: none, or the call reads a customer and sits elsewhere than the transcript (whose customer depends on the job). Private; read by context_message_party_roles.';

-- 5. The party-role classifier, v4.
CREATE OR REPLACE FUNCTION public.context_message_party_roles(e public.business_events) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
 dir text; cid text; raw_addr text; addr text; dom text; ek text; pk text; urole text;
 crole text; cbasis text; aud text; srole text; rrole text; to_first text; roles text[]; conflict text[]; irole text;
 res jsonb; call_pr jsonb;
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
  RETURN jsonb_build_object('version','party_roles_v4','sender_role','staff','recipient_role',e.metadata->>'recipient_role',
   'counterpart_role',e.metadata->>'recipient_role',
   'basis',CASE WHEN e.metadata->>'audience'='internal' THEN 'ladder_internal' ELSE 'writer' END,'audience','internal');
 END IF;

 -- 1b (v3). One of our own crew or staff templates on an outbound text
 -- (the templates context_internal_text_role reads, the reading L1d uses:
 -- ops-api's crew job texts to crew, the office alerts to staff; plus the
 -- roof report wording of the office make-safe alert, which L1d's map does
 -- not name, to crew: its recipients resolve to crew users) went to crew or
 -- staff, whoever the contact is on file as: a crew member's or office
 -- person's contact can also be a job's customer. Before every customer
 -- rule; never re-decides rule 1. The words are read here through
 -- context_event_text with L1d's patterns, not by calling
 -- context_internal_text_role: that helper is private to the ladder (no
 -- service role grant), and the service role previews this classifier. The
 -- scorecard's lane rule reads the same texts.
 IF dir='outbound' AND (e.channel='sms' OR (e.channel IS NULL AND e.event_type IN ('client.sms_out','sms_sent'))) THEN
  irole:=CASE
   WHEN btrim(public.context_event_text(e)) ~ '^(New job assigned|Job ready for crew|New make-safe|New repair): ' THEN 'crew'
   WHEN btrim(public.context_event_text(e)) ~ '^(Docs Ready: |SecureWorks: New make-safe )' THEN 'staff'
   WHEN btrim(public.context_event_text(e)) ~ '^SecureWorks: New roof report make-safe ' THEN 'crew' END;
  IF irole IN ('crew','staff') THEN
   RETURN jsonb_build_object('version','party_roles_v4','sender_role','staff','recipient_role',irole,'counterpart_role',irole,
    'basis','our_template','audience',coalesce(nullif(e.metadata->>'audience',''),'internal'));
  END IF;
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
   -- 10 (v2, widened in v4). Where v1 says unknown: every signal the row's
   -- own email or phone and its GHL contact give, and (v4) what our records
   -- say: the CRM's open opportunities, the domains our records name, a
   -- Xero bill named in an inbound email. One role only when all agree. The
   -- basis tiebreak keeps v2's order first (a row v2 decided keeps its
   -- basis), then v4's, then C order.
   SELECT array_agg(DISTINCT s.r_role COLLATE "C" ORDER BY s.r_role COLLATE "C"),
    (array_agg(s.r_basis ORDER BY array_position(ARRAY['any_job_party','lead','supplier_seen',
      'contact_our_domain','contact_users','contact_supplier','contact_builder_company','contact_supplier_seen',
      'contact_any_job_customer','contact_any_job_party','contact_lead',
      'open_opportunity','supplier_order_address','supplier_order_domain','xero_bill','builder_domain','council_domain'],s.r_basis) NULLS LAST,
      s.r_basis COLLATE "C"))[1]
   INTO roles, cbasis
   FROM (
    -- An address that sent supplier mail is no supplier on its own
    -- customer mail (the row itself is not in the table yet at capture).
    SELECT k.r_role,k.r_basis FROM public.context_party_key_roles(addr,pk) k WHERE (addr IS NOT NULL OR pk IS NOT NULL)
     AND NOT (k.r_basis='supplier_seen' AND e.event_type='client.email_in')
    UNION ALL
    SELECT c.r_role,c.r_basis FROM public.context_party_contact_roles(cid) c WHERE cid IS NOT NULL
    UNION ALL
    -- (v4) A prospect: only on a row placed on no job. On a job whose
    -- customer this contact is not, an opportunity elsewhere says nothing
    -- about that job's customer (as with any_job_customer).
    SELECT m.r_role,m.r_basis FROM public.context_party_crm_roles(cid,ek,pk,coalesce(e.event_at,e.occurred_at)) m
    WHERE e.job_id IS NULL AND (cid IS NOT NULL OR ek IS NOT NULL OR pk IS NOT NULL)
    UNION ALL
    SELECT d.r_role,d.r_basis FROM public.context_party_domain_roles(addr) d WHERE addr IS NOT NULL
    UNION ALL
    -- This row is itself one of our material orders (it is not in the table
    -- yet at capture): its outside recipient is the supplier.
    SELECT 'supplier','supplier_order_address' WHERE dir='outbound' AND addr IS NOT NULL AND e.event_type='client.email_out'
     AND coalesce(e.payload->>'subject','') ~* '^\s*material (order|quote request|order inquiry) ref\y'
    UNION ALL
    SELECT 'supplier','xero_bill' WHERE dir='inbound' AND (e.channel='email' OR e.event_type LIKE '%email%')
     AND public.context_party_xero_bill(e.payload->>'subject')
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
  WHEN crole IN ('supplier','insurer_builder','council') THEN 'other_party' ELSE 'unknown' END);
 srole:=CASE dir WHEN 'outbound' THEN 'staff' WHEN 'internal' THEN 'staff' WHEN 'inbound' THEN crole ELSE 'unknown' END;
 rrole:=CASE dir WHEN 'inbound' THEN 'staff' WHEN 'internal' THEN 'staff' WHEN 'outbound' THEN crole ELSE 'unknown' END;
 res:=jsonb_build_object('version','party_roles_v4','sender_role',srole,'recipient_role',rrole,'counterpart_role',crole,
  'basis',cbasis,'audience',aud)
  || CASE WHEN conflict IS NOT NULL THEN jsonb_build_object('conflicting_roles',to_jsonb(conflict)) ELSE '{}'::jsonb END;

 -- 11 (v4). A call transcript is the words of one call: the same people.
 -- When its call row is stamped with a known counterpart and the
 -- transcript's own reading names other roles, it takes the call's roles,
 -- basis and audience, marked from_call (the ladder's own audience on the
 -- transcript still wins, as everywhere). A call that reads a customer
 -- passes it on only when it sits where the transcript sits (the same job,
 -- or both on none): whose customer it is depends on the job
 -- (context_party_call_roles). The call's basis is kept, so a reader that
 -- reads job_customer or any_job_customer reads the transcript as it reads
 -- the call. Where they agree the transcript keeps its own basis.
 IF e.event_type='call.transcript_completed' THEN
  call_pr:=public.context_party_call_roles(e);
  IF jsonb_typeof(call_pr)='object' AND coalesce(call_pr->>'counterpart_role','unknown') NOT IN ('unknown','')
   AND coalesce(call_pr->>'sender_role','unknown') NOT IN ('unknown','') AND coalesce(call_pr->>'recipient_role','unknown') NOT IN ('unknown','')
   AND (res->>'sender_role',res->>'recipient_role',res->>'counterpart_role')
    IS DISTINCT FROM (call_pr->>'sender_role',call_pr->>'recipient_role',call_pr->>'counterpart_role') THEN
   res:=jsonb_build_object('version','party_roles_v4','sender_role',call_pr->>'sender_role','recipient_role',call_pr->>'recipient_role',
    'counterpart_role',call_pr->>'counterpart_role','basis',coalesce(nullif(call_pr->>'basis',''),'unknown'),'from_call',true,
    'audience',coalesce(nullif(e.metadata->>'audience',''),nullif(call_pr->>'audience',''),'unknown'));
  END IF;
 END IF;
 RETURN res;
END $$;
COMMENT ON FUNCTION public.context_message_party_roles(public.business_events) IS
 'Party roles v4 (20261007060000): for a message row (text, call, call transcript, email) {version, sender_role, recipient_role, counterpart_role, basis, audience[, conflicting_roles][, from_call]}; roles customer, crew, staff, supplier, insurer_builder, council or unknown; our side is staff. L1d''s internal label and an undecided writer marker are copied, never re-decided; our own crew and staff templates on an outbound text read to crew or staff (basis our_template); then v1''s (20261005200000) and v2''s (20261006000000) rules run unchanged, and where v2 collects signals v4 adds what our records say: an open opportunity in the CRM rosters (customer, open_opportunity), a council by its gov.au domain, a supplier by our material orders or a Xero bill named in an inbound email, a builder by its company''s own invoice or report domain; one role only when every signal agrees. A prospect is read only on a row placed on no job. A call transcript reads as its call where the two differ (the call''s roles, basis and audience, from_call true; a call''s customer only from a call placed where the transcript is). Null for any other row. Computes; never places, never writes. Service role may call it to preview.';

-- 6. Row 2's read (who-to-whom), for the scorecard: per message lane, over
-- the rows captured in the window (capture time, the scorecard's), how many
-- name both sides, why the rest do not (unknown sides by basis), how many
-- still carry a stamp from an older classifier version than the live one
-- (a hand-run re-stamp has not reached them, or would change only the
-- version name), and how many are customers with no job yet (a prospect or a
-- lead, the transcript of such a customer's call included: no job exists for
-- them to be placed on).
-- Reads stored stamps only; never classifies a stored row, writes nothing.
CREATE OR REPLACE FUNCTION public.context_party_roles_lanes(p_as_of timestamptz DEFAULT now(), p_days integer DEFAULT 30)
RETURNS TABLE(lane text, messages bigint, stamped bigint, both_known bigint, both_known_pct numeric, older_stamps bigint,
 unknown_by_basis jsonb, no_job_customers bigint, no_job_customers_on_a_job bigint, live_version text)
LANGUAGE sql STABLE AS $$
 WITH v AS (
  -- The version the live classifier stamps, read from the classifier itself.
  SELECT public.context_message_party_roles(jsonb_populate_record(NULL::public.business_events,
   '{"channel":"sms","direction":"inbound","event_type":"client.reply","payload":{},"metadata":{}}'::jsonb))->>'version' AS live
 ), r AS (
  SELECT l.lane, b.job_id, b.metadata->'party_roles' AS pr
  FROM public.business_events b
  CROSS JOIN LATERAL (SELECT public.context_scorecard_lane_of(b.event_type,b.source,b.channel,b.direction,b.body_preview,b.metadata) AS lane) l
  WHERE coalesce(b.context_captured_at,b.recorded_at)>coalesce(p_as_of,now())-make_interval(days=>greatest(coalesce(p_days,30),1))
   AND coalesce(b.context_captured_at,b.recorded_at)<=coalesce(p_as_of,now())
   AND l.lane IN ('texts','calls','call_transcripts','emails_in','emails_out','crew_staff_texts')
 ), k AS (
  SELECT r.lane, r.job_id, r.pr,
   (coalesce(r.pr->>'sender_role','unknown') NOT IN ('unknown','') AND coalesce(r.pr->>'recipient_role','unknown') NOT IN ('unknown','')) AS known,
   -- A customer with no job yet: a prospect or a lead (a transcript keeps
   -- its call's basis).
   (r.pr->>'counterpart_role'='customer' AND r.pr->>'basis' IN ('open_opportunity','lead','contact_lead')) AS no_job_customer
  FROM r
 ), u AS (
  SELECT x.lane, jsonb_object_agg(x.basis,x.n) AS by_basis
  FROM (SELECT k.lane, coalesce(k.pr->>'basis','none') AS basis, count(*) AS n FROM k WHERE NOT k.known GROUP BY 1,2) x
  GROUP BY x.lane
 )
 SELECT k.lane, count(*), count(*) FILTER (WHERE k.pr IS NOT NULL), count(*) FILTER (WHERE k.known),
  round(100.0*count(*) FILTER (WHERE k.known)/nullif(count(*),0),1),
  count(*) FILTER (WHERE k.pr IS NOT NULL AND k.pr->>'version' IS DISTINCT FROM (SELECT v.live FROM v)),
  coalesce((SELECT u.by_basis FROM u WHERE u.lane=k.lane),'{}'::jsonb),
  count(*) FILTER (WHERE k.no_job_customer), count(*) FILTER (WHERE k.no_job_customer AND k.job_id IS NOT NULL),
  (SELECT v.live FROM v)
 FROM k GROUP BY k.lane ORDER BY k.lane COLLATE "C"
$$;
COMMENT ON FUNCTION public.context_party_roles_lanes(timestamptz,integer) IS
 'Party roles v4 (20261007060000): row 2''s read for the scorecard. Per message lane (context_scorecard_lane_of: texts, calls, call_transcripts, emails_in, emails_out, crew_staff_texts) over the rows captured in (p_as_of - p_days, p_as_of]: messages, stamped, both_known (sender and recipient roles known), both_known_pct, older_stamps (stamped by an older classifier version than live_version; the hand-run re-stamp rewrites those the live classifier reads differently and leaves those that would gain only a version name), unknown_by_basis ({basis: rows} for the rest), no_job_customers (customer on basis open_opportunity, lead or contact_lead, a transcript that took such a call''s roles included: no job exists to place them on) and how many of those are on a job anyway. Reads stored stamps only; writes nothing.';

-- 7. Our material orders, for context_party_domain_roles (partial, small:
-- the predicate is the one that function reads).
CREATE INDEX IF NOT EXISTS business_events_party_material_orders ON public.business_events(occurred_at)
 WHERE event_type='client.email_out' AND coalesce(payload->>'subject','') ~* '^\s*material (order|quote request|order inquiry) ref\y';
COMMENT ON INDEX public.business_events_party_material_orders IS
 'Party roles v4 (20261007060000): our outbound material orders (subject opens Material Order Ref, Material Quote Request Ref or Material Order Inquiry Ref), whose recipients context_party_domain_roles reads as suppliers.';

-- 8. Grants, as before: nothing reachable by the public key or a signed-in
-- login; the service role may call each (previews and the backfill).
REVOKE ALL ON FUNCTION
 public.context_party_crm_roles(text,text,text,timestamptz),
 public.context_party_domain_roles(text),
 public.context_party_xero_bill(text),
 public.context_party_call_roles(public.business_events),
 public.context_party_roles_lanes(timestamptz,integer),
 public.context_message_party_roles(public.business_events)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_party_crm_roles(text,text,text,timestamptz),
 public.context_party_domain_roles(text),
 public.context_party_xero_bill(text),
 public.context_party_call_roles(public.business_events),
 public.context_party_roles_lanes(timestamptz,integer),
 public.context_message_party_roles(public.business_events)
TO service_role;
