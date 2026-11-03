-- C14 (3 Nov 2026, finish-line row C2): a second person we text from a job
-- is that job's person, so their texts place on it.
--
-- Why: a neighbour on a shared fence, a co-owner or a partner who texts has
-- their own GHL contact. The placer finds a contact's jobs through
-- jobs.ghl_contact_id and contact_matches only, so that person's texts find
-- no job (placement_rule no_candidate_at_time) even when a job party carries
-- their contact id. Cases: SWF-261586 (neighbour B has no contact id), SWF-261638
-- (the second payer's contact is on no party).
--
-- Changed:
--   1. job_contact_send_links: a GHL contact a staff send from the job
--      linked to it when it matches no party on the job. A job_contacts row
--      is a paying party (shares, invoices, quote runs; adding one through
--      upsert_job_party resets the owner's 100 share to unknown), so a
--      contact that matches no party is held here, read only by the placer.
--      RLS on, no policy; service_role reads; only the linker writes.
--   2. context_link_send_contact(job, contact, source, source_id, user,
--      phone, email): the one linker. Only a staff send counts (a user id;
--      an automated send names none). The contact must be a GHL id (letters
--      and digits, never a job_contacts uuid). Nothing is written when the
--      contact is the job's own, already on the job, or the job is not live.
--      Guards, each with a job_party_events receipt and no link:
--        send_link_other_open_job  the contact is the customer, a party or a
--                                  linked contact of another live job (never
--                                  two open jobs; a person decides);
--        send_link_party_other_contact  the matching party already holds a
--                                  different contact id (never overwritten);
--        send_link_party_ambiguous two parties match;
--        send_link_job_closed      the job is not live.
--      A matching party is a live non-owner party on the job whose phone
--      (last 9) or email key equals the contact's (the send's phone or email,
--      or the contact's contact_matches rows). One match with no contact id:
--      set_job_party_ids writes it (method staff_send, its own receipt).
--      No match: one job_contact_send_links row (receipt send_contact_linked).
--      Then the contact's messages from the last 30 days are reconsidered
--      (context_reconsider_contact, job_contact_linked), never failing the
--      send.
--   3. job_events AFTER INSERT of an sms_sent row with a user and a job (the
--      one staff send that records the job and the GHL contact today:
--      ghl-proxy send_sms with jobId and userId) calls the linker. It never
--      fails the insert. Quote and invoice sends record an email, not a GHL
--      contact, so they have no hook; the linker takes quote_sent and
--      invoice_sent for a writer that knows the contact.
--   4. Both context_contact_job_timeline overloads: a live non-owner party
--      carrying the contact, or a live send link, adds its job as a member
--      with basis 'party' (the customer's own job for every rule; not
--      key_other_contact). A party job is never also a contactless or
--      key_other_contact member, and a party's job adds no phone or email key
--      (raw_keys reads own jobs only). Nothing else in either body changes.
--      md5(prosrc), old -> new:
--        context_contact_job_timeline(text,timestamptz)            88d0aa3f8bdbb2800d66954b5655f0dd -> e14de55f5ca63ec5a81a7e3a420a0a15
--        context_contact_job_timeline(text,timestamptz,text,text)  be5e8d7df251fb3baf2d1a47641d93eb -> 454ced32a1213e2c28d7d41d37263df5
--      (old = 20261029190000, read live 3 Nov 2026 07:2xZ, read only.)
--
-- Not changed: resolve_context_attribution (party jobs reach it through the
-- timeline), set_job_party_ids, upsert_job_party, the send guard in
-- ghl-proxy, job_parties_v1 (stays off; the writers' own reconsideration
-- stays off with it). No row is written by this migration; a row moves only
-- when it is inserted or reconsidered.
--
-- Rollback: supabase/rollbacks/20261103203000_context_send_party_link_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_contact_job_timeline(text,timestamptz)',ARRAY['88d0aa3f8bdbb2800d66954b5655f0dd','e14de55f5ca63ec5a81a7e3a420a0a15']),
  ('public.context_contact_job_timeline(text,timestamptz,text,text)',ARRAY['be5e8d7df251fb3baf2d1a47641d93eb','454ced32a1213e2c28d7d41d37263df5'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- New names: missing, or this migration's (a repeated apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)','f4601e213838c0dd0be1f99d8c07dec2'),
  ('public.context_job_event_send_link()','29406e3aa57f2d8bf6d412e1db448d88')
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NOT NULL AND live<>x.accepted THEN problems:=problems||format('%s exists with md5 %s',x.sig,live); END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
   AND p.proname IN ('context_link_send_contact','context_job_event_send_link')
   AND p.oid NOT IN (coalesce(to_regprocedure('public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)')::oid,0::oid),
    coalesce(to_regprocedure('public.context_job_event_send_link()')::oid,0::oid)))
 THEN problems:=problems||'another overload of the linker or its trigger function exists'::text; END IF;
 IF to_regclass('public.job_contact_send_links') IS NOT NULL AND (SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attname)
   FROM pg_attribute a WHERE a.attrelid=to_regclass('public.job_contact_send_links') AND a.attnum>0 AND NOT a.attisdropped)
   IS DISTINCT FROM 'ghl_contact_id:text,id:uuid,job_id:uuid,linked_at:timestamp with time zone,linked_by:uuid,removed_at:timestamp with time zone,removed_by:text,source:text,source_id:uuid'
 THEN problems:=problems||'job_contact_send_links exists with another shape'::text; END IF;
 -- What the linker reads and calls.
 FOR x IN SELECT * FROM (VALUES
  ('public.set_job_party_ids(uuid,text,text,text,text,text)'),('public.job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb)'),
  ('public.context_reconsider_contact(text,timestamptz,text,uuid)'),('public.context_job_live(uuid)'),
  ('public.job_party_phone_key(text)'),('public.job_party_email_key(text)')
 ) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s missing',x.sig); END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid='public.job_contacts'::regclass AND NOT a.attisdropped
   AND a.attname IN ('job_id','ghl_contact_id','status','removed_at','is_primary','source_party_key','phone_last9','client_email'))<>8
 THEN problems:=problems||'job_contacts lacks a party column'::text; END IF;
 IF (SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attname) FROM pg_attribute a
   WHERE a.attrelid='public.job_events'::regclass AND a.attname IN ('job_id','user_id','event_type','detail_json') AND NOT a.attisdropped)
   IS DISTINCT FROM 'detail_json:jsonb,event_type:text,job_id:uuid,user_id:uuid'
 THEN problems:=problems||'job_events lacks job_id, user_id, event_type or detail_json'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_send_party_link_preimage_mismatch: %; build on the live definitions',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Contacts a staff send linked to a job, matching no party there.
