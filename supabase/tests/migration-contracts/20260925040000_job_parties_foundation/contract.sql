-- S-M1 contract (sites.md sections 2, 4, 8, 10 and 12 M1; INTEGRATION X6,
-- X19, X32, G-SITES-GRANTS). Behavioural tests on recorded fixtures shaped like
-- the design's named sites (job numbers and GHL ids from sites.md section 10;
-- party names are synthetic). Every fixture write is rolled back.
--
--   1. Access: the public key and signed-in logins hold nothing on the three
--      tables (TRUNCATE included, which RLS never covered) and execute nothing.
--   2. Deploy is a no-op: the pre-existing S5 rows are unchanged, and a jobs
--      contact update on a job with no primary-keyed party writes nothing.
--   3. Letters, keys, effective_from (S1 SWF-26075, F3).
--   4. A reused key never rewrites a person (S5 SWF-261105, review M1).
--   5. The owner party follows jobs one way (S13 SWF-261460, review M2).
--   6. Shares from portions (S9 SWF-261335, review S1).
--   7. set_job_party_ids: fills, refuses overwrite, linker checks, owner
--      refusal, reconsideration gated by job_parties_v1 (S4, S6, S8).
--   8. context_contact_parties_at: clause (a), (b) unpaid, (b) 60-day window
--      (S3 SWF-26395, S5 SWF-261105; review B3).
--   9. context_job_event_parties: sender party, ambiguous, mentions,
--      mentions_possible, unmatched lettered number (S2 SWF-26904, F1; S9, P4).
--  10. context_site_candidates (S1, S8, S12) and link_site_jobs.
--  11. context_parties_status() in the composer.

-- 1. Access.
DO $$
DECLARE r text; p text; t text; f text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.job_contacts','public.job_party_events','public.job_site_links'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF has_table_privilege(r,t,p) THEN RAISE EXCEPTION 's-m1 % still holds % on %',r,p,t; END IF;
   END LOOP;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=t::regclass) THEN RAISE EXCEPTION 's-m1 RLS off on %',t; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=split_part(t,'.',2)) THEN RAISE EXCEPTION 's-m1 policy on %',t; END IF;
 END LOOP;
 -- service_role keeps job_contacts (every writer today is an edge function);
 -- the two new tables are read-only to it.
 FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
  IF NOT has_table_privilege('service_role','public.job_contacts',p) THEN RAISE EXCEPTION 's-m1 service_role lost % on job_contacts',p; END IF;
 END LOOP;
 IF NOT has_table_privilege('service_role','public.job_party_events','SELECT') OR has_table_privilege('service_role','public.job_party_events','INSERT')
  OR NOT has_table_privilege('service_role','public.job_site_links','SELECT') OR has_table_privilege('service_role','public.job_site_links','UPDATE')
 THEN RAISE EXCEPTION 's-m1 new tables must be SELECT-only for service_role'; END IF;
 FOREACH f IN ARRAY ARRAY['public.upsert_job_party(uuid,text,jsonb,text,uuid)','public.set_job_party_ids(uuid,text,text,text,text,text)',
  'public.context_contact_parties_at(text,timestamptz)','public.context_job_event_parties(uuid)','public.context_site_candidates(uuid)',
  'public.link_site_jobs(uuid,uuid,text,text,text,jsonb)','public.context_parties_status()','public.context_site_address(text)',
  'public.job_party_flag_on()','public.job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb)',
  'public.job_party_reconsider(public.job_contacts,text)','public.job_contacts_owner_mirror()'] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 's-m1 % executable by the public key or a login',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.job_party_flag_on()','public.job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb)',
  'public.job_party_reconsider(public.job_contacts,text)','public.job_contacts_owner_mirror()'] LOOP
  IF has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 's-m1 private helper % granted',f; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.upsert_job_party(uuid,text,jsonb,text,uuid)','EXECUTE') THEN RAISE EXCEPTION 's-m1 writer not granted'; END IF;
 -- run_summary reads job_contacts names past RLS: closed to the public key and
 -- logins, and it follows the caller's rights.
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_table_privilege(r,'public.run_summary','SELECT') THEN RAISE EXCEPTION 's-m1 % can read run_summary',r; END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.run_summary'::regclass AND 'security_invoker=true'=ANY(reloptions))
 THEN RAISE EXCEPTION 's-m1 run_summary is not security_invoker'; END IF;
END $$;

-- run_summary, behaviourally: the public key and a login are refused; the
-- staff path (service_role) still reads it.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
 PERFORM 1 FROM public.run_summary;
 RAISE EXCEPTION 's-m1 anon read run_summary';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
ROLLBACK;
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
 PERFORM 1 FROM public.run_summary;
 RAISE EXCEPTION 's-m1 authenticated read run_summary';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
ROLLBACK;
BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
 IF (SELECT count(*) FROM public.run_summary WHERE job_id='1694c4a9-4641-4e74-ba8b-78b2e54b8d1d' AND run_label='REAR')<>1
 THEN RAISE EXCEPTION 's-m1 service_role cannot read run_summary'; END IF;
END $$;
RESET ROLE;
ROLLBACK;

-- The TRUNCATE hole, behaviourally: the public key could empty the table
-- before (setup proves the grant); now it is refused.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
 TRUNCATE public.job_contacts;
 RAISE EXCEPTION 's-m1 anon truncated job_contacts';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
ROLLBACK;
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
 TRUNCATE public.job_contacts;
 RAISE EXCEPTION 's-m1 authenticated truncated job_contacts';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
ROLLBACK;

-- Indexes and the trigger.
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_job_contacts_job_label' AND indexdef LIKE 'CREATE UNIQUE INDEX%(job_id, contact_label)')
 THEN RAISE EXCEPTION 's-m1 unique letter index missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='job_contacts_job_source_party_key' AND indexdef LIKE 'CREATE UNIQUE INDEX%') THEN RAISE EXCEPTION 's-m1 key index missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND tgname='job_contacts_owner_mirror' AND tgenabled<>'D')
 THEN RAISE EXCEPTION 's-m1 owner mirror trigger missing'; END IF;
END $$;

-- 2. Deploy is a no-op on existing rows.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM public.job_contacts WHERE job_id='1694c4a9-4641-4e74-ba8b-78b2e54b8d1d' LOOP
  IF r.source_party_key IS NOT NULL OR r.party_role IS NOT NULL OR r.effective_from IS NOT NULL OR r.removed_at IS NOT NULL
   OR r.party_flags<>'{}' OR r.updated_at>'2026-05-03'::timestamptz
  THEN RAISE EXCEPTION 's-m1 the migration wrote a pre-existing row %',to_jsonb(r); END IF;
 END LOOP;
 IF (SELECT phone_last9 FROM public.job_contacts WHERE id='5e5c0000-0000-4000-8000-00000000005b')<>'411000205' THEN RAISE EXCEPTION 's-m1 phone_last9 not generated'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_party_events) OR EXISTS (SELECT 1 FROM public.job_site_links) THEN RAISE EXCEPTION 's-m1 the migration wrote receipts or links'; END IF;
END $$;
BEGIN;
UPDATE public.jobs SET client_phone='0411 999 105',ghl_contact_id='changedGhlS5' WHERE id='1694c4a9-4641-4e74-ba8b-78b2e54b8d1d';
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.job_party_events) THEN RAISE EXCEPTION 's-m1 trigger wrote for a job with no primary-keyed party'; END IF;
 IF (SELECT client_phone FROM public.job_contacts WHERE id='5e5c0000-0000-4000-8000-00000000005a')<>'0411 000 105' THEN RAISE EXCEPTION 's-m1 trigger mirrored an unkeyed owner row'; END IF;
END $$;
ROLLBACK;

