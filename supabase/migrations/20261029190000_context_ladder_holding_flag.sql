-- Ladder holding flag (TP-04, 29 Oct 2026): the message placement ladder reads
-- a holding job the way Job Profit does.
--
-- Why: the ladder kept a job off every candidate list with
-- coalesce(metadata->>'do_not_schedule','') NOT IN ('true','1'). That is
-- case sensitive and counts 1 as holding. The one holding rule everywhere
-- else (Job Profit 20261009130000, 20261019120000, 20261020181800; the bill
-- reader 20261028173000) is lower(coalesce(metadata->>'do_not_schedule',''))
-- = 'true'. Under the old ladder rule an ordinary job flagged 1 (or "1") was
-- never a candidate, and a holding job flagged TRUE or True was one. Now a
-- job is holding for the ladder exactly when Job Profit says it is: the word
-- true in any case (JSON true included); 1, "1", false and anything else are
-- not holding.
--
-- Changed: only that predicate, in every placement candidate rule of the live
-- ladder. Each body below is the live body (read with pg_get_functiondef
-- from a database built from the repository, stage 1 included) with
--   coalesce(X.metadata->>'do_not_schedule','') NOT IN ('true','1')
-- replaced by
--   lower(coalesce(X.metadata->>'do_not_schedule','')) <> 'true'
-- and nothing else: comments, grants, owners, signatures, languages and
-- every other character of each body are unchanged. md5(prosrc), old -> new:
--   context_contact_job_timeline(text,timestamptz)            P1a  2bc8e76f14fda242eb6e4d414e93fefa -> 88d0aa3f8bdbb2800d66954b5655f0dd
--   context_contact_job_timeline(text,timestamptz,text,text)  P4   f98da204718a4d5ac6395761a963ced4 -> be5e8d7df251fb3baf2d1a47641d93eb
--   context_ref_jobs(text[])                                  B0   f21ce8cf72292e016daf18d1ee5e9a8c -> 14931b7986111458def3808cf85bbb57
--   context_internal_about_job(business_events)               L1d  aa53618f6c82998a821b8f7439c75e60 -> 550176dbcdf545efa3c4703e160aec96
--   context_event_writer_job(business_events)                 L1e  cd36b092818e7607d114d1b3011b3bfd -> 9d29d9087ebb8765cc994174a960b6d4
--   context_job_real(uuid)                                    S1   9e56ab3916a2522c7fcef3019849e535 -> 7e2fdda96e02d11a45ef8188969c9a5a
--   context_link_ref_jobs(text)                               S1   7c7a9c1330656d02b88caa00a619e5ef -> 840a52b5a5a4805d5524a57f70c63572
--   context_builder_ref_jobs(text,jsonb)                      S1   9ba7c6a2f309830807fae6cfb4451838 -> e4d864aa2b41862ea7fcf8e6b49260e7
--   resolve_context_attribution(business_events,boolean,boolean) S1 58fcf93d4c82604822d4ca4b70cc4680 -> 2ccef791fca954bfe1fcbb4e0de5f8a2
-- (S1 = unplaced stage 1, 20261014170000.) The two-argument timeline is the
-- candidate set of P1b's reconsideration and both Luna overloads on the
-- live (rules-on) path, so it moves with the four-argument one.
--
-- Not changed, on purpose:
--   * context_ladder_p1a, the frozen P1a copy run only while the rules flag
--     is off. A placement slice never edits it (AGENTS.md). It keeps the old
--     predicate in its own two lines; its candidate set comes from the
--     two-argument timeline, which this migration aligns.
--   * Readers that are not placement candidate rules: the census, the
--     status blocks, the placement grades, the payload repair, cadence,
--     history, ledger, story, lead, Xero evidence and the job parties
--     reads. They keep the old spelling until their own owners align them.
--
-- No row moves: a row changes only when it is inserted or re-decided.
-- Rollback: supabase/rollbacks/20261029190000_context_ladder_holding_flag_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard: each body must be the one above (or this migration's,
-- for a repeated apply). Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_contact_job_timeline(text,timestamptz)',ARRAY['2bc8e76f14fda242eb6e4d414e93fefa','88d0aa3f8bdbb2800d66954b5655f0dd']),
  ('public.context_contact_job_timeline(text,timestamptz,text,text)',ARRAY['f98da204718a4d5ac6395761a963ced4','be5e8d7df251fb3baf2d1a47641d93eb']),
  ('public.context_ref_jobs(text[])',ARRAY['f21ce8cf72292e016daf18d1ee5e9a8c','14931b7986111458def3808cf85bbb57']),
  ('public.context_internal_about_job(public.business_events)',ARRAY['aa53618f6c82998a821b8f7439c75e60','550176dbcdf545efa3c4703e160aec96']),
  ('public.context_event_writer_job(public.business_events)',ARRAY['cd36b092818e7607d114d1b3011b3bfd','9d29d9087ebb8765cc994174a960b6d4']),
  ('public.context_job_real(uuid)',ARRAY['9e56ab3916a2522c7fcef3019849e535','7e2fdda96e02d11a45ef8188969c9a5a']),
  ('public.context_link_ref_jobs(text)',ARRAY['7c7a9c1330656d02b88caa00a619e5ef','840a52b5a5a4805d5524a57f70c63572']),
  ('public.context_builder_ref_jobs(text,jsonb)',ARRAY['9ba7c6a2f309830807fae6cfb4451838','e4d864aa2b41862ea7fcf8e6b49260e7']),
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)',ARRAY['58fcf93d4c82604822d4ca4b70cc4680','2ccef791fca954bfe1fcbb4e0de5f8a2'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_ladder_holding_flag_preimage_mismatch: %; build on the live bodies',array_to_string(problems,'; ');
 END IF;
END $guard$;

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

