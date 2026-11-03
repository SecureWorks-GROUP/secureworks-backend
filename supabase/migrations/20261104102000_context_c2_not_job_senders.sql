-- Renumbered from 20261104090000 on 3 Nov 2026 (CIO chat): that version is already applied in production by
-- 20261104090000_job_cost_crew_and_placement_division (#1297). The in-body tag "(20261104090000)" and its notice are
-- kept so the rehearsed md5 of context_bucket_reason_detail stays exact.
-- (finish line C2, 3 Nov 2026) Customer-lane messages from people who are not customers say who they are, and a text that
-- names its GHL contact only as its entity gets that contact.
--
-- Why (read only, production 3 Nov 2026 14:20 to 15:10Z; verify/evidence/20261103-c2-unknown in the project folder):
-- 2,205 of the 6,133 C2 misses have no contact and no single contact for their email or phone (buckets c and d of
-- verify/evidence/20261103-c2-buckets/split.json; 90 of them in the last 7 days).
--  1. 1,240 are texts whose writer saved the GHL contact as entity_type 'contact' (or 'unmatched_contact') and
--     entity_id <GHL contact id> but left contact_id empty: our own tool's sends (mcp_agent, through ops-api
--     log_business_event, still writing), ghl-proxy sms_sent (to May 2026) and the September sms-cache backfill. Every
--     GHL writer that fills both stores entity_id = contact_id (27,000 rows, no exception), but no step reads
--     entity_id, so these rows reach the ladder with no identity.
--  2. 975 are emails. Of 292 distinct outside addresses, 37 have a GHL contact (looked up read only) and the rest are
--     suppliers, banks and software notices, newsletters, the owner's private mail, the company's own insurance,
--     finance and contractor-compliance mail, councils, builders and real customers we hold no record of. A message
--     with no customer identity, no job reference and no live site ends as no_identity whoever sent it, so a bank
--     alert and a lost customer read the same. The lane (context_unplaced_lane) keeps them in the customer lane
--     because their party roles say unknown: the role sources (suppliers with an email, users) hold few of them.
--
-- Changed:
--  a. context_entity_contact_fill(), a BEFORE INSERT trigger on business_events (context_a0_entity_contact, named to
--     fire before context_attribute_business_event): on a customer message type with no contact_id, entity_type
--     'contact' or 'unmatched_contact' and a GHL-shaped entity_id (20 letters and digits), contact_id takes entity_id
--     and metadata.contact_from_entity is true. Nothing else changes; a writer that names its contact keeps it.
--  b. context_sender_register, a reviewed list of outside addresses and domains that are not customers, by kind:
--     supplier, vendor, system, marketing, personal, admin (service role only; empty here, filled by a reviewed run).
--  c. context_not_job_sender(e): for a message whose counterpart (the sender of an inbound row, the one outside
--     recipient of an outbound row) is known not to be a customer, the reason and how it was known:
--       the register's kind, exact address first, then the longest domain (supplier -> supplier_no_ref, vendor ->
--       business_vendor, system -> system_notice, marketing -> marketing_sender, personal -> personal_mail,
--       admin -> business_admin); crew_party (a crew user) or own_party (any other user) when the subject and first
--       1,500 characters name no street address; supplier_no_ref for a supplier on record (suppliers with an email or
--       phone, Dispatch's approved order addresses, to and cc, and their company domains). Else null. Its caller has
--       already ruled out a job reference, a customer identity and a live job's site.
--     supplier_no_ref stays a could-not-place reason (a supplier's message may be about a job's order). The
--     not-about-a-job ones are crew_party, business_vendor, system_notice, marketing_sender, personal_mail and
--     business_admin (and own_party, as before).
--  d. context_bucket_reason_detail (one exact edit of the live definition, md5(prosrc) 78cad84d..., the
--     20260924183000 body): just before its last answer (no_identity) it asks context_not_job_sender. Every earlier
--     answer is unchanged: a job reference (single_ref, multi_ref, ref_not_found), a customer identity
--     (identity_unread, identity_conflict and the contact reasons), a live site (no_identity_site), a platform
--     sender, a supplier event and our own mail still come first.
-- No row is changed by this migration: existing rows change only when re-decided (the reviewed re-run for row C2).
-- Rollback: supabase/rollbacks/20261104102000_context_c2_not_job_senders_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Nothing changes unless the live reason step is the definition this was written against (or already this one).
DO $guard$
DECLARE live text; problems text[] := '{}'; x text;
BEGIN
  SELECT md5(p.prosrc) INTO live FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_bucket_reason_detail(public.business_events,jsonb)');
  IF live IS NULL OR live NOT IN ('78cad84dc555a47155e6bc614bbba3b8', '1c3b05a8d875d55ebca37671857010a9') THEN
    problems := problems || format('context_bucket_reason_detail md5 %s', coalesce(live, '<missing>'));
  END IF;
  FOREACH x IN ARRAY ARRAY['public.context_email_key(text)', 'public.context_phone_key(text)',
    'public.context_party_user_role(text,text)', 'public.context_party_supplier_key(text,text)',
    'public.context_address_mentions(text)', 'public.context_event_text(public.business_events)',
    'public.attribute_business_event()'] LOOP
    IF to_regprocedure(x) IS NULL THEN problems := problems || format('%s missing', x); END IF;
  END LOOP;
  IF to_regclass('public.dispatch_approved_supplier_emails') IS NULL THEN
    problems := problems || 'public.dispatch_approved_supplier_emails missing'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'context_c2_not_job_senders is not written against this database: %', array_to_string(problems, '; ');
  END IF;
END $guard$;

-- a. A text that names its GHL contact only as its entity gets that contact.
CREATE OR REPLACE FUNCTION public.context_entity_contact_fill()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF nullif(btrim(coalesce(NEW.contact_id, '')), '') IS NULL
     AND NEW.entity_type IN ('contact', 'unmatched_contact')
     AND NEW.entity_id ~ '^[A-Za-z0-9]{20}$'
     AND NEW.event_type IN ('client.sms_out', 'client.sms_in', 'client.reply', 'client.call_logged', 'client.call_complete',
       'call.transcript_completed', 'client.email_in', 'client.email_out', 'client.email_forwarded', 'client.call_initiated',
       'client_comms.sent', 'sms_sent', 'client.message_in', 'client_replied') THEN
    NEW.contact_id := NEW.entity_id;
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('contact_from_entity', true);
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION public.context_entity_contact_fill() IS
 '(20261104090000, finish line C2) BEFORE INSERT on business_events (trigger context_a0_entity_contact, which fires before context_attribute_business_event): a customer message with no contact_id whose writer named its GHL contact as entity_type contact or unmatched_contact and a GHL-shaped entity_id (20 letters and digits) gets contact_id = entity_id and metadata.contact_from_entity true, so the ladder reads its contact. Every GHL writer that fills both already stores entity_id = contact_id. Nothing else changes.';
REVOKE ALL ON FUNCTION public.context_entity_contact_fill() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS context_a0_entity_contact ON public.business_events;
CREATE TRIGGER context_a0_entity_contact BEFORE INSERT ON public.business_events
  FOR EACH ROW EXECUTE FUNCTION public.context_entity_contact_fill();

-- b. The reviewed register of senders that are not customers.
CREATE TABLE IF NOT EXISTS public.context_sender_register (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match text NOT NULL CHECK (match = lower(btrim(match)) AND (match ~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' OR match ~ '^@[a-z0-9-]+(\.[a-z0-9-]+)+$')),
  party_kind text NOT NULL CHECK (party_kind IN ('supplier', 'vendor', 'system', 'marketing', 'personal', 'admin')),
  note text NOT NULL CHECK (length(btrim(note)) > 0),
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS context_sender_register_live_match ON public.context_sender_register (match) WHERE removed_at IS NULL;
ALTER TABLE public.context_sender_register ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_sender_register FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.context_sender_register TO service_role;
COMMENT ON TABLE public.context_sender_register IS
 '(20261104090000, finish line C2) Outside email addresses (name@domain) and domains (@domain, which also covers its subdomains) that are not customers, each reviewed with a note: supplier (job materials or job services; their messages stay could-not-place, supplier_no_ref), vendor (goods or services for the company itself), system (automated bank, payment, software and account notices), marketing (newsletters, promotions, cold pitches), personal (an owner''s or staff member''s private mail), admin (the company''s own insurance, finance, legal, staff and contractor-compliance mail). Read by context_not_job_sender only when a message names no job, no street address and no customer. Never list a customer, lead, lead platform, property manager, builder work-order address or council. Remove an entry by setting removed_at. Service role only.';

-- c. Who a sender is, when we know they are not a customer.
CREATE OR REPLACE FUNCTION public.context_not_job_sender(e public.business_events)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dir text; raw text; addr text; dom text; ek text; pk text; urole text; hit record; txt text;
BEGIN
  dir := lower(coalesce(e.direction, ''));
  IF dir NOT IN ('inbound', 'outbound') THEN
    dir := CASE WHEN e.event_type IN ('client.reply', 'client.email_in', 'client.sms_in', 'client.message_in', 'client_replied') THEN 'inbound'
      WHEN e.event_type IN ('client.email_out', 'client.sms_out', 'sms_sent', 'client.email_forwarded', 'client_comms.sent') THEN 'outbound' END;
  END IF;
  IF dir = 'inbound' THEN
    raw := coalesce(e.payload->>'from', e.payload->>'from_email', e.payload->>'sender', e.payload->>'email');
    pk := public.context_phone_key(coalesce(e.payload->>'phone', e.payload->>'customer_phone', e.payload->>'from_number',
      CASE WHEN position('@' in coalesce(e.payload->>'from', '')) = 0 THEN e.payload->>'from' END));
  ELSIF dir = 'outbound' THEN
    -- The one outside recipient (our own addresses left out); several outside recipients name nobody.
    SELECT CASE WHEN count(DISTINCT a) = 1 THEN min(a) END INTO raw
    FROM (SELECT lower(btrim(coalesce(substring(x from '<([^<>]*)>'), x))) AS a
          FROM jsonb_array_elements_text(CASE jsonb_typeof(e.payload->'to') WHEN 'array' THEN e.payload->'to'
            WHEN 'string' THEN jsonb_build_array(e.payload->'to') ELSE '[]'::jsonb END) x) r
    WHERE r.a ~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
      AND split_part(r.a, '@', 2) !~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$';
    pk := public.context_phone_key(coalesce(e.payload->>'customer_phone', e.payload->>'to_phone', e.payload->>'expected_phone',
      e.payload->>'to_number'));
  ELSE
    RETURN NULL;
  END IF;
  addr := lower(btrim(coalesce(substring(raw from '<([^<>]*)>'), raw, '')));
  IF addr !~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
     OR split_part(addr, '@', 2) ~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN
    addr := NULL;
  END IF;
  IF addr IS NULL AND pk IS NULL THEN RETURN NULL; END IF;
  dom := split_part(addr, '@', 2);
  ek := public.context_email_key(addr);

  -- The reviewed register: the exact address first, then the longest matching domain.
  IF addr IS NOT NULL THEN
    SELECT r.match, r.party_kind INTO hit FROM public.context_sender_register r
    WHERE r.removed_at IS NULL
      AND (r.match = addr OR (left(r.match, 1) = '@' AND (dom = substr(r.match, 2) OR right(dom, length(r.match)) = '.' || substr(r.match, 2))))
    ORDER BY (r.match = addr) DESC, length(r.match) DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('reason', CASE hit.party_kind WHEN 'supplier' THEN 'supplier_no_ref' WHEN 'vendor' THEN 'business_vendor'
        WHEN 'system' THEN 'system_notice' WHEN 'marketing' THEN 'marketing_sender' WHEN 'personal' THEN 'personal_mail'
        WHEN 'admin' THEN 'business_admin' END, 'not_job_basis', 'register', 'register_match', hit.match);
    END IF;
  END IF;

  -- Our own people, when the message names no street address (a crew member or staff writing about a site may be
  -- writing about a job).
  urole := CASE WHEN ek IS NOT NULL OR pk IS NOT NULL THEN public.context_party_user_role(ek, pk) END;
  IF urole IS NOT NULL THEN
    txt := coalesce(nullif(btrim(e.payload->>'subject'), '') || E'\n', '') || left(public.context_event_text(e), 1500);
    IF EXISTS (SELECT 1 FROM public.context_address_mentions(txt) m WHERE m.address_key IS NOT NULL) THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('reason', CASE WHEN urole = 'crew' THEN 'crew_party' ELSE 'own_party' END, 'not_job_basis', 'users');
  END IF;

  -- A supplier on record: suppliers with an email or phone, and Dispatch's approved order addresses (to and cc) and
  -- their company domains (never a free mail domain).
  IF public.context_party_supplier_key(ek, pk) THEN
    RETURN jsonb_build_object('reason', 'supplier_no_ref', 'not_job_basis', 'suppliers');
  END IF;
  IF addr IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_emails s
    CROSS JOIN LATERAL unnest(s.to_emails || coalesce(s.cc_emails, ARRAY[]::text[])) a(x)
    WHERE s.active AND (lower(btrim(a.x)) = addr OR (
      split_part(lower(btrim(a.x)), '@', 2) NOT IN ('gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.au', 'outlook.com',
        'outlook.com.au', 'live.com', 'live.com.au', 'yahoo.com', 'yahoo.com.au', 'bigpond.com', 'bigpond.net.au', 'icloud.com',
        'me.com', 'iinet.net.au', 'optusnet.com.au', 'westnet.com.au', 'tpg.com.au')
      AND (dom = split_part(lower(btrim(a.x)), '@', 2) OR right(dom, length(split_part(lower(btrim(a.x)), '@', 2)) + 1) = '.' || split_part(lower(btrim(a.x)), '@', 2)))))
  THEN
    RETURN jsonb_build_object('reason', 'supplier_no_ref', 'not_job_basis', 'approved_supplier_email');
  END IF;
  RETURN NULL;
END $$;
COMMENT ON FUNCTION public.context_not_job_sender(public.business_events) IS
 '(20261104090000, finish line C2) Who a message''s counterpart is (the sender of an inbound row; the one outside recipient of an outbound row, our own addresses left out), when we know they are not a customer: {reason, not_job_basis[, register_match]}. context_sender_register (exact address first, then the longest domain): supplier_no_ref, business_vendor, system_notice, marketing_sender, personal_mail or business_admin by its kind; a crew user: crew_party, any other user: own_party, only when the subject and first 1,500 characters name no street address; a supplier on record (suppliers by email or phone, Dispatch''s approved order addresses, to and cc, and their company domains): supplier_no_ref. Else null. Called by context_bucket_reason_detail just before no_identity, so only for a message with no job reference, no customer identity and no live site. Service role only.';
REVOKE ALL ON FUNCTION public.context_not_job_sender(public.business_events) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_not_job_sender(public.business_events) TO service_role;

-- d. The reason step asks it just before no_identity.
DO $mig$
DECLARE
  v_def text; v_live text;
  v_old0 text := $o$ exact_ids text[]; loose_ids text[]; site jsonb;
BEGIN
$o$;
  v_new0 text := $n$ exact_ids text[]; loose_ids text[]; site jsonb; nj jsonb;
BEGIN
$n$;
  v_old1 text := $o$ IF kind='ours' THEN RETURN d||jsonb_build_object('reason','own_party'); END IF;
 RETURN d||jsonb_build_object('reason','no_identity');
$o$;
  v_new1 text := $n$ IF kind='ours' THEN RETURN d||jsonb_build_object('reason','own_party'); END IF;
 -- (20261104090000) A sender we know is not a customer, on a message that names no job, no street address and no
 -- customer: the reason names who they are (context_not_job_sender).
 nj:=public.context_not_job_sender(e);
 IF nj IS NOT NULL THEN RETURN d||nj; END IF;
 RETURN d||jsonb_build_object('reason','no_identity');
$n$;
BEGIN
  SELECT md5(prosrc) INTO v_live FROM pg_proc WHERE oid = 'public.context_bucket_reason_detail(public.business_events,jsonb)'::regprocedure;
  IF v_live = '1c3b05a8d875d55ebca37671857010a9' THEN
    RAISE NOTICE 'context_bucket_reason_detail already carries 20261104090000';
    RETURN;
  END IF;
  SELECT pg_get_functiondef('public.context_bucket_reason_detail(public.business_events,jsonb)'::regprocedure) INTO v_def;
  IF (length(v_def) - length(replace(v_def, v_old0, ''))) / length(v_old0) <> 1 THEN
    RAISE EXCEPTION 'context_bucket_reason_detail: change 1 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old0, v_new0);
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
    RAISE EXCEPTION 'context_bucket_reason_detail: change 2 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old1, v_new1);
  EXECUTE v_def;
  SELECT md5(prosrc) INTO v_live FROM pg_proc WHERE oid = 'public.context_bucket_reason_detail(public.business_events,jsonb)'::regprocedure;
  IF v_live <> '1c3b05a8d875d55ebca37671857010a9' THEN
    RAISE EXCEPTION 'context_bucket_reason_detail after the change is not the rehearsed definition (md5 %)', v_live;
  END IF;
END
$mig$;