-- Shared fixture jobs for sections 3 to 11, loaded inside each transaction.
CREATE TEMP TABLE sm1_jobs AS SELECT * FROM (VALUES
 -- S1: 17 Clarke Rd, Morley, archived, and its same-address sibling.
 ('68e2e301-aa3a-4d5d-9924-d907643e1cba'::uuid,'SWF-26075','archived','S1 Owner Party','0411 000 101','eUujDpEfZlwnQXHcmJHN','a03ae102-0000-4000-8000-000000000101','17 Clarke Rd','Morley','2026-04-10 02:00:00+00'::timestamptz),
 ('8ad5bc77-50e5-48b6-bff7-34a7234b977d'::uuid,'SWF-26078','archived','S1 Owner Party','0411 000 101','eUujDpEfZlwnQXHcmJHN',NULL,'17 Clarke Road','Morley','2026-04-12 02:00:00+00'),
 ('5f000000-0000-4000-8000-000000000170'::uuid,'SWF-FX170','quoted','Other Street Owner','0411 000 170','fxOtherSuburb',NULL,'17 Clarke Rd','Bayswater','2026-04-12 02:00:00+00'),
 -- S2: 378/2 The Strand, Dianella.
 ('ad84e193-83b8-446b-bafd-d720b9d9d204','SWF-26904','invoiced','S2 Owner Party','0411 000 102','iiWS1f1k7ztbdQOYN6iH',NULL,'378/2 The Strand','Dianella','2026-06-01 02:00:00+00'),
 -- S3: 4 Chepstow Way, Butler, completed 30 Jul.
 ('66279d26-e267-43be-ac73-e06a136f336b','SWF-26395','complete','S3 Owner Party','0411 000 103','fxS3Owner',NULL,'4 Chepstow Way','Butler','2026-05-20 02:00:00+00'),
 -- S4: 73 Benenden Ave, Butler.
 ('d633c895-7e10-4198-8e42-a3aeae475698','SWF-261209','quoted','S3 Neighbour C','0411 000 303','9wd4UDe6f9eW83msKylC',NULL,'73 Benenden Ave','Butler','2026-07-20 02:00:00+00'),
 -- S6: 51A Balcombe Way, Westminster.
 ('1d277f6e-dd11-4e49-b606-a3586d1ed1ea','SWF-26535','invoiced','S6 Owner Party','0411 000 106','xZG3ClBWYweIlTSk1JxU',NULL,'51A Balcombe Way','Westminster','2026-06-05 02:00:00+00'),
 -- S8: 32 Warrener Gardens, Gwelup, two jobs one site, same owner.
 ('3450cda7-0000-4000-8000-000000000108','SWF-261423','quoted','S8 Owner Party','0411 000 108','fxS8Owner',NULL,'32 Warrener Gardens','Gwelup','2026-08-01 02:00:00+00'),
 ('30f413aa-0000-4000-8000-000000000108','SWF-261246','quoted','S8 Owner Party','0411 000 108','fxS8Owner',NULL,'32 Warrener Gardens','Gwelup','2026-07-01 02:00:00+00'),
 ('5f000000-0000-4000-8000-000000000108','SWF-FX108','quoted','S8 Owner Party','0411 000 108','fxS8Owner',NULL,'30 Warrener Gardens','Gwelup','2026-07-15 02:00:00+00'),
 -- S9: 11 Hunn Ct, Quinns Rocks.
 ('d1da4879-0000-4000-8000-000000000109','SWF-261335','scheduled','S9 Owner Party','0411 000 109','fxS9Owner',NULL,'11 Hunn Ct','Quinns Rocks','2026-08-01 02:00:00+00'),
 -- S12: 4 Hodge Ct, Marmion, six jobs.
 ('5c120000-0000-4000-8000-000000026025','SWF-26025','complete','S12 Owner Party','0411 000 112','fxS12Owner',NULL,'4 Hodge Ct','Marmion','2026-03-01 02:00:00+00'),
 ('5c120000-0000-4000-8000-000000026027','SWF-26027','complete','S12 Owner Party','0411 000 112','fxS12Owner',NULL,'4 Hodge Court','Marmion','2026-03-02 02:00:00+00'),
 ('5c120000-0000-4000-8000-000000026036','SWF-26036','complete','S12 Owner Party','0411 000 112','fxS12Owner',NULL,'4 Hodge Ct, Marmion WA 6020','Marmion','2026-03-03 02:00:00+00'),
 ('5c120000-0000-4000-8000-000000026059','SWF-26059','complete','S12 Owner Party','0411 000 112','fxS12Owner',NULL,'4 Hodge Ct','Marmion','2026-03-04 02:00:00+00'),
 ('5c120000-0000-4000-8000-000000026060','SWF-26060','complete','S12 Owner Party','0411 000 112','fxS12Owner',NULL,'4 Hodge Ct','Marmion','2026-03-05 02:00:00+00'),
 ('5c120000-0000-4000-8000-000000026061','SWF-26061','complete','S12 Owner Party','0411 000 112','fxS12Owner',NULL,'4 Hodge Ct','Marmion','2026-03-06 02:00:00+00'),
 -- S13: an agent's contact wrongly on another customer's job.
 ('5c130000-0000-4000-8000-000000261459','SWF-261459','quoted','S13 Agent Party','0411 000 113','5BFz2c6oUIgZuCSyKhFM','xero-s13-agent','9 Fixture St','Wembley','2026-09-01 02:00:00+00'),
 ('5c130000-0000-4000-8000-000000261460','SWF-261460','quoted','S13 Agent Party','0411 000 113','5BFz2c6oUIgZuCSyKhFM','xero-s13-agent','11 Fixture St','Wembley','2026-09-01 02:00:00+00')
) AS t(id,job_number,status,client_name,client_phone,ghl,xero,site_address,site_suburb,created_at);

CREATE TEMP TABLE sm1_check(n int);  -- scratch for the DO blocks below