-- public.context_ref_jobs(text[])
CREATE OR REPLACE FUNCTION public.context_ref_jobs(p_tokens text[])
 RETURNS TABLE(token text, job_id uuid, ref_kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT r.token, r.job_id, r.ref_kind FROM (
  SELECT upper(j.job_number) AS token, j.id AS job_id, 'job_number'::text AS ref_kind FROM public.jobs j
  WHERE upper(j.job_number)=ANY(p_tokens) AND length(btrim(j.job_number))>=5
  UNION
  SELECT upper(x.invoice_number), x.job_id, 'accrec_invoice' FROM public.xero_invoices x
  WHERE EXISTS (SELECT 1 FROM unnest(p_tokens) t WHERE t LIKE 'INV-%')
   AND x.job_id IS NOT NULL AND x.invoice_type='ACCREC' AND upper(x.invoice_number) LIKE 'INV-%'
   AND length(btrim(x.invoice_number))>=5 AND upper(x.invoice_number)=ANY(p_tokens)
  UNION
  SELECT upper(po.po_number), po.job_id, 'purchase_order' FROM public.purchase_orders po
  WHERE po.job_id IS NOT NULL AND length(btrim(po.po_number))>=5 AND upper(po.po_number)=ANY(p_tokens)
 ) r JOIN public.jobs rj ON rj.id=r.job_id
 WHERE lower(coalesce(rj.metadata->>'do_not_schedule','')) <> 'true'
$function$;

-- public.context_internal_about_job(public.business_events)
CREATE OR REPLACE FUNCTION public.context_internal_about_job(e business_events)
 RETURNS TABLE(job_id uuid, match_method text)
 LANGUAGE sql
 STABLE
AS $function$
 SELECT a.job_id, a.match_method FROM (
  SELECT j.id AS job_id, 'about_job_id'::text AS match_method, 1 AS pri FROM public.jobs j
  WHERE j.id=CASE WHEN e.metadata->>'about_job_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (e.metadata->>'about_job_id')::uuid END
   AND lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true'
  UNION ALL
  SELECT min(r.job_id::text)::uuid, 'ladder_ref'::text, 2
  FROM public.context_ref_jobs(public.context_job_ref_tokens(public.context_bucket_text(e))) r
  HAVING count(DISTINCT r.job_id)=1
 ) a ORDER BY a.pri LIMIT 1
$function$;

-- public.context_event_writer_job(public.business_events)
CREATE OR REPLACE FUNCTION public.context_event_writer_job(e business_events)
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
 SELECT j.id FROM public.jobs j
 WHERE j.id=e.job_id
  AND coalesce(nullif(btrim(e.match_method),''),'none')='none'
  AND e.metadata->>'written_as'='service_role'
  AND lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true'
$function$;

-- public.context_job_real(uuid)
CREATE OR REPLACE FUNCTION public.context_job_real(p_job_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce((
  SELECT nullif(btrim(coalesce(j.job_number,'')),'') IS NOT NULL
   AND coalesce(j.job_number,'') !~* 'CANARY'
   AND lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true'
  FROM public.jobs j WHERE j.id=p_job_id),false)
$function$;

-- public.context_link_ref_jobs(text)
CREATE OR REPLACE FUNCTION public.context_link_ref_jobs(p_text text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH t AS (
  SELECT DISTINCT lower(m[1]) AS tok
  FROM regexp_matches(coalesce(p_text,''),'token=([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})','g') m
 ), j AS (
  SELECT d.job_id FROM public.job_documents d JOIN t ON d.share_token=t.tok WHERE d.job_id IS NOT NULL
  UNION
  SELECT v.job_id FROM public.job_variations v JOIN t ON v.share_token=t.tok WHERE v.job_id IS NOT NULL
 )
 SELECT coalesce(array_agg(j.job_id ORDER BY j.job_id),'{}'::uuid[])
 FROM j JOIN public.jobs x ON x.id=j.job_id
 WHERE lower(coalesce(x.metadata->>'do_not_schedule','')) <> 'true'
$function$;

-- public.context_builder_ref_jobs(text,jsonb)
CREATE OR REPLACE FUNCTION public.context_builder_ref_jobs(p_text text, p_refs jsonb)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE src text; po_ids uuid[]; claim_ids uuid[]; n_claims int;
 claim_re constant text:='(MLB|AJBR|AJS|AJ|BWCWA|BW|WB|ACG)(?:-?(?:RR|MW))?[- ]?([0-9]{4,})(?![0-9])';
 po_re constant text:='(?<![A-Z])P\.?O\.?[- #:]*([0-9]{5,6})(?![0-9])';
BEGIN
 src:=upper(coalesce(p_text,'')||' '||coalesce((SELECT string_agg(x,' ') FROM jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(p_refs)='array' THEN p_refs ELSE '[]'::jsonb END) x),''));
 -- Cheap exit: most messages name neither.
 IF src !~ ('(?<![A-Z0-9])'||claim_re) AND src !~ po_re THEN RETURN '{}'::uuid[]; END IF;
 WITH c AS (
  SELECT DISTINCT CASE WHEN m[1] IN ('AJ','AJS','AJBR') THEN 'AJ' WHEN m[1] IN ('BW','BWCWA') THEN 'BW' ELSE m[1] END AS scope,
   ltrim(m[2],'0') AS num
  FROM regexp_matches(src,'(?<![A-Z0-9])'||claim_re,'g') m
 ), jc AS (
  SELECT d.job_id, CASE WHEN m[1] IN ('AJ','AJS','AJBR') THEN 'AJ' WHEN m[1] IN ('BW','BWCWA') THEN 'BW' ELSE m[1] END AS scope,
   ltrim(m[2],'0') AS num
  FROM public.makesafe_job_details d
  CROSS JOIN LATERAL regexp_matches(upper(coalesce(d.external_ref,'')),'^\s*'||claim_re) m
  UNION
  -- A repair or fence job on the same claim carries it on the job itself
  -- (mlb_ref, external_ref, builder_claim_ref), so a claim shared by a
  -- make-safe and its repair names both and places neither.
  SELECT j.id, CASE WHEN m[1] IN ('AJ','AJS','AJBR') THEN 'AJ' WHEN m[1] IN ('BW','BWCWA') THEN 'BW' ELSE m[1] END,
   ltrim(m[2],'0')
  FROM public.jobs j
  CROSS JOIN LATERAL unnest(ARRAY[j.metadata->>'mlb_ref',j.metadata->>'external_ref',j.metadata->>'builder_claim_ref']) r
  CROSS JOIN LATERAL regexp_matches(upper(coalesce(r,'')),'^\s*'||claim_re) m
  WHERE j.metadata ?| ARRAY['mlb_ref','external_ref','builder_claim_ref']
 )
 SELECT (SELECT count(*) FROM c), coalesce(array_agg(DISTINCT jc.job_id),'{}'::uuid[])
 INTO n_claims,claim_ids FROM jc JOIN c USING (scope,num);
 WITH p AS (
  SELECT DISTINCT ltrim(m[1],'0') AS num FROM regexp_matches(src,po_re,'g') m
 ), jp AS (
  SELECT d.job_id, ltrim(m[1],'0') AS num FROM public.makesafe_job_details d
  CROSS JOIN LATERAL regexp_matches(upper(coalesce(d.external_ref,'')),po_re,'g') m
  UNION
  SELECT j.id, ltrim(m[1],'0') FROM public.jobs j
  CROSS JOIN LATERAL regexp_matches(upper(coalesce(j.metadata->>'builder_po_number','')),po_re,'g') m
  WHERE j.metadata ? 'builder_po_number'
 )
 SELECT coalesce(array_agg(DISTINCT jp.job_id),'{}'::uuid[]) INTO po_ids FROM jp JOIN p USING (num);
 -- Holding jobs are never a builder's job.
 po_ids:=ARRAY(SELECT x FROM unnest(po_ids) x JOIN public.jobs j ON j.id=x
  WHERE lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true' ORDER BY x);
 claim_ids:=ARRAY(SELECT x FROM unnest(claim_ids) x JOIN public.jobs j ON j.id=x
  WHERE lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true' ORDER BY x);
 -- A purchase order alone carries no builder scope (purchase order numbers
 -- of different builders, and our own, can share digits): only a claim the
 -- text names places. On that claim, one purchase order of the claim picks
 -- its job; purchase order evidence that names several jobs or a job off
 -- the claim conflicts, and nothing places.
 IF n_claims=0 THEN RETURN '{}'::uuid[]; END IF;
 IF cardinality(po_ids)=0 THEN RETURN claim_ids; END IF;
 IF cardinality(po_ids)=1 AND po_ids[1]=ANY(claim_ids) THEN RETURN po_ids; END IF;
 RETURN '{}'::uuid[];
END $function$;

-- public.resolve_context_attribution(public.business_events,boolean,boolean)
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e business_events, p_preview boolean, p_rules_on boolean)
 RETURNS business_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 rules_on boolean; words text; subj text; prior_status text; source_method text; writer text;
 v_at timestamptz; is_ghl boolean; v_mode text; ek text; pk text; contact text; n_contacts int; by_key text;
 toks text[]; ref_ids uuid[]; found_toks text[]; unfound text[]; cand uuid; rule text; custody boolean:=false;
 b public.event_threads; sk text; order_toks text[]; tok text; live_ids uuid[]; retired_ids uuid[];
 ids uuid[]; line text; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; other_ids uuid[]; used_updated_at boolean;
 unpaid_ids uuid[]; window_ids uuid[]; review_ids uuid[]; n int; irole text;
 site_text text; exact_keys text[]; loose_keys text[]; exact_ids uuid[]; loose_ids uuid[]; bindings jsonb:='[]'; conflicts jsonb:='[]';
 owned_keys constant text[]:=ARRAY['payload_job_guess','placement_rule','placement_contactless_job_ids','placement_guard_job_ids','placement_other_contact_job_ids',
  'bucket_reason','ref_not_found','ref_job_ids','identity_conflict','contact_recovered_by','writer_unknown','custody_rescan',
  'placement_site_keys','placement_retired_binding','placement_preview_bindings','supplier_ref_conflicts','aftercare_unpaid_job_ids',
  'audience','recipient_role_source','placement_held_from',
  'placement_ranked_from','placement_ranked_below','party_key_conflict','placement_guarded_from'];
 writer_job uuid;
 held_job uuid; held_conf numeric; held_match_conf numeric; held_ok boolean:=false; all_ids uuid[]; own_live_ids uuid[];
 -- Unplaced stage 1 (20261014170000).
 link_ids uuid[]; link_only boolean:=false; builder_ids uuid[]; party_ids uuid[]; party_conflict boolean; open_all_ids uuid[]; ranked_from text; ranked_set uuid[];
 guard_rule text;
BEGIN
 rules_on:=coalesce(p_rules_on,public.context_unlinked_rules_enabled());
 p_preview:=coalesce(p_preview,false);
 -- L1d (20261005090000): a recipient role the ladder derived (from the words
 -- or the contact) is derived again on every decision; a writer's is kept.
 IF e.metadata->>'recipient_role_source' IN ('wording','contact') THEN e.metadata:=e.metadata-'recipient_role'; END IF;
 IF e.metadata ?| owned_keys THEN e.metadata:=e.metadata-owned_keys; END IF;
 IF NOT rules_on THEN
  e:=public.context_ladder_p1a(e,p_preview);
 ELSE
  <<rules>>
  BEGIN
   prior_status:=e.attribution_status;
   source_method:=e.match_method;
   IF e.job_id IS NOT NULL THEN
    IF e.metadata->'source_job_binding'->>'job_id'=e.job_id::text
     AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
     source_method:=e.metadata->'source_job_binding'->>'match_method';
    ELSE
     -- L1e (20261005170000): a job the service role named without saying how
     -- (no match_method) is kept for a row the reader never reads.
     writer_job:=public.context_event_writer_job(e);
     -- L1f (20261006020000): a job a contact rule or Luna already chose
     -- (single_open, single_line or luna, match_method contact_id) is
     -- remembered for the held placement at step 5.
     IF prior_status IN ('single_open','single_line','luna') AND source_method='contact_id' THEN
      held_job:=e.job_id; held_conf:=e.attribution_confidence; held_match_conf:=e.match_confidence;
     END IF;
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
     e.job_id:=NULL;
     source_method:=NULL;
    END IF;
   ELSIF e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
    SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
    IF FOUND THEN source_method:=e.metadata->'source_job_binding'->>'match_method';
    ELSE e.metadata:=e.metadata-'source_job_binding'; source_method:=NULL;
    END IF;
   ELSE
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
   END IF;
   e.attribution_checked_at:=clock_timestamp();
   words:=public.context_bucket_text(e);
   subj:=coalesce(nullif(btrim(e.payload->>'subject'),''),substring(public.context_event_text(e) from '^Subject: ([^\r\n]*)'));
   e.attribution_status:='admin_bucket'; e.attribution_step:=6;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL;
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.candidate_job_ids:=NULL;
   IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
   IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; EXIT rules; END IF;
   -- 0. Writer check (X16, X36).
   writer:=e.metadata->>'written_as';
   IF writer IS NULL THEN
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('writer_unknown',true);
   ELSIF writer<>'service_role' THEN
    -- L1f (20261006020000): a row the reader never reads (system or audit,
    -- no words, automated) keeps a custody job the service role confirmed
    -- after the insert (source_job_binding.via, written only by a reviewed
    -- service-role repair such as writer_key_relink: the insert trigger strips
    -- any binding a writer sends, and no other role may update the row), as
    -- with the rules off. Every worded row from this writer is still held.
    IF e.job_id IS NOT NULL AND e.metadata->'source_job_binding' ? 'via'
     AND (to_jsonb(e)->>'channel' IN ('system','audit') OR btrim(words)='' OR prior_status='automated'
      OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')) THEN
     e.attribution_status:=CASE WHEN to_jsonb(e)->>'channel' IN ('system','audit') THEN 'automated' WHEN btrim(words)='' THEN 'empty' ELSE 'automated' END;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','confirmed_custody');
     EXIT rules;
    END IF;
    IF e.job_id IS NOT NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
     e.job_id:=NULL;
    END IF;
    e.metadata:=e.metadata||jsonb_build_object('bucket_reason','unverified_writer','placement_rule','unverified_writer');
    EXIT rules;
   END IF;
   -- L1e (20261005170000): a row with no words, a system row and an automated
   -- row keep the job custody proved (as with the rules off) and the job the
   -- service role named; none of them is ever read.
   IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
   IF btrim(words)='' THEN e.attribution_status:='empty';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
   -- L1d (20261005090000): a text our own tool sent to crew or staff is
   -- internal job communication on the job it is about (internal_recipient),
   -- as on the rules-off path.
   IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_rule','internal_recipient','audience','internal','recipient_role_source','writer');
    SELECT a.job_id,a.match_method INTO e.job_id,e.match_method FROM public.context_internal_about_job(e) a;
    IF e.job_id IS NULL THEN e.attribution_status:='automated'; e.match_method:='none'; EXIT rules; END IF;
    e.attribution_status:='direct'; e.attribution_step:=1; e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
    e.match_status:='matched'; e.match_confidence:=1;
    EXIT rules;
   END IF;
   -- Stage 1 (20261014170000): a make-safe reconcile record is a machine
   -- event, never a message: automated at capture, never unplaced.
   IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
    OR e.event_type LIKE 'makesafe.reconcile.%'
   THEN e.attribution_status:='automated';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
   is_ghl:=public.context_event_is_ghl(e);
   v_at:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
   v_mode:=coalesce(e.metadata->>'capture_mode','live');

   -- 2. Identity: computes the customer's keys and recovers exactly one contact.
   SELECT i.email_key,i.phone_key INTO ek,pk FROM public.context_event_identity(e) i;
   contact:=nullif(btrim(e.contact_id),'');
   IF contact IS NULL AND (ek IS NOT NULL OR pk IS NOT NULL) THEN
    SELECT c.contact_id,c.contacts INTO contact,n_contacts FROM public.context_contact_for_key(ek,pk) c;
    IF n_contacts=1 THEN
     by_key:=CASE WHEN ek IS NOT NULL AND (SELECT c.contacts FROM public.context_contact_for_key(ek,NULL) c)=1 THEN 'email' ELSE 'phone' END;
     e.contact_id:=contact;
     e.metadata:=e.metadata||jsonb_build_object('contact_recovered_by',by_key);
    ELSE
     contact:=NULL;
     IF n_contacts>1 THEN e.metadata:=e.metadata||jsonb_build_object('identity_conflict',n_contacts); END IF;
    END IF;
   END IF;

   -- References, used by custody's re-scan and by step 3.
   toks:=public.context_job_ref_tokens(words);
   IF cardinality(toks)>0 THEN
    SELECT array_agg(DISTINCT r.job_id ORDER BY r.job_id),array_agg(DISTINCT replace(r.token,'-','')) INTO ref_ids,found_toks FROM public.context_ref_jobs(toks) r;
    SELECT array_agg(t ORDER BY t) INTO unfound FROM unnest(toks) t
    WHERE t ~ '^SW[A-Z]{0,4}-?[0-9]{4,}' AND NOT (replace(t,'-','')=ANY(coalesce(found_toks,'{}')))
     AND NOT EXISTS (SELECT 1 FROM unnest(toks) t2 WHERE t2<>t AND replace(t2,'-','')=replace(t,'-','') AND replace(t2,'-','')=ANY(coalesce(found_toks,'{}')));
    IF cardinality(unfound)>0 THEN e.metadata:=e.metadata||jsonb_build_object('ref_not_found',to_jsonb(unfound)); END IF;
   END IF;

   -- 1. Custody. monitor-inbox's first-match binding is re-scanned (Review B1).
   IF e.job_id IS NOT NULL THEN
    custody:=true;
    IF source_method='direct_reference' AND e.source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox') AND cardinality(ref_ids)>=1 THEN
     IF cardinality(ref_ids) BETWEEN 2 AND 5 THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',cardinality(ref_ids)),'placement_rule','multi_ref');
      e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
      EXIT rules;
     ELSIF cardinality(ref_ids)>5 THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',cardinality(ref_ids)),
       'placement_rule','multi_ref_many','bucket_reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids));
      e.job_id:=NULL;
      EXIT rules;
     ELSIF ref_ids[1]<>e.job_id THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',1));
      e.job_id:=ref_ids[1]; custody:=false; rule:='direct_ref';
     END IF;
    END IF;
    cand:=e.job_id; e.attribution_status:='direct'; e.attribution_step:=1; rule:=coalesce(rule,'custody');
   END IF;

   -- 1b. The source's own job (20261003100000). A payload.job_id that is the
   -- exact id text of a job that is not holding places the row there (rule
   -- payload_job, a step-1 direct placement), whatever a contact rule would
   -- pick. One that names no such job (missing, holding, another spelling)
   -- rests the row in the bucket with bucket_reason payload_job_unbindable,
   -- never on another job: the revision store refuses a row whose payload
   -- names a job other than the one it sits on.
   -- L1e (20261005170000): a payload job its writer declared a guess is not
   -- the source's own job; the row goes on to the later rules.
   IF cand IS NULL AND public.context_payload_job_is_guess(e) THEN
    e.metadata:=e.metadata||jsonb_build_object('payload_job_guess',true);
   ELSIF cand IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
    IF e.payload#>>'{job_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
     SELECT j.id INTO cand FROM public.jobs j WHERE j.id=(e.payload#>>'{job_id}')::uuid
      AND lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true';
    END IF;
    IF cand IS NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('bucket_reason','payload_job_unbindable','placement_rule','payload_job_unbindable');
     EXIT rules;
    END IF;
    e.attribution_status:='direct'; e.attribution_step:=1; rule:='payload_job';
   END IF;

   -- 3. References.
   IF cand IS NULL THEN
    -- Stage 1 (20261014170000): a quote or variation link token in the words
    -- (send-quote view?token=) names its job exactly, like a job number.
    link_ids:=public.context_link_ref_jobs(words);
    IF cardinality(link_ids)>0 THEN
     link_only:=coalesce(cardinality(ref_ids),0)=0;
     ref_ids:=ARRAY(SELECT DISTINCT x FROM unnest(coalesce(ref_ids,'{}'::uuid[])||link_ids) x ORDER BY x);
    END IF;
    -- L1d (20261005090000): a reference alone never makes an outbound row to
    -- a known contact who is not that job's customer or party a message to
    -- the customer; it stays ON the job as internal communication
    -- (internal_ref), labelled with who it went to, as on the rules-off path.
    IF cardinality(ref_ids)=1 AND NOT public.context_ref_recipient_is_customer(e,ref_ids[1]) THEN
     irole:=public.context_internal_text_role(e);
     e.job_id:=ref_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1;
     e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
     e.match_status:='matched'; e.match_method:='ladder_ref'; e.match_confidence:=1;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','internal_ref','recipient_role',irole,
      'recipient_role_source',CASE WHEN irole='other' THEN 'contact' ELSE 'wording' END,'audience',CASE WHEN irole='other' THEN 'other_party' ELSE 'internal' END);
     EXIT rules;
    ELSIF cardinality(ref_ids)=1 THEN
     cand:=ref_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1; rule:=CASE WHEN link_only THEN 'link_ref' ELSE 'direct_ref' END;
    ELSIF cardinality(ref_ids) BETWEEN 2 AND 5 THEN
     -- A message naming several of our jobs concerns each of them: never
     -- ranked (stage 1 review, 14 Oct 2026), review as before.
     e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref');
     EXIT rules;
    ELSIF cardinality(ref_ids)>5 THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref_many','bucket_reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids));
     EXIT rules;
    END IF;
    -- Stage 1 (20261014170000): with no reference of ours, a builder's claim
    -- or purchase order that names exactly one job places the row there
    -- (builder_ref). Several jobs fall through to the rules below, unchanged.
    IF cand IS NULL AND coalesce(cardinality(ref_ids),0)=0 THEN
     builder_ids:=public.context_builder_ref_jobs(words,e.payload->'builder_refs');
     IF cardinality(builder_ids)=1 THEN
      cand:=builder_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1; rule:='builder_ref';
     END IF;
    END IF;
   END IF;

   -- Candidates of a known contact (with the message's keys), for the thread
   -- check and step 5.
   IF cand IS NULL THEN
    line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
    SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='contactless' AND (t.candidate OR (NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='key_other_contact' AND t.candidate),'{}'),
     coalesce(bool_or(t.terminal_time_source='updated_at' AND (t.candidate OR (NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),false),
     -- Aftercare reads only the customer's own and contactless jobs, never
     -- another contact's job found by a shared phone or email.
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND t.unpaid_at
      AND t.created_at<=v_at),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND NOT t.unpaid_at
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '60 days'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.candidate),'{}'),
     -- Stage 1 (20261014170000): the customer's live jobs now
     -- (context_job_live), for only_open_job.
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND public.context_job_live(t.job_id)),'{}')
    INTO ids,line_ids,guard_ids,contactless_ids,other_ids,used_updated_at,unpaid_ids,window_ids,all_ids,own_live_ids,open_all_ids
    FROM public.context_contact_job_timeline(contact,v_at,pk,ek) t;
    -- L1f (20261006020000): the held job is still the answer while it is one
    -- of the customer's own or contactless jobs and none of those is live at
    -- the message time. Another contact's job that shares the phone or email
    -- is not the customer's job.
    -- L1g (20261006035000): it is also the answer while it is itself one of
    -- those jobs live at the message time, or one the review would offer
    -- (finished in the guard window, unpaid, or in the aftercare window),
    -- whatever other job of the customer is live then. The decision made when
    -- the row was placed stands: a newer job reopens a placed row only through
    -- P1b at its insert (context_reconsider_contact, the one reopen path), and
    -- a job that was a draft then and went live later reopens nothing.
    held_ok:=held_job IS NOT NULL AND held_job=ANY(all_ids)
     AND (cardinality(own_live_ids)=0 OR held_job=ANY(own_live_ids||guard_ids||unpaid_ids||window_ids));
   END IF;

   -- 4. Thread: a live binding; with a known contact, only one of its jobs.
   IF cand IS NULL AND NOT is_ghl AND nullif(e.thread_key,'') IS NOT NULL THEN
    SELECT * INTO b FROM public.event_threads WHERE thread_key=e.thread_key;
    IF FOUND AND b.retired_at IS NOT NULL THEN
     -- L1f (20261006020000): a held row goes on to step 5 and stays.
     IF NOT held_ok THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,b.retired_conflict_job_id]) x WHERE x IS NOT NULL ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
      EXIT rules;
     END IF;
    ELSIF FOUND AND (contact IS NULL OR b.job_id=ANY(ids||unpaid_ids||window_ids)) THEN
     cand:=b.job_id; e.attribution_status:='thread'; e.attribution_step:=2; rule:='thread';
    END IF;
   END IF;

   -- Supplier order numbers, only with no customer identity.
   IF cand IS NULL AND contact IS NULL AND ek IS NULL AND pk IS NULL THEN
    sk:=public.context_sender_key(e);
    order_toks:=public.context_supplier_order_tokens(subj);
    IF sk IS NOT NULL AND cardinality(order_toks)>0 THEN
     SELECT coalesce(array_agg(DISTINCT t.job_id) FILTER (WHERE t.retired_at IS NULL),'{}'),
      coalesce(array_agg(DISTINCT x) FILTER (WHERE t.retired_at IS NOT NULL AND x IS NOT NULL),'{}')
     INTO live_ids,retired_ids
     FROM public.event_threads t LEFT JOIN LATERAL unnest(ARRAY[t.job_id,t.retired_conflict_job_id]) x ON true
     WHERE t.thread_key IN (SELECT 'supplier_ref:'||sk||':'||o FROM unnest(order_toks) o);
     IF cardinality(retired_ids)>0 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(retired_ids||live_ids) x ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','supplier_order_retired');
      EXIT rules;
     ELSIF cardinality(live_ids)=1 THEN
      cand:=live_ids[1]; e.attribution_status:='thread'; e.attribution_step:=2; rule:='supplier_order_ref';
     ELSIF cardinality(live_ids)>1 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT x FROM unnest(live_ids) x ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','supplier_order_several');
      EXIT rules;
     END IF;
    END IF;
   END IF;

   -- 5. Contact rules, with the message's keys and the aftercare clause.
   IF cand IS NULL THEN
    n:=cardinality(ids);
    review_ids:=NULL;
    IF n>0 AND (e.metadata ? 'identity_conflict' OR cardinality(other_ids)>0) THEN
     rule:='review_identity_conflict'; review_ids:=ids||guard_ids;
    ELSIF n=1 AND cardinality(guard_ids)=0 THEN
     cand:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3;
     rule:=CASE WHEN e.metadata ? 'contact_recovered_by' THEN 'identity_'||(e.metadata->>'contact_recovered_by')
      WHEN contact IS NULL AND ek IS NOT NULL THEN 'identity_email' WHEN contact IS NULL THEN 'identity_phone' ELSE 'single_open' END;
    ELSIF n=1 THEN
     rule:='review_recent_other_job'; review_ids:=ids||guard_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_guard_job_ids',to_jsonb(guard_ids));
    ELSIF n>1 AND cardinality(line_ids)=1 THEN
     cand:=line_ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4; rule:='single_line';
    ELSIF n>1 THEN
     rule:='review_several'; review_ids:=ids;
    ELSIF cardinality(unpaid_ids)+cardinality(window_ids)>0 THEN
     -- Aftercare never places directly (decision on N7 and N17, 24 Sep): an
     -- unpaid invoice cannot tell a final-payment question from a new
     -- enquiry, only the words can, so the finished jobs go to review with the
     -- unpaid ones named.
     rule:='review_aftercare'; review_ids:=unpaid_ids||window_ids;
     IF cardinality(unpaid_ids)>0 THEN
      e.metadata:=e.metadata||jsonb_build_object('aftercare_unpaid_job_ids',to_jsonb(unpaid_ids));
     END IF;
    END IF;
    -- L1f (20261006020000): held placement. A row a contact rule or Luna
    -- already put on a job keeps it when the rules above would send it to
    -- review or the bucket and its job is still the answer (held_ok, set with
    -- the candidates): the rules-on reasons (an invoiced job counted finished,
    -- aftercare, a shared phone or email, a recently finished job and, since
    -- L1g, another live job of the customer) never take it off its job. A
    -- placement the rules above make is not outranked. placement_held_from
    -- names the rule it outranked.
    IF cand IS NULL AND held_ok THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_held_from',coalesce(rule,CASE WHEN contact IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END));
     cand:=held_job; e.attribution_status:=prior_status;
     e.attribution_step:=CASE prior_status WHEN 'single_open' THEN 3 WHEN 'single_line' THEN 4 ELSE 5 END;
     rule:='held_placement'; review_ids:=NULL;
    END IF;
    -- Stage 1 (20261014170000), candidate ranking (context_rank_contact_set),
    -- for a contact review only: the message names no job of ours, so its
    -- candidates come from who sent it. Jobs that are not a customer's job
    -- (no number: a hidden old-system record; a test job) leave the set,
    -- and a quote that was already dead at the message time (closed with
    -- no trace of progress, context_job_dead) leaves the recently finished
    -- set. When exactly one job is left and no finished work competes, the
    -- row places on it (ranked_open), as single_open would have. Work done,
    -- a job live at the message time that closed later, and aftercare stay
    -- competitors; status now and creation date are never evidence. A text
    -- naming several jobs, an address shared by several jobs and an
    -- identity conflict are never ranked.
    IF cand IS NULL AND review_ids IS NOT NULL AND rule IN ('review_several','review_recent_other_job') THEN
     SELECT r.job_id,r.dropped INTO cand,ranked_set FROM public.context_rank_contact_set(ids,guard_ids) r;
     IF cand IS NOT NULL THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_ranked_from',rule,'placement_ranked_below',to_jsonb(ranked_set));
      ranked_from:=rule; rule:='ranked_open';
      e.attribution_status:='single_open'; e.attribution_step:=3; review_ids:=NULL;
     END IF;
    END IF;
    -- A known customer with no job at the message time (the bucket) whose
    -- only job, of any status, is live now and was created after the
    -- message and within 60 days of it: the row places on it
    -- (only_open_job), a lead the job's own window just missed. The review
    -- guards below send it to review when the message, or the customer's
    -- messages around it, name another site, address or claim.
    IF cand IS NULL AND rule IS NULL AND contact IS NOT NULL AND cardinality(ids)=0 AND cardinality(open_all_ids)=1
     AND (SELECT count(*) FROM unnest(all_ids) x WHERE public.context_job_real(x))=1 THEN
     SELECT j.id INTO cand FROM public.jobs j WHERE j.id=open_all_ids[1] AND j.created_at>v_at AND j.created_at<=v_at+interval '60 days';
     IF cand IS NOT NULL THEN e.attribution_status:='single_open'; e.attribution_step:=3; rule:='only_open_job'; END IF;
    END IF;
    IF review_ids IS NOT NULL THEN
     -- Rows loaded as history or re-links never go to the model (X27).
     e.attribution_status:=CASE WHEN v_mode IN ('backfill','relink') THEN 'unplaced' ELSE 'pending_luna' END;
     e.attribution_step:=5; e.candidate_job_ids:=review_ids;
    END IF;
    IF rule IS NOT NULL THEN
     IF cardinality(contactless_ids)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_contactless_job_ids',to_jsonb(contactless_ids)); END IF;
     IF cardinality(other_ids)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_other_contact_job_ids',to_jsonb(other_ids)); END IF;
     IF used_updated_at THEN e.payload:=coalesce(e.payload,'{}'::jsonb)||jsonb_build_object('terminal_time_source','updated_at'); END IF;
    END IF;
    IF review_ids IS NOT NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
     EXIT rules;
    END IF;
   END IF;

   -- Stage 1 (20261014170000): a sender or recipient that is a job party
   -- (job_contacts) with no CRM contact places the row on that party's job
   -- (job_party) when exactly one job matches at the message time
   -- (context_party_key_jobs) and, when both the email and the phone match,
   -- they name the same parties. Anything else stays where it was.
   IF cand IS NULL AND contact IS NULL AND NOT (e.metadata ? 'identity_conflict') AND (ek IS NOT NULL OR pk IS NOT NULL) THEN
    SELECT CASE WHEN count(DISTINCT p.job_id)=1
      AND (NOT (bool_or(p.by_email) AND bool_or(p.by_phone))
       OR array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_email)
        =array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_phone))
      THEN array_agg(DISTINCT p.job_id) END,
     count(DISTINCT p.job_id)>1 OR (bool_or(p.by_email) AND bool_or(p.by_phone)
      AND array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_email)
       IS DISTINCT FROM array_agg(DISTINCT p.party_id ORDER BY p.party_id) FILTER (WHERE p.by_phone))
    INTO party_ids,party_conflict FROM public.context_party_key_jobs(ek,pk,v_at) p;
    IF cardinality(party_ids)=1 THEN
     cand:=party_ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='job_party';
    ELSIF party_conflict THEN
     e.metadata:=e.metadata||jsonb_build_object('party_key_conflict',true);
    END IF;
   END IF;

   -- Stage 1 review guards (20261014170000, third review). A placement made
   -- by who sent or received the message, not by what it names, goes to
   -- review instead, with the job as the one candidate, when:
   --   review_other_site: only_open_job, and the message or the customer's
   --     messages within 7 days of it name another site, address or claim
   --     (context_contact_names_other_site);
   --   review_party_other_site: job_party, and the email's subject (else the
   --     words) names a street address that is not the job's site nor any of
   --     its parties' (context_party_names_other_site);
   --   review_outbound_no_number: our own outbound message would land on a
   --     record with no job number, a test job or a holding job;
   --   review_empty_call_before_job: a call with no words would land on a job
   --     created more than 30 days after the call.
   -- A held placement and a placement by a reference, claim, thread or site
   -- are not guarded here.
   IF cand IS NOT NULL AND (rule IN ('single_open','single_line','ranked_open','only_open_job','job_party') OR rule LIKE 'identity\_%') THEN
    guard_rule:=CASE
     WHEN rule='only_open_job' AND public.context_contact_names_other_site(contact,words,e.payload->'builder_refs',v_at,cand) THEN 'review_other_site'
     WHEN rule='job_party' AND public.context_party_names_other_site(coalesce(nullif(btrim(subj),''),words),cand) THEN 'review_party_other_site'
     WHEN e.direction='outbound' AND NOT public.context_job_real(cand) THEN 'review_outbound_no_number'
     WHEN e.event_type='client.call_logged' AND coalesce(e.payload->>'words','')<>'true'
      AND (SELECT j.created_at FROM public.jobs j WHERE j.id=cand)>v_at+interval '30 days' THEN 'review_empty_call_before_job'
    END;
    IF guard_rule IS NOT NULL THEN
     e.attribution_status:=CASE WHEN v_mode IN ('backfill','relink') THEN 'unplaced' ELSE 'pending_luna' END;
     e.attribution_step:=5; e.candidate_job_ids:=ARRAY[cand];
     e.metadata:=e.metadata||jsonb_build_object('placement_rule',guard_rule,'placement_guarded_from',rule);
     cand:=NULL;
     EXIT rules;
    END IF;
   END IF;

   -- 6. Site address, only with no contact (council, certifier, our own mail,
   -- a sender we cannot identify) and no identity conflict.
   IF cand IS NULL AND contact IS NULL AND NOT (e.metadata ? 'identity_conflict') THEN
    site_text:=coalesce(subj||E'\n','')||left(public.context_event_text(e),1500);
    SELECT array_agg(DISTINCT m.address_key) FILTER (WHERE m.address_key IS NOT NULL AND NOT m.slash_form),
     array_agg(DISTINCT lk) INTO exact_keys,loose_keys
    FROM public.context_address_mentions(site_text) m LEFT JOIN LATERAL unnest(m.loose_keys) lk ON true;
    IF cardinality(loose_keys)>0 THEN
     WITH near AS (
      SELECT j.id, public.context_address_key(j.site_address) AS k, public.context_address_loose_keys(j.site_address) AS lk
      FROM public.jobs j
      WHERE j.site_address IS NOT NULL
       AND lower(coalesce(j.metadata->>'do_not_schedule','')) <> 'true'
       AND coalesce(j.created_at,'-infinity'::timestamptz)<=v_at
       AND (NOT (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false)
         OR (j.status::text='invoiced' AND j.completed_at IS NOT NULL))
        OR coalesce((
         SELECT min(coalesce(be.event_at,be.occurred_at)) FROM public.business_events be
         WHERE be.entity_type='job' AND be.entity_id=j.id::text AND be.event_type='job.status_changed'
          AND lower(be.payload->'changes'->'status'->>'to') IN ('cancelled','archived','lost','closed','complete','completed')
          AND coalesce(be.event_at,be.occurred_at)>coalesce((
           SELECT max(coalesce(nt.event_at,nt.occurred_at)) FROM public.business_events nt
           WHERE nt.entity_type='job' AND nt.entity_id=j.id::text AND nt.event_type='job.status_changed'
            AND lower(nt.payload->'changes'->'status'->>'to') NOT IN ('cancelled','archived','lost','closed','complete','completed')
          ),'-infinity'::timestamptz)
        ),j.completed_at,'-infinity'::timestamptz)>=v_at-interval '60 days'))
     SELECT array_agg(DISTINCT n.id ORDER BY n.id) FILTER (WHERE n.k=ANY(coalesce(exact_keys,'{}'))),
      array_agg(DISTINCT n.id ORDER BY n.id) FILTER (WHERE n.lk && loose_keys)
     INTO exact_ids,loose_ids FROM near n;
     e.metadata:=e.metadata||jsonb_build_object('placement_site_keys',jsonb_build_object('exact',cardinality(exact_keys),'loose',cardinality(loose_keys)));
     IF cardinality(exact_ids)=1 THEN
      cand:=exact_ids[1]; e.attribution_status:='content_ref'; e.attribution_step:=6; rule:='site_address';
     ELSIF cardinality(exact_ids) BETWEEN 2 AND 3 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=6; e.candidate_job_ids:=exact_ids;
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_several');
      EXIT rules;
     ELSIF cardinality(exact_ids)>3 THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_many','bucket_reason','no_identity_site');
      EXIT rules;
     ELSIF cardinality(loose_ids) BETWEEN 1 AND 3 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=6; e.candidate_job_ids:=loose_ids;
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_loose');
      EXIT rules;
     ELSIF cardinality(loose_ids)>3 THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_many','bucket_reason','no_identity_site');
      EXIT rules;
     END IF;
    END IF;
   END IF;

   -- 7. Nothing proved a job.
   IF cand IS NULL THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_rule',CASE WHEN contact IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END);
    EXIT rules;
   END IF;

   -- Placed. Bindings from proven placements only (X25).
   e.job_id:=cand;
   IF e.attribution_status IN ('direct','content_ref') AND nullif(e.thread_key,'') IS NOT NULL AND NOT is_ghl THEN
    SELECT * INTO b FROM public.event_threads WHERE thread_key=e.thread_key;
    IF NOT FOUND THEN
     IF p_preview THEN bindings:=bindings||jsonb_build_array(jsonb_build_object('key',e.thread_key,'job_id',cand));
     ELSE INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,cand,'ladder',e.id) ON CONFLICT DO NOTHING;
     END IF;
    ELSIF e.attribution_status='content_ref' AND b.retired_at IS NULL AND b.job_id<>cand THEN
     -- A content reference disagreeing with a live binding: neither is proof.
     IF NOT p_preview THEN
      UPDATE public.event_threads SET retired_at=clock_timestamp(),retired_reason='conflict',retired_conflict_job_id=cand
      WHERE thread_key=e.thread_key AND retired_at IS NULL;
     END IF;
     e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=6;
     e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,cand]) x ORDER BY x);
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
     cand:=NULL;
     EXIT rules;
    END IF;
   END IF;
   IF e.attribution_status='direct' AND contact IS NULL AND ek IS NULL AND pk IS NULL THEN
    sk:=public.context_sender_key(e);
    order_toks:=public.context_supplier_order_tokens(subj);
    IF sk IS NOT NULL AND cardinality(order_toks) BETWEEN 1 AND 2 THEN
     FOREACH tok IN ARRAY order_toks LOOP
      SELECT * INTO b FROM public.event_threads WHERE thread_key='supplier_ref:'||sk||':'||tok;
      IF NOT FOUND THEN
       IF p_preview THEN
        bindings:=bindings||jsonb_build_array(jsonb_build_object('key','supplier_ref:'||sk||':'||tok,'job_id',cand));
       ELSE
        INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES('supplier_ref:'||sk||':'||tok,cand,'ladder',e.id) ON CONFLICT DO NOTHING;
        SELECT * INTO b FROM public.event_threads WHERE thread_key='supplier_ref:'||sk||':'||tok;
       END IF;
      END IF;
      IF NOT p_preview AND FOUND AND b.retired_at IS NULL AND b.job_id<>cand THEN
       -- The same order number named for two jobs: retire it (Review M3).
       UPDATE public.event_threads SET retired_at=clock_timestamp(),retired_reason='conflict',retired_conflict_job_id=cand
       WHERE thread_key='supplier_ref:'||sk||':'||tok AND retired_at IS NULL;
       conflicts:=conflicts||to_jsonb('supplier_ref:'||sk||':'||tok);
      END IF;
     END LOOP;
    END IF;
   END IF;
   IF jsonb_array_length(conflicts)>0 THEN e.metadata:=e.metadata||jsonb_build_object('supplier_ref_conflicts',conflicts); END IF;
   IF p_preview AND jsonb_array_length(bindings)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_preview_bindings',bindings); END IF;
   e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
   e.attribution_confidence:=CASE WHEN rule='held_placement' THEN coalesce(held_conf,1) ELSE 1 END; e.attributed_at:=clock_timestamp();
   e.match_status:='matched'; e.match_confidence:=CASE WHEN rule='held_placement' THEN coalesce(held_match_conf,1) ELSE 1 END;
   e.match_method:=CASE WHEN custody THEN source_method WHEN rule='payload_job' THEN 'direct_job_id' WHEN rule IN ('direct_ref','link_ref','builder_ref') THEN 'ladder_ref'
    WHEN e.attribution_status='content_ref' THEN 'content_ref' ELSE 'contact_id' END;
   -- Stage 1 (20261014170000): a stored row that rested (bucket, unplaced,
   -- review or never decided) and is placed now by a stage-1 rule or by the
   -- recipient of our own message is a re-decision. The one rule for a
   -- stored-row re-decision (context_redecided_metadata) applies, by the
   -- message's own time: older than 48 hours it is stamped capture_mode
   -- relink (prior mode in capture_mode_before), so the event listener never
   -- reads it as fresh news; within 48 hours it stays news. A row being
   -- inserted is never stamped here.
   IF (rule IN ('link_ref','builder_ref','ranked_open','only_open_job','job_party')
     OR (e.direction='outbound' AND e.metadata ? 'contact_recovered_by'))
    AND (prior_status IN ('admin_bucket','unplaced','pending_luna')
     OR (prior_status IS NULL AND EXISTS (SELECT 1 FROM public.business_events x WHERE x.id=e.id))) THEN
    e.metadata:=public.context_redecided_metadata(e.metadata,coalesce(e.event_at,e.occurred_at));
   END IF;
  EXCEPTION WHEN OTHERS THEN
   e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL; e.candidate_job_ids:=NULL;
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
  END;
  IF e.job_id IS NULL AND e.attribution_status NOT IN ('direct','thread','single_open','single_line','luna','content_ref','party') THEN
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL;
  END IF;
 END IF;
 -- Always: why a bucket row is unlinked (metadata only, never a placement).
 IF e.attribution_status='admin_bucket' AND NOT (coalesce(e.metadata,'{}'::jsonb) ? 'bucket_reason') THEN
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('bucket_reason',public.context_bucket_reason(e));
 END IF;
 RETURN e;