CREATE TABLE IF NOT EXISTS public.job_contact_send_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 ghl_contact_id text NOT NULL CHECK (ghl_contact_id ~ '^[A-Za-z0-9]{10,40}$'),
 source text NOT NULL CHECK (source IN ('sms_sent','quote_sent','invoice_sent')),
 source_id uuid,
 linked_by uuid NOT NULL,
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 removed_at timestamptz,
 removed_by text CHECK (removed_by IS NULL OR length(removed_by) BETWEEN 1 AND 200),
 CONSTRAINT job_contact_send_links_removed CHECK ((removed_at IS NULL)=(removed_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS job_contact_send_links_live ON public.job_contact_send_links(job_id,ghl_contact_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS job_contact_send_links_contact ON public.job_contact_send_links(ghl_contact_id) WHERE removed_at IS NULL;
ALTER TABLE public.job_contact_send_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_contact_send_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.job_contact_send_links TO service_role;
COMMENT ON TABLE public.job_contact_send_links IS
 'C14 (20261103203000): a GHL contact a staff send from the job linked to it because it matched no party on the job (a second person: neighbour, co-owner, partner). Not a paying party: read only by the placement timeline (basis party). Written only by context_link_send_contact; a person unlinks by setting removed_at and removed_by. Ids only.';

-- 2. The linker.
CREATE OR REPLACE FUNCTION public.context_link_send_contact(p_job_id uuid, p_ghl_contact_id text, p_source text, p_source_id uuid,
 p_user_id uuid, p_phone text DEFAULT NULL, p_email text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 c text:=nullif(btrim(p_ghl_contact_id),''); j public.jobs; actor text; d jsonb; other_ids uuid[];
 pks text[]; eks text[]; n int; party public.job_contacts; basis text; r jsonb; link_id uuid; outcome text; recon jsonb;
BEGIN
 IF p_source IS NULL OR p_source NOT IN ('sms_sent','quote_sent','invoice_sent') THEN RAISE EXCEPTION 'send_link_source_invalid'; END IF;
 -- Only a send a staff member made counts: an automated send names no user.
 IF p_user_id IS NULL THEN RETURN jsonb_build_object('outcome','not_staff'); END IF;
 -- A GHL contact id is letters and digits (never a job_contacts uuid).
 IF c IS NULL OR c !~ '^[A-Za-z0-9]{10,40}$' THEN RETURN jsonb_build_object('outcome','no_contact'); END IF;
 IF p_job_id IS NULL THEN RETURN jsonb_build_object('outcome','no_job'); END IF;
 actor:='staff:'||p_user_id::text;
 d:=jsonb_build_object('source',p_source,'source_id',p_source_id,'ghl_contact_id',c);
 -- One decision per contact at a time (two jobs texting one person), then
 -- the party writers' own lock on the job.
 PERFORM pg_advisory_xact_lock(hashtextextended('send_link_contact:'||c,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('job_party:'||p_job_id::text,0));
 SELECT * INTO j FROM public.jobs WHERE id=p_job_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_job'); END IF;
 IF nullif(btrim(j.ghl_contact_id),'')=c THEN RETURN jsonb_build_object('outcome','job_contact'); END IF;
 IF EXISTS (SELECT 1 FROM public.job_contacts x WHERE x.job_id=p_job_id AND x.ghl_contact_id=c AND x.removed_at IS NULL AND coalesce(x.status,'')<>'removed')
  OR EXISTS (SELECT 1 FROM public.job_contact_send_links l WHERE l.job_id=p_job_id AND l.ghl_contact_id=c AND l.removed_at IS NULL)
 THEN RETURN jsonb_build_object('outcome','already_linked'); END IF;
 IF NOT public.context_job_live(p_job_id) THEN
  PERFORM public.job_party_receipt(p_job_id,NULL,'send_link_job_closed',actor,'staff_send',NULL,NULL,NULL,NULL,d);
  RETURN jsonb_build_object('outcome','job_closed');
 END IF;
 -- Never on two open jobs: the customer, a party or a linked contact of
 -- another live job is left for a person.
 SELECT array_agg(DISTINCT o.id ORDER BY o.id) INTO other_ids FROM (
  SELECT jj.id FROM public.jobs jj WHERE jj.ghl_contact_id=c AND jj.id<>p_job_id
  UNION SELECT x.job_id FROM public.job_contacts x WHERE x.ghl_contact_id=c AND x.job_id<>p_job_id AND x.removed_at IS NULL AND coalesce(x.status,'')<>'removed'
  UNION SELECT l.job_id FROM public.job_contact_send_links l WHERE l.ghl_contact_id=c AND l.job_id<>p_job_id AND l.removed_at IS NULL
 ) o WHERE public.context_job_live(o.id);
 IF cardinality(other_ids)>0 THEN
  PERFORM public.job_party_receipt(p_job_id,NULL,'send_link_other_open_job',actor,'staff_send',NULL,NULL,NULL,NULL,
   d||jsonb_build_object('other_job_ids',to_jsonb(other_ids)));
  RETURN jsonb_build_object('outcome','other_open_job','other_job_ids',to_jsonb(other_ids));
 END IF;
 -- The contact's keys: the send's own phone or email, and its contact_matches rows.
 SELECT coalesce(array_agg(DISTINCT k.pk) FILTER (WHERE k.pk IS NOT NULL),'{}'),coalesce(array_agg(DISTINCT k.ek) FILTER (WHERE k.ek IS NOT NULL),'{}')
 INTO pks,eks FROM (
  SELECT public.job_party_phone_key(p_phone) AS pk,public.job_party_email_key(p_email) AS ek
  UNION ALL
  SELECT public.job_party_phone_key(to_jsonb(m)->>'phone'),public.job_party_email_key(to_jsonb(m)->>'email')
  FROM public.contact_matches m WHERE m.ghl_contact_id=c
 ) k;
 SELECT count(*) INTO n FROM public.job_contacts x
 WHERE x.job_id=p_job_id AND x.removed_at IS NULL AND coalesce(x.status,'')<>'removed'
  AND x.is_primary IS NOT TRUE AND coalesce(x.source_party_key,'')<>'primary'
  AND ((x.phone_last9 IS NOT NULL AND x.phone_last9=ANY(pks))
   OR (public.job_party_email_key(x.client_email) IS NOT NULL AND public.job_party_email_key(x.client_email)=ANY(eks)));
 IF n>1 THEN
  PERFORM public.job_party_receipt(p_job_id,NULL,'send_link_party_ambiguous',actor,'staff_send','ambiguous',NULL,NULL,NULL,d||jsonb_build_object('parties',n));
  RETURN jsonb_build_object('outcome','party_ambiguous','parties',n);
 ELSIF n=1 THEN
  SELECT x.* INTO party FROM public.job_contacts x
  WHERE x.job_id=p_job_id AND x.removed_at IS NULL AND coalesce(x.status,'')<>'removed'
   AND x.is_primary IS NOT TRUE AND coalesce(x.source_party_key,'')<>'primary'
   AND ((x.phone_last9 IS NOT NULL AND x.phone_last9=ANY(pks))
    OR (public.job_party_email_key(x.client_email) IS NOT NULL AND public.job_party_email_key(x.client_email)=ANY(eks)));
  basis:=CASE WHEN party.phone_last9=ANY(pks) AND public.job_party_email_key(party.client_email)=ANY(eks) THEN 'both'
   WHEN party.phone_last9=ANY(pks) THEN 'phone' ELSE 'email' END;
  IF nullif(btrim(party.ghl_contact_id),'') IS NOT NULL THEN
   -- A different id (the same one returned already_linked): never overwritten.
   PERFORM public.job_party_receipt(p_job_id,party.id,'send_link_party_other_contact',actor,'staff_send',basis,NULL,NULL,NULL,d);
   RETURN jsonb_build_object('outcome','party_has_other_contact','job_contact_id',party.id);
  END IF;
  r:=public.set_job_party_ids(party.id,c,NULL,'staff_send',basis,actor);
  IF r->>'outcome' IS DISTINCT FROM 'party_ids_set' THEN
   RETURN jsonb_build_object('outcome','party_not_set','job_contact_id',party.id,'writer_outcome',r->>'outcome');
  END IF;
  outcome:='party_linked';
 ELSE
  INSERT INTO public.job_contact_send_links(job_id,ghl_contact_id,source,source_id,linked_by)
  VALUES(p_job_id,c,p_source,p_source_id,p_user_id) RETURNING id INTO link_id;
  PERFORM public.job_party_receipt(p_job_id,NULL,'send_contact_linked',actor,'staff_send','none',NULL,NULL,NULL,d||jsonb_build_object('link_id',link_id));
  outcome:='contact_linked';
 END IF;
 -- The contact's messages of the last 30 days are decided again with the job.
 BEGIN
  recon:=public.context_reconsider_contact(c,clock_timestamp()-interval '30 days','job_contact_linked',p_job_id);
 EXCEPTION WHEN OTHERS THEN recon:=jsonb_build_object('outcome','failed','code',SQLSTATE);
 END;
 RETURN jsonb_build_object('outcome',outcome,'job_id',p_job_id,'job_contact_id',party.id,'link_id',link_id,'reconsider',recon);
END $$;
REVOKE ALL ON FUNCTION public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text) TO service_role;
COMMENT ON FUNCTION public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text) IS
 'C14 (20261103203000): a staff send (p_user_id; an automated send names none) from a live job to a GHL contact that is not the job''s own makes that contact the job''s person. A live non-owner party matching the contact''s phone or email key with no contact id gets it (set_job_party_ids, staff_send); no matching party: a job_contact_send_links row. Never overwrites a different id (send_link_party_other_contact), never links a contact of another live job (send_link_other_open_job), never picks between two matching parties (send_link_party_ambiguous); each refusal is a job_party_events receipt. Then reconsiders the contact''s last 30 days of messages. Outcomes: not_staff, no_contact, no_job, job_contact, already_linked, job_closed, other_open_job, party_ambiguous, party_has_other_contact, party_not_set, party_linked, contact_linked.';

-- 3. The staff text sent from a job.
CREATE OR REPLACE FUNCTION public.context_job_event_send_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.context_link_send_contact(NEW.job_id,NEW.detail_json->>'contact_id','sms_sent',NEW.id,NEW.user_id);
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 -- Never fail the send's record; log the code and the job id only.
 RAISE WARNING 'context send link failed for job %: SQLSTATE %',NEW.job_id,SQLSTATE;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.context_job_event_send_link() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.context_job_event_send_link() IS
 'C14 (20261103203000): AFTER INSERT on job_events of an sms_sent row with a user and a job (ghl-proxy send_sms with jobId and userId): context_link_send_contact for detail_json.contact_id. Never fails the insert.';
DROP TRIGGER IF EXISTS context_job_event_send_link ON public.job_events;
CREATE TRIGGER context_job_event_send_link AFTER INSERT ON public.job_events
 FOR EACH ROW WHEN (NEW.event_type='sms_sent' AND NEW.user_id IS NOT NULL AND NEW.job_id IS NOT NULL)
 EXECUTE FUNCTION public.context_job_event_send_link();

-- 4. The two candidate timelines: party jobs (basis party).
-- public.context_contact_job_timeline(text,timestamptz)
CREATE OR REPLACE FUNCTION public.context_contact_job_timeline(p_contact_id text, p_at timestamp with time zone)
 RETURNS TABLE(job_id uuid, job_number text, type text, status text, basis text, created_at timestamp with time zone, terminal boolean, terminal_at timestamp with time zone, terminal_time_source text, window_start timestamp with time zone, candidate boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH own AS (
  SELECT j.id FROM public.jobs j WHERE p_contact_id IS NOT NULL AND j.ghl_contact_id=p_contact_id
  UNION
  SELECT m.job_id FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.job_id IS NOT NULL AND m.ghl_contact_id=p_contact_id
  UNION
  SELECT m.job_id FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.job_id IS NOT NULL AND m.xero_contact_id=p_contact_id
 ), party AS (
  SELECT c.job_id AS id FROM public.job_contacts c
  WHERE p_contact_id IS NOT NULL AND c.ghl_contact_id=p_contact_id
   AND c.removed_at IS NULL AND coalesce(c.status,'')<>'removed'
   AND c.is_primary IS NOT TRUE AND coalesce(c.source_party_key,'')<>'primary'
   AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=c.job_id)
  UNION
  SELECT l.job_id FROM public.job_contact_send_links l
  WHERE p_contact_id IS NOT NULL AND l.ghl_contact_id=p_contact_id AND l.removed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=l.job_id)
 ), raw_keys AS (
  SELECT j.client_phone AS phone, j.client_email AS email FROM public.jobs j JOIN own o ON o.id=j.id
  UNION ALL
  SELECT to_jsonb(m)->>'phone', to_jsonb(m)->>'email' FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.ghl_contact_id=p_contact_id
 ), keys AS (
  SELECT CASE WHEN length(d)>=8 AND d !~ '^(\d)\1*$' THEN right(d,9) END AS phone_key,
   CASE WHEN position('@' IN em)>1 THEN em END AS email_key
  FROM raw_keys r CROSS JOIN LATERAL (SELECT regexp_replace(coalesce(r.phone,''),'[^0-9]','','g') AS d,
   lower(btrim(coalesce(r.email,''))) AS em) k
 ), sib AS (
  SELECT j.id FROM public.jobs j
  WHERE nullif(btrim(j.ghl_contact_id),'') IS NULL AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=j.id)
   AND NOT EXISTS (SELECT 1 FROM party pa WHERE pa.id=j.id)
   AND EXISTS (SELECT 1 FROM keys WHERE keys.phone_key IS NOT NULL OR keys.email_key IS NOT NULL)
   AND ((nullif(j.client_phone,'') IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9) IN (SELECT keys.phone_key FROM keys WHERE keys.phone_key IS NOT NULL))
    OR (nullif(j.client_email,'') IS NOT NULL
     AND lower(btrim(j.client_email)) IN (SELECT keys.email_key FROM keys WHERE keys.email_key IS NOT NULL)))
 ), members AS (
  SELECT o.id, 'contact'::text AS basis FROM own o
  UNION ALL
  SELECT pa.id, 'party'::text FROM party pa
  UNION ALL
  SELECT s.id, 'contactless'::text FROM sib s
 ), facts AS (
  SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, mb.basis,
   coalesce(j.created_at,'-infinity'::timestamptz) AS created_at,
   (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false)) AS terminal,
   j.completed_at, j.updated_at, ev.at AS status_event_at
  FROM members mb JOIN public.jobs j ON j.id=mb.id
  LEFT JOIN LATERAL (
   SELECT min(coalesce(be.event_at,be.occurred_at)) AS at FROM public.business_events be
   WHERE (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false))
    AND be.entity_type='job' AND be.entity_id=j.id::text AND be.event_type='job.status_changed'
    AND lower(be.payload->'changes'->'status'->>'to') IN ('cancelled','archived','lost','closed','complete','completed')
    AND coalesce(be.event_at,be.occurred_at) > coalesce((
     SELECT max(coalesce(nt.event_at,nt.occurred_at)) FROM public.business_events nt
     WHERE nt.entity_type='job' AND nt.entity_id=j.id::text AND nt.event_type='job.status_changed'
      AND lower(nt.payload->'changes'->'status'->>'to') NOT IN ('cancelled','archived','lost','closed','complete','completed')
    ),'-infinity'::timestamptz)
  ) ev ON true
  WHERE lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true'
 ), timed AS (
  SELECT f.*,
   CASE WHEN NOT f.terminal THEN NULL
    ELSE coalesce(f.status_event_at,f.completed_at,f.updated_at,'-infinity'::timestamptz) END AS terminal_at,
   CASE WHEN NOT f.terminal THEN NULL WHEN f.status_event_at IS NOT NULL THEN 'status_event'
    WHEN f.completed_at IS NOT NULL THEN 'completed_at' WHEN f.updated_at IS NOT NULL THEN 'updated_at' ELSE 'unknown' END AS terminal_time_source
  FROM facts f
 ), windowed AS (
  SELECT t.*,
   greatest(t.created_at-interval '30 days',
    coalesce((SELECT max(p.terminal_at) FROM timed p WHERE p.id<>t.id AND p.terminal
     AND p.created_at<t.created_at AND p.terminal_at<=t.created_at),'-infinity'::timestamptz)) AS window_start
  FROM timed t
 ), placed AS (
  SELECT w.*,
   CASE WHEN w.created_at<=coalesce(p_at,now()) THEN NOT w.terminal OR w.terminal_at>coalesce(p_at,now())
    ELSE coalesce(p_at,now())>=w.window_start END AS raw_candidate
  FROM windowed w
 )
 SELECT p.id, p.job_number, p.type, p.status, p.basis, p.created_at, p.terminal, p.terminal_at, p.terminal_time_source, p.window_start,
  p.raw_candidate AND (p.status<>'draft' OR NOT EXISTS (SELECT 1 FROM placed live WHERE live.raw_candidate AND live.status<>'draft'))
 FROM placed p