-- 3. Letters, keys and effective_from (S1 SWF-26075, finding F3).
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
DO $$
DECLARE o jsonb; school jsonb; aaron jsonb; raj jsonb; staff jsonb; r record; j uuid:='68e2e301-aa3a-4d5d-9924-d907643e1cba';
BEGIN
 o:=public.upsert_job_party(j,'primary','{}'::jsonb,'contract');
 -- Alone on the job with no portions, the owner holds the whole job.
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid) IS DISTINCT FROM 100 THEN RAISE EXCEPTION 's-m1 lone owner share'; END IF;
 school:=public.upsert_job_party(j,'nb-1','{"client_name":"S1 Other Payer","client_phone":"0000000000","client_email":"s1-payer@example.test","ghl_contact_id":"uKFOBB1LDs21QjqLzJPw"}','contract');
 aaron:=public.upsert_job_party(j,'nb-1781145678212','{"client_name":"S1 Neighbour Two","client_email":"s1-n2@example.test","site_address":"17 Clarke Road"}','contract');
 raj:=public.upsert_job_party(j,'nb-1781145686085','{"client_name":"S1 Neighbour Three","ghl_contact_id":"218UWy5aDT6PSgaCm5hq","site_address":"17a Clarke Road"}','contract');
 IF o->>'outcome'<>'party_inserted' OR o->>'label'<>'A' OR school->>'label'<>'B' OR aaron->>'label'<>'C' OR raj->>'label'<>'D'
 THEN RAISE EXCEPTION 's-m1 letters % % % %',o,school,aaron,raj; END IF;
 SELECT * INTO r FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid;
 -- The owner comes from jobs, role owner, is_primary.
 IF r.client_name<>'S1 Owner Party' OR r.ghl_contact_id<>'eUujDpEfZlwnQXHcmJHN' OR r.xero_contact_id<>'a03ae102-0000-4000-8000-000000000101'
  OR r.party_role<>'owner' OR r.is_primary IS NOT TRUE OR r.contact_type<>'primary' OR r.effective_from<>'2026-04-10 02:00:00+00'
 THEN RAISE EXCEPTION 's-m1 owner row %',to_jsonb(r); END IF;
 -- F3: a party added in June keyed with its epoch starts in June, not at the job's creation.
 IF (SELECT effective_from FROM public.job_contacts WHERE id=(aaron->>'job_contact_id')::uuid)<>'2026-06-11 02:41:18.212+00'
 THEN RAISE EXCEPTION 's-m1 effective_from from the fence key'; END IF;
 -- nb-1 carries no epoch: the job's creation.
 IF (SELECT effective_from FROM public.job_contacts WHERE id=(school->>'job_contact_id')::uuid)<>'2026-04-10 02:00:00+00' THEN RAISE EXCEPTION 's-m1 nb-1 effective_from'; END IF;
 -- With three neighbours and no portions the owner's share is unknown, never
 -- the whole job; the first neighbour's receipt says so.
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 's-m1 owner kept the whole job beside neighbours'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_contact_id=(school->>'job_contact_id')::uuid
   AND detail->'owner_share'=jsonb_build_object('job_contact_id',o->>'job_contact_id','share_percentage',NULL))
 THEN RAISE EXCEPTION 's-m1 owner share change not in the receipt'; END IF;
 -- A later owner save with no portions keeps it unknown.
 PERFORM public.upsert_job_party(j,'primary','{}'::jsonb,'contract');
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 's-m1 owner share restored to 100'; END IF;
 -- A placeholder phone (Ishwar's 0000000000) never becomes a key and is flagged.
 SELECT * INTO r FROM public.job_contacts WHERE id=(school->>'job_contact_id')::uuid;
 IF r.phone_last9 IS NOT NULL OR NOT 'placeholder_phone'=ANY(r.party_flags) THEN RAISE EXCEPTION 's-m1 placeholder phone %',to_jsonb(r); END IF;
 -- A GHL id set on insert asks for reconsideration; the flag is off, so it records flag_off.
 IF school#>>'{reconsider,outcome}'<>'flag_off' THEN RAISE EXCEPTION 's-m1 reconsider not gated %',school; END IF;
 -- Soft removal keeps the letter; a later party never reuses it.
 IF public.upsert_job_party(j,'nb-1781145678212','{"status":"removed"}','contract')->>'outcome'<>'party_removed' THEN RAISE EXCEPTION 's-m1 remove'; END IF;
 staff:=public.upsert_job_party(j,'staff:11111111-1111-4111-8111-111111111111','{"client_name":"S1 Staff Added Payer","party_role":"other_payer"}','contract');
 IF staff->>'label'<>'E' THEN RAISE EXCEPTION 's-m1 letter reused %',staff; END IF;
 IF (SELECT status FROM public.job_contacts WHERE id=(aaron->>'job_contact_id')::uuid)<>'removed'
  OR (SELECT removed_at FROM public.job_contacts WHERE id=(aaron->>'job_contact_id')::uuid) IS NULL THEN RAISE EXCEPTION 's-m1 soft removal'; END IF;
 -- Re-adding the same person restores the same party.
 IF public.upsert_job_party(j,'nb-1781145678212','{"client_name":"S1 Neighbour Two","client_email":"s1-n2@example.test","status":"active"}','contract')->>'outcome'<>'party_restored'
 THEN RAISE EXCEPTION 's-m1 restore'; END IF;
 -- A repeat with nothing new is unchanged; one receipt per call, ids and codes only.
 IF public.upsert_job_party(j,'nb-1781145686085','{"client_name":"S1 Neighbour Three"}','contract')->>'outcome'<>'party_unchanged' THEN RAISE EXCEPTION 's-m1 unchanged'; END IF;
 IF (SELECT count(*) FROM public.job_party_events WHERE job_id=j)<>9 THEN RAISE EXCEPTION 's-m1 receipts %',(SELECT count(*) FROM public.job_party_events WHERE job_id=j); END IF;
 IF EXISTS (SELECT 1 FROM public.job_party_events WHERE job_id=j AND (before::text ~* 'S1 |example\.test|0411|0000000000' OR after::text ~* 'S1 |example\.test|0411|0000000000' OR detail::text ~* 'S1 |example\.test|0411'))
 THEN RAISE EXCEPTION 's-m1 a receipt carries a name, email or phone'; END IF;
 -- An existing neighbour's ids never change through the writer: an id passed
 -- for a party with none leaves it empty (set_job_party_ids is the only way).
 aaron:=public.upsert_job_party(j,'nb-1781145678212','{"client_name":"S1 Neighbour Two","ghl_contact_id":"fxAaronGhl","xero_contact_id":"fxAaronXero"}','contract');
 SELECT * INTO r FROM public.job_contacts WHERE id=(aaron->>'job_contact_id')::uuid;
 IF r.ghl_contact_id IS NOT NULL OR r.xero_contact_id IS NOT NULL OR aaron->>'outcome'<>'party_unchanged' OR aaron#>>'{reconsider}' IS NOT NULL
 THEN RAISE EXCEPTION 's-m1 upsert changed an existing neighbour''s ids % %',aaron,to_jsonb(r); END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_contact_id=r.id AND detail->'ids_not_applied'='["ghl_contact_id","xero_contact_id"]'::jsonb)
 THEN RAISE EXCEPTION 's-m1 ignored ids not recorded'; END IF;
 -- Contract refusals.
 BEGIN PERFORM public.upsert_job_party(j,'primary','{"client_name":"x"}','contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'owner_fields_follow_job' THEN RAISE; END IF; END;
 BEGIN PERFORM public.upsert_job_party(j,'nb-9','{"share_percentage":50}','contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'party_field_unknown' THEN RAISE; END IF; END;
 BEGIN PERFORM public.upsert_job_party(j,'nb-9','{"client_name":"x"}',' '); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'party_actor_required' THEN RAISE; END IF; END;
 BEGIN PERFORM public.upsert_job_party(j,'nb-9#2','{"client_name":"x"}','contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'party_key_invalid' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

-- 4. A reused key never rewrites a person (S5 SWF-261105, review M1): the
-- legacy rows are adopted, then nb-1 is overtyped with a different person.
BEGIN;
DO $$
DECLARE o jsonb; a jsonb; b jsonb; c jsonb; j uuid:='1694c4a9-4641-4e74-ba8b-78b2e54b8d1d'; r record;
BEGIN
 o:=public.upsert_job_party(j,'primary','{}'::jsonb,'contract');
 a:=public.upsert_job_party(j,'nb-1','{"client_name":"S5 Neighbour Party","client_phone":"+61 411 000 205"}','contract');
 IF o->>'job_contact_id'<>'5e5c0000-0000-4000-8000-00000000005a' OR o->>'outcome'<>'party_adopted'
  OR a->>'job_contact_id'<>'5e5c0000-0000-4000-8000-00000000005b' OR a->>'outcome' NOT IN ('party_adopted','party_updated')
 THEN RAISE EXCEPTION 's-m1 legacy rows not adopted % %',o,a; END IF;
 -- Overtype nb-1 with someone else (different phone and email): the stored
 -- party has a GHL and a Xero id, so it is retired and a new party inserted.
 b:=public.upsert_job_party(j,'nb-1','{"client_name":"S5 Replacement Party","client_phone":"0422 000 999","client_email":"s5-other@example.test"}','contract');
 IF b->>'outcome'<>'party_replaced' OR b->>'source_party_key'<>'nb-1#2' OR b->>'label'<>'C' OR b->>'replaced_job_contact_id'<>'5e5c0000-0000-4000-8000-00000000005b'
 THEN RAISE EXCEPTION 's-m1 reused key %',b; END IF;
 SELECT * INTO r FROM public.job_contacts WHERE id='5e5c0000-0000-4000-8000-00000000005b';
 IF r.status<>'removed' OR r.removed_at IS NULL OR r.client_name<>'S5 Neighbour Party' OR r.ghl_contact_id<>'Uki8zBjuAJSP5Em19ZsK' OR r.xero_contact_id IS NULL
 THEN RAISE EXCEPTION 's-m1 the old person was rewritten %',to_jsonb(r); END IF;
 SELECT * INTO r FROM public.job_contacts WHERE id=(b->>'job_contact_id')::uuid;
 IF r.ghl_contact_id IS NOT NULL OR r.xero_contact_id IS NOT NULL THEN RAISE EXCEPTION 's-m1 ids carried over to the new person'; END IF;
 -- The next save of nb-1 with the same new person updates the replacement.
 c:=public.upsert_job_party(j,'nb-1','{"client_name":"S5 Replacement Party","client_phone":"0422 000 999","client_email":"s5-other@example.test"}','contract');
 IF c->>'job_contact_id'<>b->>'job_contact_id' OR c->>'outcome'<>'party_unchanged' THEN RAISE EXCEPTION 's-m1 replacement not followed %',c; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE change='party_replaced' AND job_contact_id=(b->>'job_contact_id')::uuid
   AND detail->>'replaced_job_contact_id'='5e5c0000-0000-4000-8000-00000000005b') THEN RAISE EXCEPTION 's-m1 replacement receipt'; END IF;
 -- A party with no ids, documents, invoices or acceptances is updated in place.
 a:=public.upsert_job_party(j,'nb-1','{"client_name":"S5 Corrected Name","client_phone":"0433 000 111","client_email":"s5-corrected@example.test"}','contract');
 IF a->>'job_contact_id'<>b->>'job_contact_id' OR a->>'outcome'<>'party_updated' THEN RAISE EXCEPTION 's-m1 unanchored party not updated in place %',a; END IF;
END $$;
ROLLBACK;

-- 4b. The same neighbour with a corrected phone (S4 SWF-261209: one digit
-- off) is the same person: updated in place, ids kept, correction recorded.
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
DO $$
DECLARE a jsonb; b jsonb; r record; e record; j uuid:='d633c895-7e10-4198-8e42-a3aeae475698';
BEGIN
 a:=public.upsert_job_party(j,'nb-1','{"client_name":"S4 Neighbour Party","client_phone":"+61 412 424 035","ghl_contact_id":"fxS4NeighbourGhl"}','contract');
 b:=public.upsert_job_party(j,'nb-1','{"client_name":"S4 Neighbour Party","client_phone":"+61 412 424 036"}','contract');
 IF b->>'outcome'<>'party_updated' OR b->>'job_contact_id'<>a->>'job_contact_id' OR b->>'source_party_key'<>'nb-1' OR b->>'label'<>a->>'label'
 THEN RAISE EXCEPTION 's-m1 S4 corrected phone split the person %',b; END IF;
 SELECT * INTO r FROM public.job_contacts WHERE id=(a->>'job_contact_id')::uuid;
 IF r.status<>'active' OR r.ghl_contact_id<>'fxS4NeighbourGhl' OR r.phone_last9<>'412424036' THEN RAISE EXCEPTION 's-m1 S4 party %',to_jsonb(r); END IF;
 IF (SELECT count(*) FROM public.job_contacts WHERE job_id=j)<>1 THEN RAISE EXCEPTION 's-m1 S4 a second party was inserted'; END IF;
 SELECT * INTO e FROM public.job_party_events WHERE job_contact_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF e.change<>'party_updated' OR e.detail->'identity_correction'<>'[{"key":"phone","method":"same_name"}]'::jsonb
  OR e.detail::text ~ '41242403|0412|[0-9a-f]{8}' OR e.detail::text ~* md5('412424035') OR e.detail::text ~* md5('412424036')
 THEN RAISE EXCEPTION 's-m1 S4 correction receipt %',to_jsonb(e); END IF;
 -- A different name and a different phone on the same key is someone else.
 b:=public.upsert_job_party(j,'nb-1','{"client_name":"Someone Else Entirely","client_phone":"0433 111 222"}','contract');
 IF b->>'outcome'<>'party_replaced' OR b->>'source_party_key'<>'nb-1#2' THEN RAISE EXCEPTION 's-m1 S4 other person not replaced %',b; END IF;
END $$;
ROLLBACK;

-- 4c. The owner's share with no portions follows whether a neighbour is
-- active: 100 alone, unknown beside a neighbour, 100 again once the last
-- neighbour is soft-removed (S12 SWF-26025).
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
DO $$
DECLARE o jsonb; n jsonb; j uuid:='5c120000-0000-4000-8000-000000026025';
BEGIN
 o:=public.upsert_job_party(j,'primary','{}'::jsonb,'contract');
 n:=public.upsert_job_party(j,'nb-1','{"client_name":"S12 Neighbour Party"}','contract');
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 's-m1 S12 owner whole beside a neighbour'; END IF;
 PERFORM public.upsert_job_party(j,'nb-1','{"status":"removed"}','contract');
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid) IS DISTINCT FROM 100 THEN RAISE EXCEPTION 's-m1 S12 owner not whole after the last neighbour left'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_contact_id=(n->>'job_contact_id')::uuid
   AND detail->'owner_share'=jsonb_build_object('job_contact_id',o->>'job_contact_id','share_percentage',100)) THEN RAISE EXCEPTION 's-m1 S12 owner share receipt'; END IF;
 PERFORM public.upsert_job_party(j,'nb-1','{"status":"active"}','contract');
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 's-m1 S12 owner whole after restore'; END IF;
 -- A neighbour removed outside the writer (a legacy path): the next owner save restores the whole share.
 UPDATE public.job_contacts SET status='removed',removed_at=now() WHERE id=(n->>'job_contact_id')::uuid;
 PERFORM public.upsert_job_party(j,'primary','{}'::jsonb,'contract');
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid) IS DISTINCT FROM 100 THEN RAISE EXCEPTION 's-m1 S12 owner save did not restore 100'; END IF;
END $$;
ROLLBACK;