END $function$;

-- 1. Post-image check: every replaced body is this migration's, and none of
-- them still reads the old spelling.
DO $post$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_contact_job_timeline(text,timestamptz)','88d0aa3f8bdbb2800d66954b5655f0dd'),
  ('public.context_contact_job_timeline(text,timestamptz,text,text)','be5e8d7df251fb3baf2d1a47641d93eb'),
  ('public.context_ref_jobs(text[])','14931b7986111458def3808cf85bbb57'),
  ('public.context_internal_about_job(public.business_events)','550176dbcdf545efa3c4703e160aec96'),
  ('public.context_event_writer_job(public.business_events)','9d29d9087ebb8765cc994174a960b6d4'),
  ('public.context_job_real(uuid)','7e2fdda96e02d11a45ef8188969c9a5a'),
  ('public.context_link_ref_jobs(text)','840a52b5a5a4805d5524a57f70c63572'),
  ('public.context_builder_ref_jobs(text,jsonb)','e4d864aa2b41862ea7fcf8e6b49260e7'),
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)','2ccef791fca954bfe1fcbb4e0de5f8a2')
 ) AS t(sig,want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig) AND p.prosrc LIKE '%NOT IN (''true'',''1'')%')
  THEN problems:=problems||format('%s still reads the old holding spelling',x.sig); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_ladder_holding_flag_postimage_mismatch: %',array_to_string(problems,'; ');
 END IF;
END $post$;
