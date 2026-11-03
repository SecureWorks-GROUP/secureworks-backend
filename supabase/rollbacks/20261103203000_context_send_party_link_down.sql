-- Down for 20261103203000 (C14, a second person we text from a job): restore
-- both context_contact_job_timeline bodies and comments exactly as they were
-- before it (20261029190000), drop the job_events trigger, its function and
-- the linker. job_contact_send_links is dropped only while it holds no row;
-- with rows it is kept (the restored timeline does not read it) and a notice
-- says how many, so no link a staff send made is lost. A party contact id the
-- linker set through set_job_party_ids stays: it is ordinary party data with
-- its own job_party_events receipt (method staff_send). Rows placed while the
-- rule was live keep their placement.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Refuse to overwrite a later change: each body must be this migration's (or
-- already the old one, for a repeated rollback).
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_contact_job_timeline(text,timestamptz)',ARRAY['e14de55f5ca63ec5a81a7e3a420a0a15','88d0aa3f8bdbb2800d66954b5655f0dd']),
  ('public.context_contact_job_timeline(text,timestamptz,text,text)',ARRAY['454ced32a1213e2c28d7d41d37263df5','be5e8d7df251fb3baf2d1a47641d93eb'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)','f4601e213838c0dd0be1f99d8c07dec2'),
  ('public.context_job_event_send_link()','29406e3aa57f2d8bf6d412e1db448d88')
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NOT NULL AND live<>x.accepted THEN problems:=problems||format('%s md5 %s',x.sig,live); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_send_party_link_rollback_mismatch: %; a later change must be rolled back first',array_to_string(problems,'; ');
 END IF;
END $guard$;

DROP TRIGGER IF EXISTS context_job_event_send_link ON public.job_events;
DROP FUNCTION IF EXISTS public.context_job_event_send_link();
DROP FUNCTION IF EXISTS public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text);

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
   AND EXISTS (SELECT 1 FROM keys WHERE keys.phone_key IS NOT NULL OR keys.email_key IS NOT NULL)
   AND ((nullif(j.client_phone,'') IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9) IN (SELECT keys.phone_key FROM keys WHERE keys.phone_key IS NOT NULL))
    OR (nullif(j.client_email,'') IS NOT NULL
     AND lower(btrim(j.client_email)) IN (SELECT keys.email_key FROM keys WHERE keys.email_key IS NOT NULL)))
 ), members AS (
  SELECT o.id, 'contact'::text AS basis FROM own o
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
 'Every job of a GHL contact (its own jobs and phone- or email-matched contactless jobs) with creation, terminal time and its source, lead-window start and whether it is a candidate at p_at. Private; read context_contact_jobs_at.';

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
   AND EXISTS (SELECT 1 FROM keys WHERE keys.phone_key IS NOT NULL OR keys.email_key IS NOT NULL)
   AND ((nullif(j.client_phone,'') IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9) IN (SELECT keys.phone_key FROM keys WHERE keys.phone_key IS NOT NULL))
    OR (nullif(j.client_email,'') IS NOT NULL
     AND lower(btrim(j.client_email)) IN (SELECT keys.email_key FROM keys WHERE keys.email_key IS NOT NULL)))
 ), other AS (
  SELECT j.id FROM public.jobs j
  WHERE nullif(btrim(j.ghl_contact_id),'') IS NOT NULL AND j.ghl_contact_id IS DISTINCT FROM p_contact_id
   AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=j.id)
   AND ((public.context_phone_key(p_phone_key) IS NOT NULL AND j.client_phone IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9)=public.context_phone_key(p_phone_key))
    OR (public.context_email_key(p_email_key) IS NOT NULL AND j.client_email IS NOT NULL
     AND lower(btrim(j.client_email))=public.context_email_key(p_email_key)))
 ), members AS (
  SELECT o.id, 'contact'::text AS basis FROM own o
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
 'P4: P1a''s job timeline for a contact, plus contactless and other-contact jobs whose client phone or email is the message''s own key (works with a null contact), and whether a finished job had an ACCREC invoice unpaid at p_at. Private; read context_contact_jobs_at.';

DO $links$
DECLARE n bigint;
BEGIN
 IF to_regclass('public.job_contact_send_links') IS NULL THEN RETURN; END IF;
 EXECUTE 'SELECT count(*) FROM public.job_contact_send_links' INTO n;
 IF n=0 THEN
  EXECUTE 'DROP TABLE public.job_contact_send_links';
 ELSE
  RAISE NOTICE 'job_contact_send_links kept: % row(s); the restored timeline does not read it',n;
 END IF;
END $links$;
