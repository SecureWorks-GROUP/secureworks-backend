-- After the down migration: the F1 stub, no trigger, no new function, no new
-- table or column (they held nothing), and the security fix kept.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_parties_status()'))<>'155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 's-m1 rollback: parties stub not restored'; END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND tgname='job_contacts_owner_mirror') THEN RAISE EXCEPTION 's-m1 rollback: trigger kept'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('upsert_job_party',
   'set_job_party_ids','job_contacts_owner_mirror','context_contact_parties_at','context_job_event_parties','context_site_address',
   'context_site_candidates','link_site_jobs','job_party_flag_on','job_party_phone_key','job_party_email_key','job_party_receipt','job_party_reconsider'))
 THEN RAISE EXCEPTION 's-m1 rollback: functions kept'; END IF;
 IF to_regclass('public.job_party_events') IS NOT NULL OR to_regclass('public.job_site_links') IS NOT NULL THEN RAISE EXCEPTION 's-m1 rollback: empty tables kept'; END IF;
 IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.job_contacts'::regclass AND NOT attisdropped
   AND attname IN ('party_role','source_party_key','effective_from','removed_at','last_link_checked_at','party_flags','phone_last9'))
 THEN RAISE EXCEPTION 's-m1 rollback: empty columns kept'; END IF;
 IF has_table_privilege('anon','public.job_contacts','TRUNCATE') OR has_table_privilege('authenticated','public.job_contacts','SELECT')
 THEN RAISE EXCEPTION 's-m1 rollback reopened job_contacts to the public key'; END IF;
 IF has_table_privilege('anon','public.run_summary','SELECT') OR has_table_privilege('authenticated','public.run_summary','SELECT')
 THEN RAISE EXCEPTION 's-m1 rollback reopened run_summary to the public key'; END IF;
 IF (SELECT count(*) FROM public.job_contacts WHERE job_id='1694c4a9-4641-4e74-ba8b-78b2e54b8d1d')<>2 THEN RAISE EXCEPTION 's-m1 rollback lost rows'; END IF;
 -- The composer still reads the null block.
 IF public.context_pipeline_status()->'parties'<>'null'::jsonb THEN RAISE EXCEPTION 's-m1 rollback composer'; END IF;
END $$;
