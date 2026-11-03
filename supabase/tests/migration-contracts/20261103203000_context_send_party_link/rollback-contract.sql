-- After the down: both timelines are TP-04's bodies and comments again, the
-- trigger, its function and the linker are gone, and the empty links table
-- is dropped.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz)'::regprocedure)<>'88d0aa3f8bdbb2800d66954b5655f0dd'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure)<>'be5e8d7df251fb3baf2d1a47641d93eb'
 THEN RAISE EXCEPTION 'c14 rollback: a timeline is not the pre-image'; END IF;
 IF coalesce(obj_description('public.context_contact_job_timeline(text,timestamptz)'::regprocedure,'pg_proc'),'')
   <>'Every job of a GHL contact (its own jobs and phone- or email-matched contactless jobs) with creation, terminal time and its source, lead-window start and whether it is a candidate at p_at. Private; read context_contact_jobs_at.'
  OR coalesce(obj_description('public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure,'pg_proc'),'') NOT LIKE 'P4:%'
  OR coalesce(obj_description('public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure,'pg_proc'),'') LIKE '%C14%'
 THEN RAISE EXCEPTION 'c14 rollback: a timeline comment is not the pre-image'; END IF;
 IF to_regprocedure('public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)') IS NOT NULL
  OR to_regprocedure('public.context_job_event_send_link()') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='context_job_event_send_link')
  OR to_regclass('public.job_contact_send_links') IS NOT NULL
 THEN RAISE EXCEPTION 'c14 rollback: the linker, its trigger or the empty links table is still there'; END IF;
END $$;
