-- After the rollback: the three bodies and comments are the ones the
-- migration replaced, byte for byte, the grants are unchanged, and a new
-- message row is stamped by the v2 classifier again.
DO $$
DECLARE p record; r text;
BEGIN
 FOR p IN SELECT * FROM (VALUES
  ('public.context_parties_status()','98ca15b42682e9210ac4e6fe8d74ccd3','Status block parties (sites.md section 8), owned by sites S-M1:%no names.'),
  ('public.context_scorecard_lane_of(text,text,text,text,text,jsonb)','a7d601b8eaf03a5616df508e8a18b2d6','Context scorecard (20261006032000):%or null. Inlinable.'),
  ('public.context_message_party_roles(public.business_events)','8d5bb9cfa80a631ee39497282e54f967','Party roles v2 (20261006000000):%')
 ) AS t(sig,md5,note) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(p.sig)) IS DISTINCT FROM p.md5 THEN
   RAISE EXCEPTION 'party roles health rollback: % is not the restored body',p.sig; END IF;
  IF coalesce(obj_description(to_regprocedure(p.sig),'pg_proc'),'') NOT LIKE p.note
   OR coalesce(obj_description(to_regprocedure(p.sig),'pg_proc'),'') LIKE '%20261006034000%' THEN
   RAISE EXCEPTION 'party roles health rollback: % comment is not the restored one',p.sig; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','public'] LOOP
   IF has_function_privilege(r,p.sig,'EXECUTE') THEN RAISE EXCEPTION 'party roles health rollback: % can call %',r,p.sig; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role',p.sig,'EXECUTE') THEN RAISE EXCEPTION 'party roles health rollback: the service role lost %',p.sig; END IF;
 END LOOP;
END $$;

BEGIN;
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,provider_message_id,payload,metadata,occurred_at,event_at)
 VALUES('ph-rb','contact','ph-rb','outbound','sms','client.sms_out','party_roles_health_contract','ph:rollback',
  jsonb_build_object('body','New job assigned: SWF-993999 - Fixture'),'{"capture_mode":"live"}',now(),now())
 RETURNING * INTO e;
 IF e.metadata->'party_roles'->>'version' IS DISTINCT FROM 'party_roles_v2' OR e.metadata->'party_roles'->>'basis' IS DISTINCT FROM 'no_match' THEN
  RAISE EXCEPTION 'party roles health rollback: a new row must be stamped by v2 again, got %',e.metadata->'party_roles';
 END IF;
END $$;
ROLLBACK;