-- 5. The owner party follows jobs one way (S13 SWF-261460, review M2, X19).
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
DO $$
DECLARE o jsonb; j uuid:='5c130000-0000-4000-8000-000000261460'; r record; e record;
BEGIN
 o:=public.upsert_job_party(j,'primary','{}'::jsonb,'contract');
 -- The wrong-customer repair edits jobs only; the owner party follows with no conflict.
 UPDATE public.jobs SET client_name='S13 Customer Party',ghl_contact_id='fxS13Customer' WHERE id=j;
 SELECT * INTO r FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid;
 IF r.client_name<>'S13 Customer Party' OR r.ghl_contact_id<>'fxS13Customer' OR r.party_flags<>'{}' THEN RAISE EXCEPTION 's-m1 repair not mirrored %',to_jsonb(r); END IF;
 SELECT * INTO e FROM public.job_party_events WHERE job_contact_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF e.actor<>'jobs_trigger' OR e.method<>'owner_mirror' OR e.change<>'party_updated'
  OR NOT e.detail->'replaced_ids' @> '[{"field":"ghl_contact_id","old":"5BFz2c6oUIgZuCSyKhFM"}]' THEN RAISE EXCEPTION 's-m1 mirror receipt %',to_jsonb(e); END IF;
 -- A null never overwrites a set id: the row keeps it and is flagged.
 UPDATE public.jobs SET xero_contact_id=NULL WHERE id=j;
 SELECT * INTO r FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid;
 IF r.xero_contact_id<>'xero-s13-agent' OR NOT 'owner_id_divergence'=ANY(r.party_flags) THEN RAISE EXCEPTION 's-m1 null copied over a set id %',to_jsonb(r); END IF;
 -- Staff fix it on jobs; the flag clears.
 UPDATE public.jobs SET xero_contact_id='xero-s13-customer' WHERE id=j;
 SELECT * INTO r FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid;
 IF r.xero_contact_id<>'xero-s13-customer' OR r.party_flags<>'{}' THEN RAISE EXCEPTION 's-m1 divergence not cleared %',to_jsonb(r); END IF;
 -- An unrelated jobs update does not fire the mirror.
 UPDATE public.jobs SET site_suburb='Floreat' WHERE id=j;
 IF (SELECT count(*) FROM public.job_party_events WHERE job_id=j)<>4 THEN RAISE EXCEPTION 's-m1 mirror fired on another column'; END IF;
 -- set_job_party_ids refuses owner rows.
 BEGIN PERFORM public.set_job_party_ids((o->>'job_contact_id')::uuid,'x',NULL,'staff','staff','contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'owner_ids_follow_job' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

-- A failing mirror never fails the job update; it leaves a receipt.
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,created_at)
VALUES('5c130000-0000-4000-8000-000000000999','00000000-0000-0000-0000-000000000001','quoted','fencing','SWF-FX999','Mirror Fail Party',now());
SELECT public.upsert_job_party('5c130000-0000-4000-8000-000000000999','primary','{}'::jsonb,'contract');
-- Force the writer to fail inside the mirror: a (test-only) check the owner
-- row's new phone breaks.
ALTER TABLE public.job_contacts ADD CONSTRAINT sm1_force_fail CHECK (client_phone IS DISTINCT FROM 'force-fail') NOT VALID;
UPDATE public.jobs SET client_phone='force-fail' WHERE id='5c130000-0000-4000-8000-000000000999';
DO $$
BEGIN
 IF (SELECT client_phone FROM public.jobs WHERE id='5c130000-0000-4000-8000-000000000999')<>'force-fail' THEN RAISE EXCEPTION 's-m1 job update lost'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_id='5c130000-0000-4000-8000-000000000999' AND change='owner_mirror_failed' AND detail->>'code'='23514')
 THEN RAISE EXCEPTION 's-m1 mirror failure not recorded'; END IF;
