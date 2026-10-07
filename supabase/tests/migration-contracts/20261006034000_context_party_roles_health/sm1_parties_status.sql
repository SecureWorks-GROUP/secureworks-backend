-- Sites S-M1's context_parties_status(), byte for byte with its comment
-- (20261002120000, md5(prosrc) 98ca15b42682e9210ac4e6fe8d74ccd3). Not a
-- migration. 20261006034000 replaced this body; the S-M1 contract's re-apply
-- (block 12) loads this file inside its rolled-back block whenever the live
-- body is not S-M1's, so S-M1 is re-applied over the pre-image it was written
-- for and no other function moves. This case's contract checks the md5 and
-- the comment, and that loading it touches nothing else.
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
 -- (review S3: a scope sync that never ran). Live fencing jobs only.
 parties:=parties||jsonb_build_object('pricing_neighbours_without_party_rows',(
  SELECT count(*) FROM public.jobs j
  WHERE j.type::text='fencing' AND NOT (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false))
   AND jsonb_typeof(j.pricing_json->'neighbour_splits')='array' AND jsonb_array_length(j.pricing_json->'neighbour_splits')>0
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
 'Status block parties (sites.md section 8), owned by sites S-M1: party counts and flags, shared GHL contacts, duplicate letters, live fencing jobs whose pricing lists neighbours but that have no party rows, multi-party invoices with no party, site-link decisions, 7-day receipt counts, the party linker''s last run and the party_linker_stale alarm. Counts only, no names.';