$function$;
COMMENT ON FUNCTION public.context_contact_job_timeline(text,timestamptz) IS
 'Every job of a GHL contact (its own jobs, the jobs where it is a live non-owner party or a staff send linked it (basis party, C14 20261103203000), and phone- or email-matched contactless jobs) with creation, terminal time and its source, lead-window start and whether it is a candidate at p_at. Private; read context_contact_jobs_at.';

-- public.context_contact_job_timeline(text,timestamptz,text,text)
CREATE OR REPLACE FUNCTION public.context_contact_job_timeline(p_contact_id text, p_at timestamp with time zone, p_phone_key text, p_email_key text)
 RETURNS TABLE(job_id uuid, job_number text, type text, status text, basis text, created_at timestamp with time zone, terminal boolean, terminal_at timestamp with time zone, terminal_time_source text, window_start timestamp with time zone, candidate boolean, unpaid_at boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH own AS (
  SELECT j.id FROM public.jobs j WHERE p_contact_id IS NOT NULL AND j.ghl_contact_id=p_contact_id
  UNION
  SELECT m.job_id FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.job_id IS NOT NULL AND m.ghl_contact_id=p_contact_id
  UNION
  SELECT m.job_id FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.job_id IS NOT NULL AND m.xero_contact_id=p_contact_id
 ), party AS (
  SELECT c.job_id AS id FROM public.job_contacts c
  WHERE p_contact_id IS NOT NULL AND c.ghl_contact_id=p_contact_id
   AND c.removed_at IS NULL AND coalesce(c.status,'')<>'removed'
   AND c.is_primary IS NOT TRUE AND coalesce(c.source_party_key,'')<>'primary'
   AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=c.job_id)
  UNION
  SELECT l.job_id FROM public.job_contact_send_links l
  WHERE p_contact_id IS NOT NULL AND l.ghl_contact_id=p_contact_id AND l.removed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=l.job_id)
 ), raw_keys AS (
  SELECT j.client_phone AS phone, j.client_email AS email FROM public.jobs j JOIN own o ON o.id=j.id
  UNION ALL
  SELECT to_jsonb(m)->>'phone', to_jsonb(m)->>'email' FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.ghl_contact_id=p_contact_id
 ), keys AS (
  SELECT CASE WHEN length(d)>=8 AND d !~ '^(\d)\1*$' THEN right(d,9) END AS phone_key,
   CASE WHEN position('@' IN em)>1 THEN em END AS email_key
  FROM raw_keys r CROSS JOIN LATERAL (SELECT regexp_replace(coalesce(r.phone,''),'[^0-9]','','g') AS d,
   lower(btrim(coalesce(r.email,''))) AS em) k
  UNION ALL
  SELECT public.context_phone_key(p_phone_key), public.context_email_key(p_email_key)
 ), sib AS (
  SELECT j.id FROM public.jobs j
  WHERE nullif(btrim(j.ghl_contact_id),'') IS NULL AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=j.id)
   AND NOT EXISTS (SELECT 1 FROM party pa WHERE pa.id=j.id)
   AND EXISTS (SELECT 1 FROM keys WHERE keys.phone_key IS NOT NULL OR keys.email_key IS NOT NULL)
   AND ((nullif(j.client_phone,'') IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9) IN (SELECT keys.phone_key FROM keys WHERE keys.phone_key IS NOT NULL))
    OR (nullif(j.client_email,'') IS NOT NULL
     AND lower(btrim(j.client_email)) IN (SELECT keys.email_key FROM keys WHERE keys.email_key IS NOT NULL)))
 ), other AS (
  SELECT j.id FROM public.jobs j
  WHERE nullif(btrim(j.ghl_contact_id),'') IS NOT NULL AND j.ghl_contact_id IS DISTINCT FROM p_contact_id
   AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=j.id) AND NOT EXISTS (SELECT 1 FROM party pa WHERE pa.id=j.id)
   AND ((public.context_phone_key(p_phone_key) IS NOT NULL AND j.client_phone IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9)=public.context_phone_key(p_phone_key))
    OR (public.context_email_key(p_email_key) IS NOT NULL AND j.client_email IS NOT NULL
     AND lower(btrim(j.client_email))=public.context_email_key(p_email_key)))
 ), members AS (
  SELECT o.id, 'contact'::text AS basis FROM own o
  UNION ALL
  SELECT pa.id, 'party'::text FROM party pa
  UNION ALL
  SELECT s.id, 'contactless'::text FROM sib s
  UNION ALL
  SELECT x.id, 'key_other_contact'::text FROM other x
 ), facts AS (
  SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, mb.basis,
   coalesce(j.created_at,'-infinity'::timestamptz) AS created_at,
   (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false)
    OR (j.status::text='invoiced' AND j.completed_at IS NOT NULL)) AS terminal,
   j.completed_at, j.updated_at, ev.at AS status_event_at
  FROM members mb JOIN public.jobs j ON j.id=mb.id
  LEFT JOIN LATERAL (
   SELECT min(coalesce(be.event_at,be.occurred_at)) AS at FROM public.business_events be
   WHERE (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false))
    AND be.entity_type='job' AND be.entity_id=j.id::text AND be.event_type='job.status_changed'
    AND lower(be.payload->'changes'->'status'->>'to') IN ('cancelled','archived','lost','closed','complete','completed')
    AND coalesce(be.event_at,be.occurred_at) > coalesce((
     SELECT max(coalesce(nt.event_at,nt.occurred_at)) FROM public.business_events nt
     WHERE nt.entity_type='job' AND nt.entity_id=j.id::text AND nt.event_type='job.status_changed'
      AND lower(nt.payload->'changes'->'status'->>'to') NOT IN ('cancelled','archived','lost','closed','complete','completed')
    ),'-infinity'::timestamptz)
  ) ev ON true
  WHERE lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true'
 ), timed AS (
  SELECT f.*,
   CASE WHEN NOT f.terminal THEN NULL
    ELSE coalesce(f.status_event_at,f.completed_at,f.updated_at,'-infinity'::timestamptz) END AS terminal_at,
   CASE WHEN NOT f.terminal THEN NULL WHEN f.status_event_at IS NOT NULL THEN 'status_event'
    WHEN f.completed_at IS NOT NULL THEN 'completed_at' WHEN f.updated_at IS NOT NULL THEN 'updated_at' ELSE 'unknown' END AS terminal_time_source
  FROM facts f
 ), windowed AS (
  SELECT t.*,
   greatest(t.created_at-interval '30 days',
    coalesce((SELECT max(p.terminal_at) FROM timed p WHERE p.id<>t.id AND p.terminal
     AND p.created_at<t.created_at AND p.terminal_at<=t.created_at),'-infinity'::timestamptz)) AS window_start
  FROM timed t
 ), placed AS (
  SELECT w.*,
   CASE WHEN w.created_at<=coalesce(p_at,now()) THEN NOT w.terminal OR w.terminal_at>coalesce(p_at,now())
    ELSE coalesce(p_at,now())>=w.window_start END AS raw_candidate
  FROM windowed w
 )
 SELECT p.id, p.job_number, p.type, p.status, p.basis, p.created_at, p.terminal, p.terminal_at, p.terminal_time_source, p.window_start,
  p.raw_candidate AND (p.status<>'draft' OR NOT EXISTS (SELECT 1 FROM placed live WHERE live.raw_candidate AND live.status<>'draft')),
  p.terminal AND p.terminal_at<=coalesce(p_at,now()) AND public.context_job_unpaid_at(p.id,coalesce(p_at,now()))
 FROM placed p
$function$;
COMMENT ON FUNCTION public.context_contact_job_timeline(text,timestamptz,text,text) IS
 'P4: P1a''s job timeline for a contact, plus contactless and other-contact jobs whose client phone or email is the message''s own key (works with a null contact), and whether a finished job had an ACCREC invoice unpaid at p_at. C14 (20261103203000): a job where the contact is a live non-owner party or a staff send linked it is a member with basis party (the customer''s own job for every rule), never also contactless or key_other_contact. Private; read context_contact_jobs_at.';