END $$;
ROLLBACK;

-- 6. Shares from portions (S9 SWF-261335, review S1): both portions recorded
-- as the full $5,832.75 make each share 50%, never 100%.
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
DO $$
DECLARE o jsonb; n jsonb; j uuid:='d1da4879-0000-4000-8000-000000000109'; r record;
BEGIN
 o:=public.upsert_job_party(j,'primary','{"portion_inc_gst":5832.75,"portions_total_inc_gst":11665.50}','contract');
 n:=public.upsert_job_party(j,'nb-1','{"client_name":"S9 Neighbour Party","site_address":"15 Hunn Court","portion_inc_gst":5832.75,"portions_total_inc_gst":11665.50}','contract');
 SELECT * INTO r FROM public.job_contacts WHERE id=(n->>'job_contact_id')::uuid;
 IF r.share_percentage<>50.00 OR r.quote_value_ex_gst<>5302.50 THEN RAISE EXCEPTION 's-m1 neighbour share %',to_jsonb(r); END IF;
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(o->>'job_contact_id')::uuid)<>50.00 THEN RAISE EXCEPTION 's-m1 owner share'; END IF;
 -- Per run: an explicit ex-GST portion wins over inc/1.1.
 n:=public.upsert_job_party(j,'nb-1','{"portion_inc_gst":2200,"portion_ex_gst":2000,"portions_total_inc_gst":8800}','contract');
 SELECT * INTO r FROM public.job_contacts WHERE id=(n->>'job_contact_id')::uuid;
 IF r.share_percentage<>25.00 OR r.quote_value_ex_gst<>2000 THEN RAISE EXCEPTION 's-m1 per-run share %',to_jsonb(r); END IF;
 -- No portions: the stored share is left alone.
 n:=public.upsert_job_party(j,'nb-1','{"client_name":"S9 Neighbour Party"}','contract');
 IF (SELECT share_percentage FROM public.job_contacts WHERE id=(n->>'job_contact_id')::uuid)<>25.00 THEN RAISE EXCEPTION 's-m1 share moved without portions'; END IF;
 BEGIN PERFORM public.upsert_job_party(j,'nb-1','{"portion_inc_gst":9000,"portions_total_inc_gst":8800}','contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'party_portion_exceeds_total' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

-- 7. set_job_party_ids (S4 SWF-261209, S6 SWF-26535, S8 SWF-261423).
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
DO $$
DECLARE jo jsonb; anna jsonb; fiona jsonb; r jsonb; row record;
BEGIN
 -- S4: the linker found the neighbour's email but her phone differs by one
 -- digit: no link, identity_conflict, last check stamped.
 jo:=public.upsert_job_party('d633c895-7e10-4198-8e42-a3aeae475698','nb-1','{"client_name":"S4 Neighbour Party","client_phone":"+61 412 424 035","client_email":"s4-jo@example.test"}','contract');
 r:=public.set_job_party_ids((jo->>'job_contact_id')::uuid,NULL,NULL,'linker','phone_differs','workflow:party_linker');
 SELECT * INTO row FROM public.job_contacts WHERE id=(jo->>'job_contact_id')::uuid;
 IF r->>'outcome'<>'party_identity_conflict' OR row.ghl_contact_id IS NOT NULL OR NOT 'identity_conflict'=ANY(row.party_flags) OR row.last_link_checked_at IS NULL
 THEN RAISE EXCEPTION 's-m1 S4 linker %',r; END IF;
 -- S6: the neighbour already has a GHL id; a different one is refused.
 anna:=public.upsert_job_party('1d277f6e-dd11-4e49-b606-a3586d1ed1ea','nb-1','{"client_name":"S6 Neighbour Party","ghl_contact_id":"jLJHVWaYiRePjlyV4kOk","site_address":"53B Balcombe Way"}','contract');
 r:=public.set_job_party_ids((anna->>'job_contact_id')::uuid,'someOtherGhlId',NULL,'accept','accept','send-quote');
 IF r->>'outcome'<>'party_identity_conflict' OR (SELECT ghl_contact_id FROM public.job_contacts WHERE id=(anna->>'job_contact_id')::uuid)<>'jLJHVWaYiRePjlyV4kOk'
 THEN RAISE EXCEPTION 's-m1 S6 overwrite not refused %',r; END IF;
 -- The same id again is a no-op, not a conflict.
 IF public.set_job_party_ids((anna->>'job_contact_id')::uuid,'jLJHVWaYiRePjlyV4kOk',NULL,'accept','accept','send-quote')->>'outcome'<>'party_ids_unchanged'
 THEN RAISE EXCEPTION 's-m1 S6 same id'; END IF;
 -- S8: no GHL contact (malformed phone); an empty id is filled, with flag off
 -- the reconsideration is recorded as flag_off.
 fiona:=public.upsert_job_party('3450cda7-0000-4000-8000-000000000108','nb-1','{"client_name":"S8 Neighbour Party","client_phone":"+6146672776","client_email":"s8-fiona@example.test"}','contract');
 -- A malformed but non-placeholder phone keeps its key (the linker may
 -- still find it); the party has no GHL contact until linked.
 IF (fiona->'flags')<>'[]'::jsonb OR (SELECT phone_last9 FROM public.job_contacts WHERE id=(fiona->>'job_contact_id')::uuid)<>'146672776'
  OR (SELECT ghl_contact_id FROM public.job_contacts WHERE id=(fiona->>'job_contact_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 's-m1 S8 before link %',fiona; END IF;
 r:=public.set_job_party_ids((fiona->>'job_contact_id')::uuid,'fxS8FionaGhl',NULL,'linker','email','workflow:party_linker');
 IF r->>'outcome'<>'party_ids_set' OR r#>>'{reconsider,outcome}'<>'flag_off' THEN RAISE EXCEPTION 's-m1 S8 link %',r; END IF;
 -- An ambiguous search flags the party and links nothing.
 r:=public.set_job_party_ids((jo->>'job_contact_id')::uuid,NULL,NULL,'linker','ambiguous','workflow:party_linker');
 IF r->>'outcome'<>'party_link_ambiguous' OR NOT (r->'flags') ? 'ghl_contact_ambiguous' THEN RAISE EXCEPTION 's-m1 ambiguous %',r; END IF;
 BEGIN PERFORM public.set_job_party_ids((jo->>'job_contact_id')::uuid,'x',NULL,'linker','ambiguous','contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'party_match_basis_invalid' THEN RAISE; END IF; END;
END $$;
-- With job_parties_v1 on, the writer asks the placement track; until P3 adds
-- the party_linked reason the call is refused, and the writer still succeeds
-- with the refusal code in its receipt.
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('job_parties_v1',true,now());
DO $$
DECLARE p jsonb; r jsonb;
BEGIN
 p:=public.upsert_job_party('1d277f6e-dd11-4e49-b606-a3586d1ed1ea','nb-1781000000000','{"client_name":"S6 Late Party","client_email":"s6-late@example.test"}','contract');
 r:=public.set_job_party_ids((p->>'job_contact_id')::uuid,'fxS6LateGhl',NULL,'linker','email','workflow:party_linker');
 IF r->>'outcome'<>'party_ids_set' OR r#>>'{reconsider,outcome}'<>'failed' OR r#>>'{reconsider,code}'<>'P0001' THEN RAISE EXCEPTION 's-m1 flag-on reconsider %',r; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_contact_id=(p->>'job_contact_id')::uuid AND change='party_ids_set' AND detail#>>'{reconsider,outcome}'='failed')
 THEN RAISE EXCEPTION 's-m1 reconsider outcome not in the receipt'; END IF;
END $$;
ROLLBACK;

-- 8. Party candidacy at a moment (review B3).
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
UPDATE public.jobs SET completed_at='2026-07-30 04:00:00+00',updated_at='2026-08-20 00:00:00+00' WHERE job_number='SWF-26395';
-- S3: the neighbour's fence id is stamped 2 Jun (1780365600000 ms).
SELECT public.upsert_job_party('66279d26-e267-43be-ac73-e06a136f336b','nb-1780365600000','{"client_name":"S3 Neighbour C","ghl_contact_id":"9wd4UDe6f9eW83msKylC"}','contract');
-- Her two invoices, paid.
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,job_id,job_contact_id,invoice_date,fully_paid_on,reference)
SELECT '00000000-0000-0000-0000-000000000001','fx-inv-0891','INV-0891','ACCREC','PAID','66279d26-e267-43be-ac73-e06a136f336b',c.id,'2026-06-20','2026-06-25','SWF-26395-C-DEP50'
FROM public.job_contacts c WHERE c.source_party_key='nb-1780365600000';
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,job_id,job_contact_id,invoice_date,fully_paid_on,reference)
SELECT '00000000-0000-0000-0000-000000000001','fx-inv-1079','INV-1079','ACCREC','PAID','66279d26-e267-43be-ac73-e06a136f336b',c.id,'2026-08-05','2026-08-10','SWF-26395-C-FINBAL'
FROM public.job_contacts c WHERE c.source_party_key='nb-1780365600000';
-- S5: the job is archived (terminal from updated_at 12 Sep); the owner's
-- INV-1551 is unpaid; the neighbour's INV-1552 was paid 18 Sep.
SELECT public.upsert_job_party('1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','primary','{}'::jsonb,'contract');
SELECT public.upsert_job_party('1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','nb-1','{"client_name":"S5 Neighbour Party","client_phone":"0411 000 205"}','contract');
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,job_id,job_contact_id,xero_contact_id,invoice_date,fully_paid_on,reference) VALUES
 ('00000000-0000-0000-0000-000000000001','fx-inv-1551','INV-1551','ACCREC','AUTHORISED','1694c4a9-4641-4e74-ba8b-78b2e54b8d1d',NULL,'59092363-0000-4000-8000-000000000105','2026-09-10',NULL,'SWF-261105-FINBAL50'),
 ('00000000-0000-0000-0000-000000000001','fx-inv-1552','INV-1552','ACCREC','PAID','1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','5e5c0000-0000-4000-8000-00000000005b',NULL,'2026-09-10','2026-09-18','SWF-261105-FINBAL50'),
 ('00000000-0000-0000-0000-000000000001','fx-inv-void','INV-VOID','ACCREC','VOIDED','1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','5e5c0000-0000-4000-8000-00000000005b',NULL,'2026-12-01',NULL,'SWF-261105-VOID');
DO $$
DECLARE c text; j uuid;
BEGIN
 -- S3, 3 Jul: her party existed from 2 Jun and the job was live: clause (a) (review M10).
 SELECT clause,job_id INTO c,j FROM public.context_contact_parties_at('9wd4UDe6f9eW83msKylC','2026-07-03 05:00:00+00');
 IF c IS DISTINCT FROM 'a' OR j<>'66279d26-e267-43be-ac73-e06a136f336b' THEN RAISE EXCEPTION 's-m1 S3 3 Jul %',c; END IF;
 -- 30 Jul after completion and 3 Aug: finished, inside 60 days: clause (b).
 SELECT clause INTO c FROM public.context_contact_parties_at('9wd4UDe6f9eW83msKylC','2026-07-30 08:00:00+00');
 IF c IS DISTINCT FROM 'b_window' THEN RAISE EXCEPTION 's-m1 S3 30 Jul %',c; END IF;
 SELECT clause INTO c FROM public.context_contact_parties_at('9wd4UDe6f9eW83msKylC','2026-08-03 02:00:00+00');
 IF c IS DISTINCT FROM 'b_window' THEN RAISE EXCEPTION 's-m1 S3 3 Aug %',c; END IF;
 -- 60 days after her last invoice (5 Aug), nothing owed: no longer a candidate.
 IF EXISTS (SELECT 1 FROM public.context_contact_parties_at('9wd4UDe6f9eW83msKylC','2026-10-20 02:00:00+00')) THEN RAISE EXCEPTION 's-m1 S3 window never closes'; END IF;
 -- Before her party existed (more than 30 days before 2 Jun): not a candidate.
 IF EXISTS (SELECT 1 FROM public.context_contact_parties_at('9wd4UDe6f9eW83msKylC','2026-04-25 02:00:00+00')) THEN RAISE EXCEPTION 's-m1 S3 before the party'; END IF;
 -- Her own job SWF-261209 is not a party job: never returned by this helper.
 IF EXISTS (SELECT 1 FROM public.context_contact_parties_at('9wd4UDe6f9eW83msKylC','2026-08-03 02:00:00+00') WHERE job_id='d633c895-7e10-4198-8e42-a3aeae475698')
 THEN RAISE EXCEPTION 's-m1 S3 own job returned'; END IF;
 -- S5 owner, 20 Dec: archived long ago but INV-1551 still unpaid (matched by
 -- her Xero contact): clause (b) unpaid.
 SELECT clause INTO c FROM public.context_contact_parties_at('rWobjdrej9tYNYq24B0Q','2026-12-20 02:00:00+00');
 IF c IS DISTINCT FROM 'b_unpaid' THEN RAISE EXCEPTION 's-m1 S5 owner unpaid %',c; END IF;
 -- S5 neighbour, paid 18 Sep: inside 60 days of the later of finishing and
 -- his last invoice on 10 Nov, gone on 20 Dec (the voided December invoice
 -- keeps nothing open).
 SELECT clause INTO c FROM public.context_contact_parties_at('Uki8zBjuAJSP5Em19ZsK','2026-11-10 02:00:00+00');
 IF c IS DISTINCT FROM 'b_window' THEN RAISE EXCEPTION 's-m1 S5 neighbour window %',c; END IF;
 IF EXISTS (SELECT 1 FROM public.context_contact_parties_at('Uki8zBjuAJSP5Em19ZsK','2026-12-20 02:00:00+00')) THEN RAISE EXCEPTION 's-m1 S5 neighbour after window'; END IF;
 -- A removed party stops being a candidate from its removal.
 PERFORM public.upsert_job_party('1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','nb-1','{"status":"removed"}','contract');
 IF EXISTS (SELECT 1 FROM public.context_contact_parties_at('Uki8zBjuAJSP5Em19ZsK',now()+interval '1 minute')) THEN RAISE EXCEPTION 's-m1 removed party still a candidate'; END IF;
 -- A holding job never is.
 UPDATE public.jobs SET metadata='{"do_not_schedule":true}' WHERE id='1694c4a9-4641-4e74-ba8b-78b2e54b8d1d';
 IF EXISTS (SELECT 1 FROM public.context_contact_parties_at('rWobjdrej9tYNYq24B0Q','2026-12-20 02:00:00+00')) THEN RAISE EXCEPTION 's-m1 holding job'; END IF;
 IF EXISTS (SELECT 1 FROM public.context_contact_parties_at(NULL,now())) OR EXISTS (SELECT 1 FROM public.context_contact_parties_at('  ',now()))
 THEN RAISE EXCEPTION 's-m1 null contact'; END IF;
END $$;
ROLLBACK;

-- 9. Each message's party (S2 SWF-26904; F1 shared identity; P3, P4, P7).
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
SELECT public.upsert_job_party('ad84e193-83b8-446b-bafd-d720b9d9d204','primary','{"site_address":"378/2 The Strand"}','contract');
SELECT public.upsert_job_party('ad84e193-83b8-446b-bafd-d720b9d9d204','nb-1','{"client_name":"Nell Harper","ghl_contact_id":"Hs5b2slTC4DFGyLFRVkb","site_address":"376 The Strand"}','contract');
SELECT public.upsert_job_party('ad84e193-83b8-446b-bafd-d720b9d9d204','nb-1700000000000','{"client_name":"Otto Quill","ghl_contact_id":"6ql82fPRFToIAVrlAm0r","site_address":"1/378 The Strand"}','contract');
-- F1: two parties sharing one GHL contact on the same site (P7).
SELECT public.upsert_job_party('ad84e193-83b8-446b-bafd-d720b9d9d204','staff:22222222-2222-4222-8222-222222222222','{"client_name":"Shared Contact One","ghl_contact_id":"fxSharedGhl","party_role":"agent"}','contract');
SELECT public.upsert_job_party('ad84e193-83b8-446b-bafd-d720b9d9d204','staff:33333333-3333-4333-8333-333333333333','{"client_name":"Shared Contact Two","ghl_contact_id":"fxSharedGhl","party_role":"tenant"}','contract');
INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,contact_id,payload) VALUES
 ('5e2e0000-0000-4000-8000-000000000001','client.sms_in','ghl-webhook-receiver','sms','inbound','2026-09-11 01:00:00+00','2026-09-11 01:00:00+00','Hs5b2slTC4DFGyLFRVkb','{"body":"We have a joint lawn with Otto and myself on that side."}'),
 ('5e2e0000-0000-4000-8000-000000000002','client.sms_in','ghl-webhook-receiver','sms','inbound','2026-09-11 02:00:00+00','2026-09-11 02:00:00+00','Hs5b2slTC4DFGyLFRVkb','{"body":"Otto Quill said he will pay his share."}'),
 ('5e2e0000-0000-4000-8000-000000000003','client.sms_in','ghl-webhook-receiver','sms','inbound','2026-09-11 03:00:00+00','2026-09-11 03:00:00+00','Hs5b2slTC4DFGyLFRVkb','{"body":"Otto from 1/378 is fine with it."}'),
 ('5e2e0000-0000-4000-8000-000000000004','client.sms_in','ghl-webhook-receiver','sms','inbound','2026-09-11 04:00:00+00','2026-09-11 04:00:00+00','TmrZbGpqRWqpqtHyCtAv','{"body":"The post near the corner, that would be 378a."}'),
 ('5e2e0000-0000-4000-8000-000000000005','client.sms_in','ghl-webhook-receiver','sms','inbound','2026-09-11 05:00:00+00','2026-09-11 05:00:00+00','fxSharedGhl','{"body":"Checking in about the fence, paid $500 on 21/9."}'),
 -- System rows on the same job are not messages.
 ('5e2e0000-0000-4000-8000-000000000006','job.status_changed','ops-api','status','system','2026-09-12 01:00:00+00','2026-09-12 01:00:00+00',NULL,'{"changes":{"status":{"to":"invoiced"}}}'),
 ('5e2e0000-0000-4000-8000-000000000007','quote.sent','send-quote',NULL,NULL,'2026-09-12 02:00:00+00','2026-09-12 02:00:00+00','Hs5b2slTC4DFGyLFRVkb','{"document_id":"fx"}');
