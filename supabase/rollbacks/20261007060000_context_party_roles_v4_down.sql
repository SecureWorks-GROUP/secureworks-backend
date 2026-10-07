-- Rollback of 20261007060000_context_party_roles_v4.
--
-- Puts back, byte for byte with its comment, the v3 party-role classifier
-- (20261006034000) the migration replaced, then drops the four v4 helpers
-- (context_party_crm_roles, context_party_domain_roles,
-- context_party_xero_bill, context_party_call_roles), row 2's read
-- (context_party_roles_lanes) and the material-order index. Rows the v4
-- classifier stamped keep their stamp until a writer updates one of the
-- trigger's columns again (then v3 stamps them); the undo of the hand-run
-- backfill is scripts/context-party-roles-v4-backfill-undo.sql (it puts back
-- the saved stamp on the rows that backfill touched, and only those). Writes
-- no row, flag, cron job or grant beyond restoring the same grants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Refuse unless the classifier is this migration's (or already v3's).
DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_message_party_roles(public.business_events)');
 IF live IS NULL OR live NOT IN ('1debd5c2b6dfbf2f4f22f291b893ec84','36ed4eac4ec8a1b2efd253da02add409') THEN
  RAISE EXCEPTION 'context_party_roles_v4 rollback: public.context_message_party_roles(public.business_events) md5 %; a later migration replaced it, roll that back first',
   coalesce(live,'<missing>');
 END IF;
END $guard$;

-- The v3 classifier (20261006034000), byte for byte.
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
   -- phone and its GHL contact give. One role only when all agree. (v3 sorts
   -- the roles and the basis tiebreak in C order, the one sort order; on
   -- these closed lists of lowercase names it is the order v2 gave.)
   SELECT array_agg(DISTINCT s.r_role COLLATE "C" ORDER BY s.r_role COLLATE "C"),
    (array_agg(s.r_basis ORDER BY array_position(ARRAY['any_job_party','lead','supplier_seen',
      'contact_our_domain','contact_users','contact_supplier','contact_builder_company','contact_supplier_seen',
      'contact_any_job_customer','contact_any_job_party','contact_lead'],s.r_basis) NULLS LAST,s.r_basis COLLATE "C"))[1]
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
 'Party roles v3 (20261006034000): for a message row (text, call, call transcript, email) {version, sender_role, recipient_role, counterpart_role, basis, audience[, conflicting_roles]}; roles customer, crew, staff, supplier, insurer_builder or unknown; our side is staff. L1d''s internal label and an undecided writer marker are copied, never re-decided; then an outbound text in one of our own crew or staff templates (context_internal_text_role''s patterns read through context_event_text, or the roof report make-safe alert, crew) went to crew or staff (basis our_template, audience internal) whoever the contact is on file as; then v1''s rules (20261005200000) and v2''s (20261006000000) run unchanged. Null for any other row. Computes; never places, never writes. Service role may call it to preview.';

-- The v4 helpers, row 2's read and the index (nothing else in this
-- repository reads them; a scorecard that reads context_party_roles_lanes
-- must be rolled back first).
DROP FUNCTION IF EXISTS public.context_party_roles_lanes(timestamptz,integer);
DROP FUNCTION IF EXISTS public.context_party_call_roles(public.business_events);
DROP FUNCTION IF EXISTS public.context_party_xero_bill(text);
DROP FUNCTION IF EXISTS public.context_party_domain_roles(text);
DROP FUNCTION IF EXISTS public.context_party_crm_roles(text,text,text,timestamptz);
DROP INDEX IF EXISTS public.business_events_party_material_orders;

REVOKE ALL ON FUNCTION public.context_message_party_roles(public.business_events) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_message_party_roles(public.business_events) TO service_role;
