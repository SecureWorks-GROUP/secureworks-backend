-- Party roles health (done-definition row 2, who-to-whom): three fixes found
-- by measuring production read only on 6 Oct 2026 (last 7 days by capture
-- time, the scorecard's lane rule).
--
-- Measured. 6,163 message rows, 738 (12.0%) with a side unknown (30 days:
-- 1,554 of 8,937, 17.4%). Texts 225 of 3,368, calls 118 of 1,221, call
-- transcripts 88 of 300, emails in 203 of 746, emails out 104 of 492, crew
-- and staff texts 0 of 36. Why:
--   * 431 are GHL texts, calls and transcripts from 92 GHL contacts that are
--     on no job and in no lead list. The GHL writers read an item's from and
--     to numbers only to find our line (_shared/evidence/ghl_message.ts) and
--     keep no number for the other person, so the row has only the GHL
--     contact id; 62 of the 92 have no phone or email anywhere in our data,
--     and the other 30 have a phone that no job, party, lead, user or
--     supplier record names. No database key exists for them (a capture-side
--     change, not this one).
--   * 292 emails name an address no customer, supplier, insurer or builder
--     record holds (mostly business addresses: builders, agents, certifiers,
--     automated senders); 5 GHL emails carry no address; 10 are councils. At
--     most 6 match our own client mail or quote records: too few to justify
--     a new rule.
--   * Call transcripts are not a fault: since 24 Sep every transcript carries
--     its call's id (300 of 300) and reads exactly as its call (0 differ);
--     the 88 unknown transcripts are 88 unknown calls.
--   * Staff not keyed: none in 7 days (L1d labels our crew and staff texts).
--     Before L1d, our own crew and staff template texts were read off the
--     contact: 438 read as messages to a customer (a crew member's or office
--     person's GHL contact is also a job's client on file), 109 unknown, 53
--     crew texts read as staff. Fixed for new rows here (3); old rows by the
--     hand-run script scripts/context-party-roles-v3-backfill.sql.
--
-- What changes.
--   1. context_parties_status() (sites S-M1's block): every heartbeat read
--      failed it with SQLSTATE 22023 (status_block_failed), because an AND
--      does not fix evaluation order and jsonb_array_length ran on a null
--      pricing_json.neighbour_splits (301 live fencing jobs carry null). It
--      also read the wrong shape: the fence tool writes an object with a
--      neighbours list (65 jobs), never a bare array, so the count could
--      never be non-zero.
--      The list is now neighbour_splits.neighbours or a bare array, read
--      through CASE; null, a scalar or an object without a list is none.
--      Production after the fix: 4 of 28 live fencing jobs that list
--      neighbours have no party rows. Nothing else in the block changes.
--   2. context_scorecard_lane_of(...) (W11): the crew and staff lane took any
--      row carrying metadata.recipient_role, so L1d's recipient_role other (a
--      known contact who is not the job's customer, audience other_party)
--      counted as a crew text "not labelled internal" (the 1 of 9 on the
--      card: a history-loaded text to the customer of another job). The lane
--      now takes recipient_role crew or staff, or our crew templates, only.
--   3. context_message_party_roles(e), v3: after rule 1 (L1d's label or a
--      writer marker, copied, never re-decided) one new rule. An outbound
--      text in one of our own crew or staff templates
--      (context_internal_text_role, the same reading L1d uses: "New job
--      assigned:", "Job ready for crew:", "New make-safe:", "New repair:" to
--      crew; "Docs Ready: " and "SecureWorks: New make-safe " to staff) went
--      to crew or staff, basis our_template, audience internal (or the
--      ladder's audience when it set one), whoever the contact is on file
--      as. Every other v1 and v2 rule runs unchanged after it, stamped
--      party_roles_v3.
--
-- What it never does. It writes no row, moves no row, sets no job_id,
-- attribution, placement or ladder-owned key (recipient_role, audience,
-- recipient_role_source), binds no thread, calls no model, sends nothing,
-- changes no flag, cron job or grant. New rows are stamped by the live
-- trigger as they arrive; existing rows change only through the separate
-- hand-run backfill (dry run first, never run by its author).
--
-- Replaced (the guard refuses unless each is the live body or already this
-- migration's):
--   context_parties_status()                                   98ca15b42682e9210ac4e6fe8d74ccd3 (S-M1, 20261002120000)
--   context_scorecard_lane_of(text,text,text,text,text,jsonb)  a7d601b8eaf03a5616df508e8a18b2d6 (W11, 20261006032000)
--   context_message_party_roles(business_events)               8d5bb9cfa80a631ee39497282e54f967 (v2, 20261006000000)
-- Read, not replaced (pinned): context_internal_text_role (L1d),
--   context_stamp_party_roles and its trigger, context_party_user_role,
--   context_party_builder_address, context_party_supplier_key,
--   context_party_key_roles, context_party_contact_roles.
-- Rollback: supabase/rollbacks/20261006034000_context_party_roles_health_down.sql
-- restores the three bodies and comments byte for byte.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: the live body, or already this migration's.
  ('public.context_parties_status()',ARRAY['98ca15b42682e9210ac4e6fe8d74ccd3','5f01b621c22b3cb0840bf04eb32a338f']),
  ('public.context_scorecard_lane_of(text,text,text,text,text,jsonb)',ARRAY['a7d601b8eaf03a5616df508e8a18b2d6','5ee19b3bd8dcb1e0fef0eb5cf8534ceb']),
  ('public.context_message_party_roles(public.business_events)',ARRAY['8d5bb9cfa80a631ee39497282e54f967','3594d653de1505275ae15c419381bbc3']),
  -- Read, not replaced.
  ('public.context_internal_text_role(public.business_events)',ARRAY['e7327d108966e2bcb9d2eb48e3086a55']),
  ('public.context_stamp_party_roles()',ARRAY['de974f45ef3174e9391a3d31369df179']),
  ('public.context_party_user_role(text,text)',ARRAY['17bdaa22bb55de8635c1dd8563d070d1']),
  ('public.context_party_builder_address(text)',ARRAY['ccd5e9acd5d51228007c3af14054c474']),
  ('public.context_party_supplier_key(text,text)',ARRAY['92a1eb902c4a0aa0aab05d1aa7707352']),
  ('public.context_party_key_roles(text,text)',ARRAY['4da54e7c7107e927b350947697f440e7']),
  ('public.context_party_contact_roles(text)',ARRAY['8c1f5381cb41d2cdcb0f33b530cc3070'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- Called, not pinned.
 FOR x IN SELECT * FROM (VALUES ('public.context_email_key(text)'),('public.context_phone_key(text)'),
  ('public.context_event_text(public.business_events)'),('public.automation_lane_enabled(text)'),('public.job_party_flag_on()'),
  ('public.context_business_minutes(timestamptz,timestamptz)'),('public.context_in_business_hours(timestamptz)')) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s is missing',x.sig); END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.business_events') AND NOT t.tgisinternal
   AND t.tgname='context_party_roles_business_event' AND t.tgfoid=to_regprocedure('public.context_stamp_party_roles()')) THEN
  problems:=problems||'business_events trigger context_party_roles_business_event (party roles, 20261005200000) is missing'::text;
 END IF;
 FOR x IN SELECT * FROM (VALUES
  ('jobs','pricing_json','jsonb'),('jobs','archived','boolean'),('job_contacts','is_primary','boolean'),('job_contacts','status','text'),
  ('business_events','channel','text'),('business_events','direction','text'),('business_events','event_type','text'),('business_events','metadata','jsonb')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_party_roles_health_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The parties status block (sites S-M1's slice of the heartbeat).
CREATE OR REPLACE FUNCTION public.context_parties_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 now_time timestamptz:=now(); parties jsonb; invoices jsonb; links jsonb; receipts jsonb; linker jsonb; alarms jsonb:='[]'::jsonb;
 last_ok timestamptz; ever boolean; lane boolean;
BEGIN
 SELECT jsonb_build_object(
   'active',count(*) FILTER (WHERE c.status IS DISTINCT FROM 'removed'),
   'removed',count(*) FILTER (WHERE c.status='removed'),
   'keyed',count(*) FILTER (WHERE c.source_party_key IS NOT NULL),
   'no_ghl_contact',count(*) FILTER (WHERE c.status IS DISTINCT FROM 'removed' AND nullif(btrim(c.ghl_contact_id),'') IS NULL),
   'placeholder_phone',count(*) FILTER (WHERE c.status IS DISTINCT FROM 'removed' AND nullif(btrim(c.client_phone),'') IS NOT NULL AND c.phone_last9 IS NULL),
   'ghl_contact_ambiguous',count(*) FILTER (WHERE 'ghl_contact_ambiguous'=ANY(c.party_flags)),
   'identity_conflict',count(*) FILTER (WHERE 'identity_conflict'=ANY(c.party_flags)),
   'owner_id_divergence',count(*) FILTER (WHERE 'owner_id_divergence'=ANY(c.party_flags)),
   'shared_ghl_contact_parties',(SELECT count(*) FROM public.job_contacts s WHERE s.status IS DISTINCT FROM 'removed' AND nullif(btrim(s.ghl_contact_id),'') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.job_contacts o WHERE o.id<>s.id AND o.status IS DISTINCT FROM 'removed' AND btrim(o.ghl_contact_id)=btrim(s.ghl_contact_id))),
   'multi_party_jobs',(SELECT count(*) FROM (SELECT 1 FROM public.job_contacts m WHERE m.status IS DISTINCT FROM 'removed' GROUP BY m.job_id HAVING count(*)>=2) q),
   'duplicate_letter_groups',(SELECT count(*) FROM (SELECT 1 FROM public.job_contacts d GROUP BY d.job_id,d.contact_label HAVING count(*)>1) q))
 INTO parties FROM public.job_contacts c;
 -- Jobs whose pricing lists neighbours but that have no active non-owner party
 -- (review S3: a scope sync that never ran). Live fencing jobs only. The list
 -- is pricing_json.neighbour_splits.neighbours (the fence tool's shape) or a
 -- bare neighbour_splits array; null, a scalar or an object without a list is
 -- none. The CASE fixes the order: an AND does not, and jsonb_array_length on
 -- a null split failed the whole block with SQLSTATE 22023 (20261006034000).
 parties:=parties||jsonb_build_object('pricing_neighbours_without_party_rows',(
  SELECT count(*) FROM public.jobs j
  CROSS JOIN LATERAL (SELECT CASE jsonb_typeof(j.pricing_json->'neighbour_splits')
    WHEN 'array' THEN j.pricing_json->'neighbour_splits' WHEN 'object' THEN j.pricing_json->'neighbour_splits'->'neighbours' END AS list) nb
  WHERE j.type::text='fencing' AND NOT (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false))
   AND CASE WHEN jsonb_typeof(nb.list)='array' THEN jsonb_array_length(nb.list)>0 ELSE false END
   AND NOT EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id=j.id AND c.is_primary IS NOT TRUE AND c.status IS DISTINCT FROM 'removed')));
 SELECT jsonb_build_object('multi_party_invoices_without_party',count(*)) INTO invoices
 FROM public.xero_invoices x
 WHERE x.invoice_type='ACCREC' AND upper(coalesce(x.status,'')) NOT IN ('VOIDED','DELETED') AND x.job_contact_id IS NULL AND x.job_id IN (
  SELECT m.job_id FROM public.job_contacts m WHERE m.status IS DISTINCT FROM 'removed' GROUP BY m.job_id HAVING count(*)>=2);
 SELECT jsonb_build_object('proposed',count(*) FILTER (WHERE l.status='proposed'),'confirmed',count(*) FILTER (WHERE l.status='confirmed'),
   'rejected',count(*) FILTER (WHERE l.status='rejected'),'oldest_proposed_at',min(l.created_at) FILTER (WHERE l.status='proposed'))
 INTO links FROM public.job_site_links l;
 SELECT coalesce(jsonb_object_agg(r.change,r.n),'{}'::jsonb) INTO receipts
 FROM (SELECT e.change,count(*) n FROM public.job_party_events e WHERE e.created_at>now_time-interval '7 days' GROUP BY e.change) r;
 -- The party linker sweep (S-M2) records runs as source party_linker.
 SELECT max(r.finished_at) FILTER (WHERE r.status='succeeded'),count(*)>0 INTO last_ok,ever FROM public.context_capture_runs r WHERE r.source='party_linker';
 lane:=public.automation_lane_enabled('capture');
 linker:=jsonb_build_object('built',ever,'last_succeeded_at',last_ok,
  'business_minutes_since',CASE WHEN last_ok IS NOT NULL THEN public.context_business_minutes(last_ok,now_time) END,'capture_lane',lane);
 IF ever AND lane AND public.context_in_business_hours(now_time)
  AND (last_ok IS NULL OR public.context_business_minutes(last_ok,now_time)>=45) THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','party_linker_stale','severity','warning','since',last_ok,
   'what_to_do','The party linker has not finished a sweep for 45 business minutes. Check its pg_cron job and the ops-api link_unlinked_parties action; new neighbours are not being linked to their GHL contacts.'));
 END IF;
 RETURN jsonb_build_object('as_of',now_time,'flag',jsonb_build_object('name','job_parties_v1','enabled',public.job_party_flag_on()),
  'parties',parties,'invoices',invoices,'site_links',links,'receipts_7d',receipts,'linker',linker,
  'not_measured_here',jsonb_build_array('neighbour_in_text_only','invoices_linked_elsewhere','invoices_spanning_jobs'),
  'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_parties_status() IS
 'Status block parties (sites.md section 8), owned by sites S-M1: party counts and flags, shared GHL contacts, duplicate letters, live fencing jobs whose pricing lists neighbours but that have no party rows, multi-party invoices with no party, site-link decisions, 7-day receipt counts, the party linker''s last run and the party_linker_stale alarm. Counts only, no names. Since 20261006034000 the neighbour list is pricing_json.neighbour_splits.neighbours (the fence tool''s shape) or a bare array, and a null or scalar split counts as none instead of failing the block (SQLSTATE 22023).';

-- 2. The scorecard's capture lane of one row. Still inlinable: plain SQL,
-- immutable, no SET clause, not a definer.
CREATE OR REPLACE FUNCTION public.context_scorecard_lane_of(p_event_type text, p_source text, p_channel text, p_direction text,
 p_body text, p_metadata jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN coalesce(p_body, '') ~ '^(New job assigned|Job ready for crew|New make-safe|New repair): '
       OR coalesce(p_metadata->>'recipient_role', '') IN ('crew', 'staff')                         THEN 'crew_staff_texts'
  WHEN p_event_type = 'call.transcript_completed'                                                THEN 'call_transcripts'
  WHEN p_event_type IN ('client.call_logged', 'client.call_initiated')                           THEN 'calls'
  WHEN p_channel = 'sms'                                                                         THEN 'texts'
  WHEN p_channel = 'email' AND p_direction = 'inbound'                                           THEN 'emails_in'
  WHEN (p_channel = 'email' AND p_direction = 'outbound') OR p_event_type LIKE '%email_out'      THEN 'emails_out'
  WHEN p_source LIKE 'xero%' OR p_event_type LIKE 'invoice.%' OR p_event_type LIKE 'payment.%'   THEN 'xero'
  WHEN p_event_type LIKE 'quote.%'                                                               THEN 'quotes'
  WHEN p_event_type LIKE 'schedule.%' OR p_event_type LIKE 'booking.%'
       OR p_event_type LIKE 'visit.%' OR p_event_type LIKE 'calendar.%'                          THEN 'bookings'
  WHEN p_event_type LIKE 'document.%'                                                            THEN 'documents'
 END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_lane_of(text, text, text, text, text, jsonb) IS
 'Context scorecard (20261006032000): the capture lane of one business_events row (texts, calls, call_transcripts, emails_in, emails_out, xero, quotes, bookings, documents, crew_staff_texts), or null. Inlinable. Since 20261006034000 a crew or staff text is one of our crew templates or a row marked metadata.recipient_role crew or staff; the ladder''s recipient_role other (a known contact who is not the customer, L1d) is a text.';

-- 3. The party-role classifier, v3.
CREATE OR REPLACE FUNCTION public.context_message_party_roles(e public.business_events) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
 dir text; cid text; raw_addr text; addr text; dom text; ek text; pk text; urole text;
 crole text; cbasis text; aud text; srole text; rrole text; to_first text; roles text[]; conflict text[]; irole text;
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
  RETURN jsonb_build_object('version','party_roles_v3','sender_role','staff','recipient_role',e.metadata->>'recipient_role',
   'counterpart_role',e.metadata->>'recipient_role',
   'basis',CASE WHEN e.metadata->>'audience'='internal' THEN 'ladder_internal' ELSE 'writer' END,'audience','internal');
 END IF;

 -- 1b (v3). One of our own crew or staff templates on an outbound text
 -- (context_internal_text_role, the reading L1d uses: ops-api's crew job
 -- texts and the office alerts) went to crew or staff, whoever the contact is
 -- on file as: a crew member's or office person's contact can also be a job's
 -- customer. Before every customer rule; never re-decides rule 1.
 IF dir='outbound' AND (e.channel='sms' OR (e.channel IS NULL AND e.event_type IN ('client.sms_out','sms_sent'))) THEN
  irole:=public.context_internal_text_role(e);
  IF irole IN ('crew','staff') THEN
   RETURN jsonb_build_object('version','party_roles_v3','sender_role','staff','recipient_role',irole,'counterpart_role',irole,
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
 RETURN jsonb_build_object('version','party_roles_v3','sender_role',srole,'recipient_role',rrole,'counterpart_role',crole,
  'basis',cbasis,'audience',aud)
  || CASE WHEN conflict IS NOT NULL THEN jsonb_build_object('conflicting_roles',to_jsonb(conflict)) ELSE '{}'::jsonb END;
END $$;
COMMENT ON FUNCTION public.context_message_party_roles(public.business_events) IS
 'Party roles v3 (20261006034000): for a message row (text, call, call transcript, email) {version, sender_role, recipient_role, counterpart_role, basis, audience[, conflicting_roles]}; roles customer, crew, staff, supplier, insurer_builder or unknown; our side is staff. L1d''s internal label and an undecided writer marker are copied, never re-decided; then an outbound text in one of our own crew or staff templates (context_internal_text_role) went to crew or staff (basis our_template, audience internal) whoever the contact is on file as; then v1''s rules (20261005200000) and v2''s (20261006000000) run unchanged. Null for any other row. Computes; never places, never writes. Service role may call it to preview.';

-- 4. Grants, as before: nothing reachable by the public key or a signed-in
-- login; the service role may call each (the heartbeat, the scorecard and
-- previews).
REVOKE ALL ON FUNCTION public.context_parties_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_parties_status() TO service_role;
REVOKE ALL ON FUNCTION public.context_scorecard_lane_of(text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_scorecard_lane_of(text, text, text, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.context_message_party_roles(public.business_events) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_message_party_roles(public.business_events) TO service_role;