UPDATE public.business_events SET job_id='ad84e193-83b8-446b-bafd-d720b9d9d204' WHERE id::text LIKE '5e2e0000-%';
DO $$
DECLARE r record;
BEGIN
 SELECT * INTO r FROM public.context_job_event_parties('ad84e193-83b8-446b-bafd-d720b9d9d204') WHERE event_id='5e2e0000-0000-4000-8000-000000000001';
 IF r.party_match<>'party' OR r.party_label<>'B' OR r.party_role<>'neighbour' THEN RAISE EXCEPTION 's-m1 S2 sender %',to_jsonb(r); END IF;
 -- "Otto" alone is only a possible mention (review S9).
 IF r.mentions<>jsonb_build_array(jsonb_build_object('job_contact_id',(SELECT id FROM public.job_contacts WHERE client_name='Otto Quill')::text,'label','C','certainty','mentions_possible'))
 THEN RAISE EXCEPTION 's-m1 S2 first name alone %',r.mentions; END IF;
 SELECT * INTO r FROM public.context_job_event_parties('ad84e193-83b8-446b-bafd-d720b9d9d204') WHERE event_id='5e2e0000-0000-4000-8000-000000000002';
 IF r.mentions->0->>'certainty'<>'mentions' THEN RAISE EXCEPTION 's-m1 S2 full name %',r.mentions; END IF;
 -- First name plus his own house designation, unique on the site.
 SELECT * INTO r FROM public.context_job_event_parties('ad84e193-83b8-446b-bafd-d720b9d9d204') WHERE event_id='5e2e0000-0000-4000-8000-000000000003';
 IF r.mentions->0->>'certainty'<>'mentions' THEN RAISE EXCEPTION 's-m1 S2 first name plus unique token %',r.mentions; END IF;
 -- P4: "378a" matches no party exactly; shown, never guessed. Unknown sender: none.
 SELECT * INTO r FROM public.context_job_event_parties('ad84e193-83b8-446b-bafd-d720b9d9d204') WHERE event_id='5e2e0000-0000-4000-8000-000000000004';
 IF r.party_match<>'none' OR r.mentions_unmatched<>ARRAY['378a'] OR r.mentions<>'[]'::jsonb THEN RAISE EXCEPTION 's-m1 S2 unmatched %',to_jsonb(r); END IF;
 -- P7: a contact on two parties of one site is ambiguous, not a pick; money
 -- and dates are never read as house numbers.
 SELECT * INTO r FROM public.context_job_event_parties('ad84e193-83b8-446b-bafd-d720b9d9d204') WHERE event_id='5e2e0000-0000-4000-8000-000000000005';
 IF r.party_match<>'ambiguous' OR cardinality(r.ambiguous_job_contact_ids)<>2 OR r.job_contact_id IS NOT NULL OR r.mentions_unmatched<>'{}'
 THEN RAISE EXCEPTION 's-m1 shared identity %',to_jsonb(r); END IF;
 IF (SELECT count(*) FROM public.context_job_event_parties('ad84e193-83b8-446b-bafd-d720b9d9d204'))<>5 THEN RAISE EXCEPTION 's-m1 row count'; END IF;
 IF EXISTS (SELECT 1 FROM public.context_job_event_parties('ad84e193-83b8-446b-bafd-d720b9d9d204')
   WHERE event_id IN ('5e2e0000-0000-4000-8000-000000000006','5e2e0000-0000-4000-8000-000000000007'))
 THEN RAISE EXCEPTION 's-m1 status change or quote.sent returned as a message'; END IF;
