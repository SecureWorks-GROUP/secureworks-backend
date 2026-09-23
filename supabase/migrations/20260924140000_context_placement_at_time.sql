-- P1a: each message placed on one job, as the jobs stood when it was sent
-- (INTEGRATION.md Wave 3, slice P1a; sms.md section 4b rules 1, 2, 4, 5 and 9,
-- section 4 step 2; sites.md section 4 reads this candidate set).
--
-- Until now the ladder's contact rules (steps 3 to 6) asked "which jobs does
-- this contact have open TODAY", and the Luna guard refused anything else.
-- So a closed job's later texts fell onto a newer job, a new job collected
-- texts about an older finished one, old messages loaded today landed on
-- today's job, and the model could never pick an archived or contactless job
-- even when it was the right one. This migration:
--   1. context_contact_jobs_at(contact, at): the one candidate set, as it stood
--      at the message time. A job is a candidate when it was created at or
--      before `at` and had not become terminal before `at`, or when it was
--      created after `at` and its lead window covers `at` (from the later of
--      created minus 30 days and the contact's previous job becoming terminal,
--      up to its creation). Contactless jobs (no GHL contact) whose client
--      phone (last 9 digits) or email matches the contact join the set.
--      Terminal time: when the job last became terminal, from its own
--      job.status_changed evidence (earliest terminal `to` after the latest
--      non-terminal `to`; if none, the earliest terminal transition), then
--      completed_at, then updated_at (recorded when a job dated that way
--      entered the candidate or guard set). Holding jobs
--      (metadata.do_not_schedule) are never candidates. The booking-lane draft
--      rule is kept: a draft counts only when no non-draft job is a candidate.
--   2. resolve_context_attribution: steps 3 to 6 read that set at
--      coalesce(event_at, occurred_at). One candidate: single_open, unless the
--      90-day guard trips (another terminal, archived or contactless job of
--      the contact became terminal in the 90 days before the message); then
--      review with the guard jobs added to the candidates. Several: single_line
--      when exactly one matches our fencing or patio line, else review. A row
--      sent to review stores candidate_job_ids. GHL items (provider id ghl:...
--      or a ghl source) never use the thread step and never bind a thread: a
--      GHL conversation is per contact, not per job. Step 1 (L1) is unchanged.
--   3. attribute_context_event_with_luna (both overloads): the guard checks
--      the chosen job against the row's stored candidate list (for rows sent
--      to review before this migration, the at-time set at the row's time),
--      not against today's open jobs. GHL rows bind no thread.
--   4. rerun_context_attribution persists candidate_job_ids with the rest of
--      the resolved row, and selects only rows that hold no job (L1b's re-run
--      line, landing with P1a): a contactless job insert re-runs the bucket for
--      every contact, and today it strips the job from unrelated rows that hold
--      one with no status (audit H1). L1b's null-contact early return is P1b's.
-- metadata.placement_rule names the contact rule that decided the row;
-- metadata.placement_contactless_job_ids and placement_guard_job_ids name the
-- jobs that made it a review case (data-quality counts). Ids only, no text.
--
-- No flag or switch changes. No existing row is written or rewritten: rows
-- already placed keep their placement until a later logged re-run (sms M4).
-- Reopening rows when a sibling job is created is slice P1b; content_ref is P2.
--
-- Built on the LIVE production definitions, read from production 23 Sep 2026
-- (read-only):
--   resolve_context_attribution(business_events)  md5(prosrc) acb80ebe792beeb7e5b537643bf9f184
--     = the 20260923230000 (L1) body.
--   rerun_context_attribution(integer,text)        md5(prosrc) e55811ae70e8643c3fdfc72c8741b471
--     = the 20260914110000 body.
--   attribute_context_event_with_luna(uuid,uuid,numeric)
--                                                  md5(prosrc) 48eabf7e132092cd225ff5060ce58846
--     = the hand-applied body recorded in the 20260924060000 contract setup.
--   attribute_context_event_with_luna(uuid,uuid,numeric,text)
--                                                  md5(prosrc) 407832111a538b414897fa0b359232d2
--     = the 20260924060000 (A1) body.
--   jobs.archived boolean, jobs.completed_at, created_at and updated_at
--   timestamptz (nullable), client_phone and client_email text; business_events
--   entity_type and entity_id text, candidate_job_ids uuid[] (F1).
--   context_contact_jobs_at, context_contact_job_timeline, context_event_is_ghl:
--   absent. The ledger held nothing after 20260924100000.
-- The guard refuses unless each replaced object is still that pre-image (or
-- already this migration's body, for a re-apply) and each new name is absent
-- or already this migration's body.
-- Rollback: supabase/rollbacks/20260924140000_context_placement_at_time_down.sql
-- restores the four live bodies byte for byte and drops the new functions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: live pre-image, or this migration's body.
  ('public.resolve_context_attribution(public.business_events)',ARRAY['acb80ebe792beeb7e5b537643bf9f184','fe50f14f4ab28d4d6c9dbb70bc85e7df'],false),
  ('public.rerun_context_attribution(integer,text)',ARRAY['e55811ae70e8643c3fdfc72c8741b471','c80fea38727a0302b57a1111e6099c1c'],false),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric)',ARRAY['48eabf7e132092cd225ff5060ce58846','fde44559c43dcc770d1c42909f4adeaf'],false),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric,text)',ARRAY['407832111a538b414897fa0b359232d2','cbb46324b06a0f5b6c3f5ddf695ddb1a'],false),
  -- New: absent, or already this migration's body.
  ('public.context_event_is_ghl(public.business_events)',ARRAY['6bd4046317c4530a67ae38b0d7052cf4'],true),
  ('public.context_contact_job_timeline(text,timestamptz)',ARRAY['2bc8e76f14fda242eb6e4d414e93fefa'],true),
  ('public.context_contact_jobs_at(text,timestamptz)',ARRAY['911811b617fa760f5ddf847fb1ab853d'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- Any other overload of a name this migration owns is a live change nobody read.
 FOR x IN SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('context_contact_jobs_at','context_contact_job_timeline','context_event_is_ghl')
  AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' NOT IN (
   'context_contact_jobs_at(p_contact_id text, p_at timestamp with time zone)',
   'context_contact_job_timeline(p_contact_id text, p_at timestamp with time zone)',
   'context_event_is_ghl(e business_events)') LOOP
  problems:=problems||format('unexpected overload %s',x.sig);
 END LOOP;
 -- Columns read by the candidate set and the ladder.
 FOR x IN SELECT * FROM (VALUES
  ('jobs','archived','boolean'),('jobs','completed_at','timestamp with time zone'),
  ('jobs','created_at','timestamp with time zone'),('jobs','updated_at','timestamp with time zone'),
  ('jobs','client_phone','text'),('jobs','client_email','text'),('jobs','ghl_contact_id','text'),('jobs','metadata','jsonb'),
  ('contact_matches','ghl_contact_id','text'),('contact_matches','xero_contact_id','text'),
  ('business_events','entity_type','text'),('business_events','entity_id','text'),('business_events','candidate_job_ids','uuid[]')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 -- The resting and review statuses must exist (F1).
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.business_events'::regclass
   AND c.conname='business_events_attribution_status_check' AND pg_get_constraintdef(c.oid) LIKE '%''unplaced''::text%')
 THEN problems:=problems||'business_events_attribution_status_check does not allow unplaced (F1 not applied)'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_placement_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. A GHL item: a GHL conversation is per contact, not per job, so its key is
-- never a job thread. Reads only the row.
CREATE OR REPLACE FUNCTION public.context_event_is_ghl(e public.business_events) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(e.provider_message_id LIKE 'ghl:%',false) OR coalesce(e.source ILIKE '%ghl%',false)
$$;
COMMENT ON FUNCTION public.context_event_is_ghl(public.business_events) IS
 'True for a GHL item (provider_message_id ghl:<id>, or a GHL writer source). Its conversation key is never used as a job thread.';

-- 2. Every job of a contact with its timeline as seen at p_at: the contact's
-- own jobs (GHL contact id on the job or in contact_matches, as today) and
-- contactless jobs matched by the contact's phone (last 9 digits, at least 8
-- digits, not one repeated digit) or email. Private: read through
-- context_contact_jobs_at and the ladder.
CREATE OR REPLACE FUNCTION public.context_contact_job_timeline(p_contact_id text,p_at timestamptz)
RETURNS TABLE(job_id uuid,job_number text,type text,status text,basis text,created_at timestamptz,
 terminal boolean,terminal_at timestamptz,terminal_time_source text,window_start timestamptz,candidate boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
  WHERE coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
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
$$;
COMMENT ON FUNCTION public.context_contact_job_timeline(text,timestamptz) IS
 'Every job of a GHL contact (its own jobs and phone- or email-matched contactless jobs) with creation, terminal time and its source, lead-window start and whether it is a candidate at p_at. Private; read context_contact_jobs_at.';

-- 3. The one candidate set (sms.md rule 1), for the ladder, the Luna guard and
-- (later) the Luna worker, the dossier's visit labels and the sites read.
CREATE OR REPLACE FUNCTION public.context_contact_jobs_at(p_contact_id text,p_at timestamptz)
RETURNS TABLE(job_id uuid,job_number text,type text,status text,basis text,created_at timestamptz,terminal_at timestamptz,terminal_time_source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.job_id,t.job_number,t.type,t.status,t.basis,t.created_at,t.terminal_at,t.terminal_time_source
 FROM public.context_contact_job_timeline(p_contact_id,p_at) t WHERE t.candidate
 ORDER BY t.created_at,t.job_id
$$;
COMMENT ON FUNCTION public.context_contact_jobs_at(text,timestamptz) IS
 'Candidate jobs for a GHL contact as they stood at p_at: created at or before p_at and not terminal before it, or created later with a lead window (created minus 30 days, or the previous job''s terminal time if later) covering p_at; contactless jobs matched by phone or email included (basis contactless); holding jobs never; a draft only when no non-draft job is a candidate.';

-- 4. The ladder. Step 1 (L1) and custody are unchanged; step 2 skips GHL
-- items; steps 3 to 6 read the at-time candidates.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE words text; tokens text; ids uuid[]; candidate uuid; n int; line text; contact_ids text[]; prior_status text; source_method text;
 v_at timestamptz; is_ghl boolean; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; used_updated_at boolean; rule text;
BEGIN
 prior_status:=e.attribution_status;
 source_method:=e.match_method;
 IF e.job_id IS NOT NULL AND source_method IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('source_job_binding',jsonb_build_object('job_id',e.job_id,'match_method',source_method));
 ELSIF e.job_id IS NULL AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
   SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
   source_method:=e.metadata->'source_job_binding'->>'match_method';
 END IF;
 IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
   e.job_id:=NULL;
 END IF;
 e.attribution_checked_at:=clock_timestamp();
 words:=public.context_event_text(e);
 e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.candidate_job_ids:=NULL;
 IF e.metadata ?| ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids'] THEN
  e.metadata:=e.metadata-'placement_rule'-'placement_contactless_job_ids'-'placement_guard_job_ids';
 END IF;
 IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; RETURN e; END IF;
 IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; RETURN e; END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty'; RETURN e; END IF;
 IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
 THEN e.attribution_status:='automated'; RETURN e; END IF;
 is_ghl:=public.context_event_is_ghl(e);
 SELECT id INTO candidate FROM public.jobs WHERE id=e.job_id;
 IF candidate IS NULL THEN
   tokens:=' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ';
   SELECT array_agg(DISTINCT refs.job_id) INTO ids FROM (
     SELECT j.id AS job_id FROM public.jobs j WHERE length(btrim(j.job_number))>=5
      AND strpos(tokens,' '||upper(j.job_number)||' ')>0
     UNION SELECT x.job_id FROM public.xero_invoices x WHERE x.job_id IS NOT NULL
      AND x.invoice_type='ACCREC' AND upper(x.invoice_number) LIKE 'INV-%' AND length(btrim(x.invoice_number))>=5
      AND strpos(tokens,' '||upper(x.invoice_number)||' ')>0
     UNION SELECT po.job_id FROM public.purchase_orders po WHERE po.job_id IS NOT NULL AND length(btrim(po.po_number))>=5
      AND strpos(tokens,' '||upper(po.po_number)||' ')>0
   ) refs JOIN public.jobs ref_job ON ref_job.id=refs.job_id
   WHERE coalesce(to_jsonb(ref_job)->'metadata'->>'do_not_schedule','') NOT IN ('true','1');
   IF cardinality(ids)=1 THEN candidate:=ids[1];
   ELSIF cardinality(ids)>1 THEN e.job_id:=NULL; RETURN e; END IF;
 END IF;
 IF candidate IS NOT NULL THEN e.attribution_status:='direct'; e.attribution_step:=1;
 ELSE
  IF NOT is_ghl THEN
   SELECT job_id INTO candidate FROM public.event_threads WHERE thread_key=e.thread_key;
  END IF;
  IF candidate IS NOT NULL THEN e.attribution_status:='thread'; e.attribution_step:=2;
  ELSE
   IF e.contact_id IS NULL THEN
    SELECT array_agg(DISTINCT j.ghl_contact_id) INTO contact_ids FROM public.jobs j
    WHERE j.ghl_contact_id IS NOT NULL AND (
      (nullif(e.payload->>'email','') IS NOT NULL AND lower(to_jsonb(j)->>'client_email')=lower(e.payload->>'email')) OR
      (length(regexp_replace(coalesce(e.payload->>'phone',''),'[^0-9]','','g'))>=8 AND
       right(regexp_replace(coalesce(to_jsonb(j)->>'client_phone',to_jsonb(j)->>'phone',''),'[^0-9]','','g'),9)=right(regexp_replace(e.payload->>'phone','[^0-9]','','g'),9)));
    IF cardinality(contact_ids)=1 THEN e.contact_id:=contact_ids[1]; END IF;
   END IF;
   v_at:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
   line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
   SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='contactless' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),'{}'),
    coalesce(bool_or(t.terminal_time_source='updated_at' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),false)
   INTO ids,line_ids,guard_ids,contactless_ids,used_updated_at
   FROM public.context_contact_job_timeline(e.contact_id,v_at) t;
   n:=cardinality(ids);
   IF n=1 AND cardinality(guard_ids)=0 THEN
    candidate:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='single_open';
   ELSIF n=1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_recent_other_job';
    e.candidate_job_ids:=ids||guard_ids;
   ELSIF n>1 AND cardinality(line_ids)=1 THEN
    candidate:=line_ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4; rule:='single_line';
   ELSIF n>1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_several';
    e.candidate_job_ids:=ids;
   ELSE
    rule:=CASE WHEN e.contact_id IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END;
   END IF;
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule',rule);
   IF cardinality(contactless_ids)>0 THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_contactless_job_ids',to_jsonb(contactless_ids));
   END IF;
   IF rule='review_recent_other_job' THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_guard_job_ids',to_jsonb(guard_ids));
   END IF;
   IF used_updated_at THEN e.payload:=coalesce(e.payload,'{}'::jsonb)||jsonb_build_object('terminal_time_source','updated_at'); END IF;
  END IF;
 END IF;
 e.job_id:=candidate;
 IF candidate IS NOT NULL THEN
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT is_ghl THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,candidate,'ladder',e.id) ON CONFLICT DO NOTHING;
   IF NOT EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key=e.thread_key AND job_id=candidate) THEN
    e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
    e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error','thread_conflict'); RETURN e;
   END IF;
  END IF;
  e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
  e.match_status:='matched'; e.match_method:=CASE WHEN e.attribution_status='direct' THEN 'direct_job_id' ELSE 'contact_id' END; e.match_confidence:=1;
 ELSE e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 END IF;
 RETURN e;
