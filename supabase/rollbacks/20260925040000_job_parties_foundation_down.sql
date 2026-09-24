-- Rollback for 20260925040000_job_parties_foundation (sites S-M1).
--
-- Restores the F1 stub of context_parties_status() byte for byte (md5
-- checked), drops the owner-mirror trigger and every function the migration
-- added. The two new tables and the new job_contacts columns are dropped only
-- while they hold nothing a later slice wrote (no receipt, no site link, no
-- party key, role, start, removal time, link check or flag); otherwise they are
-- kept and a notice says so, because dropping them would destroy records.
--
-- Deliberately kept: RLS and the revokes on job_contacts (reopening the
-- neighbours' names and phones to the public key is not a rollback; the
-- TRUNCATE hole stays closed), the same revoke and security_invoker on view
-- run_summary (it reads those names), and the unique (job_id, contact_label) index
-- (the letters were unique before it, every legacy writer finds a party by
-- its letter, and dropping it could only let a duplicate letter in).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP TRIGGER IF EXISTS job_contacts_owner_mirror ON public.jobs;

CREATE OR REPLACE FUNCTION public.context_parties_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_parties_status() IS
 'F1 stub. Status block parties, owned by sites slice S-M1, which replaces this body. Null means not built yet.';
REVOKE ALL ON FUNCTION public.context_parties_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_parties_status() TO service_role;

DROP FUNCTION IF EXISTS public.link_site_jobs(uuid,uuid,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.context_site_candidates(uuid);
DROP FUNCTION IF EXISTS public.context_site_address(text);
DROP FUNCTION IF EXISTS public.context_job_event_parties(uuid);
DROP FUNCTION IF EXISTS public.context_contact_parties_at(text,timestamptz);
DROP FUNCTION IF EXISTS public.job_contacts_owner_mirror();
DROP FUNCTION IF EXISTS public.set_job_party_ids(uuid,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.upsert_job_party(uuid,text,jsonb,text,uuid);
DROP FUNCTION IF EXISTS public.job_party_reconsider(public.job_contacts,text);
DROP FUNCTION IF EXISTS public.job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb);
DROP FUNCTION IF EXISTS public.job_party_email_key(text);
DROP FUNCTION IF EXISTS public.job_party_phone_key(text);
DROP FUNCTION IF EXISTS public.job_party_flag_on();

DO $down$
BEGIN
 IF to_regclass('public.job_party_events') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM public.job_party_events) THEN RAISE NOTICE 'job_party_events holds receipts; kept';
  ELSE DROP TABLE public.job_party_events; END IF;
 END IF;
 IF to_regclass('public.job_site_links') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM public.job_site_links) THEN RAISE NOTICE 'job_site_links holds decisions; kept';
  ELSE DROP TABLE public.job_site_links; END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM public.job_contacts WHERE source_party_key IS NOT NULL OR party_role IS NOT NULL OR effective_from IS NOT NULL
   OR removed_at IS NOT NULL OR last_link_checked_at IS NOT NULL OR party_flags<>'{}') THEN
  RAISE NOTICE 'job_contacts party columns hold values; kept';
 ELSE
  ALTER TABLE public.job_contacts DROP CONSTRAINT IF EXISTS job_contacts_party_role_check,
   DROP CONSTRAINT IF EXISTS job_contacts_source_party_key_check, DROP CONSTRAINT IF EXISTS job_contacts_party_flags_check,
   DROP CONSTRAINT IF EXISTS job_contacts_removed_at_check;
  DROP INDEX IF EXISTS public.job_contacts_job_source_party_key;
  DROP INDEX IF EXISTS public.job_contacts_ghl_contact;
  ALTER TABLE public.job_contacts DROP COLUMN IF EXISTS phone_last9, DROP COLUMN IF EXISTS party_flags,
   DROP COLUMN IF EXISTS last_link_checked_at, DROP COLUMN IF EXISTS removed_at, DROP COLUMN IF EXISTS effective_from,
   DROP COLUMN IF EXISTS source_party_key, DROP COLUMN IF EXISTS party_role;
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_parties_status()'))<>'155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'job_parties rollback: context_parties_status() is not the F1 stub'; END IF;
END $down$;