END $$;
ROLLBACK;

-- 10. Site proposals and decisions (S1, S8, S12).
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at FROM sm1_jobs;
-- INV-0665 on SWF-26075 names both jobs.
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,job_id,invoice_date,reference,line_items) VALUES
 ('00000000-0000-0000-0000-000000000001','fx-inv-0665','INV-0665','ACCREC','PAID','68e2e301-aa3a-4d5d-9924-d907643e1cba','2026-07-01','SWF-26075 & SWF-26078',
  '[{"Description":"SWF-26075 side fence","LineAmount":2080.83},{"Description":"SWF-26078 rear fence","LineAmount":2366.25}]');
DO $$
DECLARE r record; n int; out jsonb;
BEGIN
 -- S1: same address (Rd and Road are one key) and named on the invoice;
 -- the same street in another suburb is not proposed.
 SELECT * INTO r FROM public.context_site_candidates('68e2e301-aa3a-4d5d-9924-d907643e1cba') WHERE job_id='8ad5bc77-50e5-48b6-bff7-34a7234b977d';
 IF r.basis<>ARRAY['invoice_names_job','same_address'] OR r.suggested_kind<>'split_party' OR r.link_status IS NOT NULL THEN RAISE EXCEPTION 's-m1 S1 %',to_jsonb(r); END IF;
 IF EXISTS (SELECT 1 FROM public.context_site_candidates('68e2e301-aa3a-4d5d-9924-d907643e1cba') WHERE job_number='SWF-FX170') THEN RAISE EXCEPTION 's-m1 other suburb proposed'; END IF;
 -- S8: two jobs at one address with the same customer: a stage; a job two
 -- doors down with the same contact is proposed as nearby.
 SELECT * INTO r FROM public.context_site_candidates('3450cda7-0000-4000-8000-000000000108') WHERE job_number='SWF-261246';
 IF r.basis<>ARRAY['same_address'] OR r.suggested_kind<>'stage' THEN RAISE EXCEPTION 's-m1 S8 %',to_jsonb(r); END IF;
 SELECT * INTO r FROM public.context_site_candidates('3450cda7-0000-4000-8000-000000000108') WHERE job_number='SWF-FX108';
 IF r.basis<>ARRAY['shared_contact_nearby'] THEN RAISE EXCEPTION 's-m1 S8 nearby %',to_jsonb(r); END IF;
 -- S12: six jobs at 4 Hodge Ct: the other five, whatever the address wording.
 SELECT count(*) INTO n FROM public.context_site_candidates('5c120000-0000-4000-8000-000000026025') WHERE 'same_address'=ANY(basis);
 IF n<>5 THEN RAISE EXCEPTION 's-m1 S12 group of six: % others',n; END IF;
 -- Decisions, each with a receipt.
 out:=public.link_site_jobs('8ad5bc77-50e5-48b6-bff7-34a7234b977d','68e2e301-aa3a-4d5d-9924-d907643e1cba','split_party','propose','user:contract','{"basis":["invoice_names_job"]}');
 IF out->>'status'<>'proposed' THEN RAISE EXCEPTION 's-m1 propose %',out; END IF;
 IF (SELECT link_status FROM public.context_site_candidates('68e2e301-aa3a-4d5d-9924-d907643e1cba') WHERE job_id='8ad5bc77-50e5-48b6-bff7-34a7234b977d')<>'proposed'
 THEN RAISE EXCEPTION 's-m1 candidate shows no link status'; END IF;
 out:=public.link_site_jobs('8ad5bc77-50e5-48b6-bff7-34a7234b977d','68e2e301-aa3a-4d5d-9924-d907643e1cba','split_party','confirm','user:contract');
 IF out->>'status'<>'confirmed' OR out->>'decided_by'<>'user:contract' THEN RAISE EXCEPTION 's-m1 confirm %',out; END IF;
 BEGIN PERFORM public.link_site_jobs('8ad5bc77-50e5-48b6-bff7-34a7234b977d','68e2e301-aa3a-4d5d-9924-d907643e1cba','split_party','propose','user:contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'site_link_already_confirmed' THEN RAISE; END IF; END;
 -- No chains: the lead cannot be linked elsewhere; a linked job cannot lead.
 BEGIN PERFORM public.link_site_jobs('68e2e301-aa3a-4d5d-9924-d907643e1cba','5f000000-0000-4000-8000-000000000170','split_party','propose','user:contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job_is_site_lead' THEN RAISE; END IF; END;
 BEGIN PERFORM public.link_site_jobs('5f000000-0000-4000-8000-000000000170','8ad5bc77-50e5-48b6-bff7-34a7234b977d','split_party','propose','user:contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'site_lead_is_linked' THEN RAISE; END IF; END;
 BEGIN PERFORM public.link_site_jobs('8ad5bc77-50e5-48b6-bff7-34a7234b977d','8ad5bc77-50e5-48b6-bff7-34a7234b977d','stage','propose','user:contract'); RAISE EXCEPTION 'no refusal';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'site_link_self' THEN RAISE; END IF; END;
 out:=public.link_site_jobs('8ad5bc77-50e5-48b6-bff7-34a7234b977d','68e2e301-aa3a-4d5d-9924-d907643e1cba','split_party','reject','user:contract');
 IF out->>'status'<>'rejected' THEN RAISE EXCEPTION 's-m1 reject %',out; END IF;
 IF (SELECT count(*) FROM public.job_party_events WHERE method='link_site_jobs' AND job_id='8ad5bc77-50e5-48b6-bff7-34a7234b977d')<>3 THEN RAISE EXCEPTION 's-m1 link receipts'; END IF;
 -- Nothing merged, moved or deleted.
 IF (SELECT count(*) FROM public.jobs WHERE id IN ('8ad5bc77-50e5-48b6-bff7-34a7234b977d','68e2e301-aa3a-4d5d-9924-d907643e1cba'))<>2 THEN RAISE EXCEPTION 's-m1 jobs moved'; END IF;
END $$;
ROLLBACK;

-- 11. The parties block in the heartbeat composer.
BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,ghl_contact_id,xero_contact_id,site_address,site_suburb,archived,created_at,pricing_json)
SELECT id,'00000000-0000-0000-0000-000000000001',status,'fencing',job_number,client_name,client_phone,ghl,xero,site_address,site_suburb,status='archived',created_at,
 CASE WHEN job_number='SWF-261335' THEN '{"neighbour_splits":[{"name":"S9 Neighbour Party"}]}'::jsonb END FROM sm1_jobs;
DO $$
DECLARE jo jsonb; s jsonb; c jsonb;
BEGIN
 s:=public.context_parties_status();
 -- S9's pricing lists a neighbour but no party row exists yet (review S3).
 IF (s#>>'{parties,pricing_neighbours_without_party_rows}')::int<1 THEN RAISE EXCEPTION 's-m1 pricing without parties %',s; END IF;
 jo:=public.upsert_job_party('d633c895-7e10-4198-8e42-a3aeae475698','nb-1','{"client_name":"S4 Neighbour Party","client_email":"s4-jo@example.test"}','contract');
 PERFORM public.set_job_party_ids((jo->>'job_contact_id')::uuid,NULL,NULL,'linker','phone_differs','workflow:party_linker');
 PERFORM public.link_site_jobs('30f413aa-0000-4000-8000-000000000108','3450cda7-0000-4000-8000-000000000108','stage','propose','user:contract');
 s:=public.context_parties_status();
 IF (s#>>'{parties,identity_conflict}')::int<1 OR (s#>>'{site_links,proposed}')::int<>1 OR (s#>>'{receipts_7d,party_identity_conflict}')::int<>1
  OR s#>>'{flag,enabled}'<>'false' OR (s#>>'{linker,built}')::boolean OR jsonb_array_length(s->'alarms')<>0 OR (s#>>'{parties,duplicate_letter_groups}')::int<>0
 THEN RAISE EXCEPTION 's-m1 status %',s; END IF;
 -- Once the linker has run, a stale sweep in business hours raises the alarm.
 PERFORM public.record_capture_run(jsonb_build_object('source','party_linker','status','succeeded'));
 UPDATE public.context_capture_runs SET finished_at=now()-interval '3 days',started_at=now()-interval '3 days' WHERE source='party_linker';
 s:=public.context_parties_status();
 IF NOT (s#>>'{linker,built}')::boolean THEN RAISE EXCEPTION 's-m1 linker run not seen'; END IF;
 IF (public.context_in_business_hours(now()) AND public.automation_lane_enabled('capture')) <> (s->'alarms' @> '[{"key":"party_linker_stale"}]')
 THEN RAISE EXCEPTION 's-m1 party_linker_stale alarm %',s->'alarms'; END IF;
 -- The composer carries the block and its alarms.
 c:=public.context_pipeline_status();
 IF jsonb_typeof(c->'parties')<>'object' OR c#>'{parties,parties}' IS NULL THEN RAISE EXCEPTION 's-m1 composer %',c->'parties'; END IF;
 IF (s->'alarms' @> '[{"key":"party_linker_stale"}]') AND NOT c->'alarms' @> '[{"block":"parties","key":"party_linker_stale"}]' THEN RAISE EXCEPTION 's-m1 alarm not composed'; END IF;
 -- Counts only: no name, phone or email in the block.
 IF s::text ~* 'S4 |example\.test|0411' THEN RAISE EXCEPTION 's-m1 status carries personal data'; END IF;
END $$;
ROLLBACK;

-- 12. Re-apply: the guard accepts its own result and a second run changes
-- nothing (same bodies, same rows, no duplicate objects).
BEGIN;
CREATE TEMP TABLE sm1_before AS SELECT p.oid::regprocedure::text AS sig,md5(p.prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND (p.proname LIKE 'job_party%' OR p.proname IN ('upsert_job_party','set_job_party_ids','job_contacts_owner_mirror',
  'context_contact_parties_at','context_job_event_parties','context_site_address','context_site_candidates','link_site_jobs','context_parties_status'));
\ir ../../../migrations/20260925040000_job_parties_foundation.sql
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM sm1_before b WHERE b.m IS DISTINCT FROM (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(b.sig)))
  OR (SELECT count(*) FROM sm1_before)<>14 THEN RAISE EXCEPTION 's-m1 re-apply moved a body'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND tgname='job_contacts_owner_mirror')<>1 THEN RAISE EXCEPTION 's-m1 re-apply trigger'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_party_events) OR has_table_privilege('anon','public.job_contacts','TRUNCATE') THEN RAISE EXCEPTION 's-m1 re-apply state'; END IF;
END $$;
ROLLBACK;