EXCEPTION WHEN OTHERS THEN
 e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL; e.candidate_job_ids:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
 RETURN e;
END $$;

-- 5. Re-run: the live body, persisting the stored candidate list, and never
-- selecting a row that holds a job (L1b's re-run line).
CREATE OR REPLACE FUNCTION public.rerun_context_attribution(p_limit integer DEFAULT 250, p_contact_id text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e public.business_events;
  resolved public.business_events;
  n int := 0;
BEGIN
  IF NOT public.automation_lane_enabled('attribution') THEN RETURN 0; END IF;
  FOR e IN
    SELECT * FROM public.business_events
    WHERE (attribution_status = 'admin_bucket' OR attribution_status IS NULL)
      AND job_id IS NULL
      AND (p_contact_id IS NULL OR contact_id = p_contact_id)
    ORDER BY attribution_checked_at NULLS FIRST, occurred_at, id
    LIMIT greatest(0, least(coalesce(p_limit, 250), 1000))
    FOR UPDATE SKIP LOCKED
  LOOP
    resolved := public.resolve_context_attribution(e);
    UPDATE public.business_events SET
      job_id = resolved.job_id,
      contact_id = resolved.contact_id,
      attribution_status = resolved.attribution_status,
      attribution_step = resolved.attribution_step,
      attribution_confidence = resolved.attribution_confidence,
      attributed_at = resolved.attributed_at,
      attribution_checked_at = resolved.attribution_checked_at,
      event_at = resolved.event_at,
      match_status = resolved.match_status,
      match_method = resolved.match_method,
      match_confidence = resolved.match_confidence,
      candidate_job_ids = resolved.candidate_job_ids,
      payload = resolved.payload,
      metadata = resolved.metadata
    WHERE id = e.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- 6. The Luna guard, legacy three-argument call: the live body with the guard
-- reading the stored candidate list and no thread binding for GHL rows.
CREATE OR REPLACE FUNCTION public.attribute_context_event_with_luna(p_event_id uuid,p_job_id uuid,p_confidence numeric)
RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; chosen uuid;
BEGIN
 IF NOT public.automation_lane_enabled('attribution') THEN RAISE EXCEPTION 'attribution disabled'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'event is not pending Luna'; END IF;
 IF p_job_id IS NOT NULL THEN
  IF p_confidence IS NULL OR p_confidence<0 OR p_confidence>1 OR p_confidence='NaN'::numeric THEN RAISE EXCEPTION 'invalid confidence'; END IF;
  IF NOT (p_job_id=ANY(coalesce(e.candidate_job_ids,ARRAY(SELECT c.job_id FROM public.context_contact_jobs_at(e.contact_id,coalesce(e.event_at,e.occurred_at)) c))))
  THEN RAISE EXCEPTION 'job is not a contact candidate'; END IF;
  chosen:=p_job_id;
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(e) THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,p_job_id,'luna',e.id) ON CONFLICT DO NOTHING;
   SELECT job_id INTO chosen FROM public.event_threads WHERE thread_key=e.thread_key;
   IF chosen<>p_job_id THEN p_confidence:=1; END IF;
  END IF;
 END IF;
 UPDATE public.business_events SET job_id=chosen,
 attribution_status=CASE WHEN chosen IS NULL THEN 'admin_bucket' WHEN chosen<>p_job_id THEN 'thread' ELSE 'luna' END,
 attribution_step=CASE WHEN chosen IS NULL THEN 6 WHEN chosen<>p_job_id THEN 2 ELSE 5 END,
 attribution_confidence=CASE WHEN chosen IS NOT NULL THEN p_confidence END,
 attributed_at=CASE WHEN chosen IS NOT NULL THEN clock_timestamp() END,
 attribution_checked_at=clock_timestamp(),match_status=CASE WHEN chosen IS NULL THEN 'unresolved' ELSE 'matched' END,
 match_method=CASE WHEN chosen IS NULL THEN 'none' ELSE 'contact_id' END,
 match_confidence=CASE WHEN chosen IS NOT NULL THEN p_confidence END
 WHERE id=e.id RETURNING * INTO e;
 RETURN e;
END $$;

-- 7. The Luna guard, outcome call (A1): the same two changes.
CREATE OR REPLACE FUNCTION public.attribute_context_event_with_luna(p_event_id uuid,p_job_id uuid,p_confidence numeric,p_outcome text)
RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; chosen uuid; v_outcome text:=p_outcome; v_now timestamptz:=clock_timestamp(); v_note jsonb;
BEGIN
 IF NOT public.automation_lane_enabled('attribution') THEN RAISE EXCEPTION 'attribution disabled'; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('job','several','undecided') THEN RAISE EXCEPTION 'invalid attribution outcome'; END IF;
 IF p_outcome='job' AND p_job_id IS NULL THEN RAISE EXCEPTION 'job outcome needs a job'; END IF;
 IF p_outcome<>'job' AND p_job_id IS NOT NULL THEN RAISE EXCEPTION 'several or undecided names no job'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'event is not pending Luna'; END IF;
 v_note:=jsonb_build_object('luna_outcome',p_outcome,'luna_outcome_at',v_now);
 IF p_outcome='job' THEN
  IF p_confidence IS NULL OR p_confidence<0 OR p_confidence>1 OR p_confidence='NaN'::numeric THEN RAISE EXCEPTION 'invalid confidence'; END IF;
  IF NOT (p_job_id=ANY(coalesce(e.candidate_job_ids,ARRAY(SELECT c.job_id FROM public.context_contact_jobs_at(e.contact_id,coalesce(e.event_at,e.occurred_at)) c))))
  THEN RAISE EXCEPTION 'job is not a contact candidate'; END IF;
  IF p_confidence<0.8 THEN
   -- Below the floor: honestly unknown beats confidently wrong. Rest it.
   v_outcome:='undecided';
   v_note:=jsonb_build_object('luna_outcome','undecided','luna_outcome_at',v_now,
    'luna_below_floor',jsonb_build_object('job_id',p_job_id,'confidence',p_confidence));
  END IF;
 END IF;
 IF v_outcome='job' THEN
  chosen:=p_job_id;
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(e) THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,p_job_id,'luna',e.id) ON CONFLICT DO NOTHING;
   SELECT job_id INTO chosen FROM public.event_threads WHERE thread_key=e.thread_key;
   -- A racing reply follows the thread winner; it never overwrites that binding.
   IF chosen<>p_job_id THEN p_confidence:=1; END IF;
  END IF;
  UPDATE public.business_events SET job_id=chosen,
   attribution_status=CASE WHEN chosen<>p_job_id THEN 'thread' ELSE 'luna' END,
   attribution_step=CASE WHEN chosen<>p_job_id THEN 2 ELSE 5 END,
   attribution_confidence=p_confidence,attributed_at=v_now,attribution_checked_at=v_now,
   match_status='matched',match_method='contact_id',match_confidence=p_confidence,
   metadata=coalesce(metadata,'{}'::jsonb)||v_note
  WHERE id=e.id RETURNING * INTO e;
 ELSE
  -- Resting: off every job, candidates kept, never selected again by the
  -- bucket re-run or the Luna page; shown in each candidate's not-yet-placed lane.
  UPDATE public.business_events SET job_id=NULL,attribution_status='unplaced',attribution_step=5,
   attribution_confidence=NULL,attributed_at=NULL,attribution_checked_at=v_now,
   match_status='unresolved',match_method='none',match_confidence=NULL,
   metadata=coalesce(metadata,'{}'::jsonb)||v_note
  WHERE id=e.id RETURNING * INTO e;
 END IF;
 PERFORM public.context_attribution_record_attempt(e,v_outcome,NULL);
 RETURN e;
END $$;

-- 8. Grants: nothing reachable by the public key or a signed-in login.
-- CREATE OR REPLACE keeps an existing ACL; restate it for every object.
REVOKE ALL ON FUNCTION
 public.context_event_is_ghl(public.business_events),
 public.context_contact_job_timeline(text,timestamptz),
 public.context_contact_jobs_at(text,timestamptz),
 public.resolve_context_attribution(public.business_events),
 public.rerun_context_attribution(integer,text),
 public.attribute_context_event_with_luna(uuid,uuid,numeric),
 public.attribute_context_event_with_luna(uuid,uuid,numeric,text)
FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_contact_job_timeline(text,timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION
 public.context_event_is_ghl(public.business_events),
 public.context_contact_jobs_at(text,timestamptz),
 public.rerun_context_attribution(integer,text),
 public.attribute_context_event_with_luna(uuid,uuid,numeric),
 public.attribute_context_event_with_luna(uuid,uuid,numeric,text)
TO service_role;
