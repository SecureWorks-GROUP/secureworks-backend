-- P1b: a new job reconsiders only its own customer's messages, inside its lead
-- window (INTEGRATION.md Wave 3, slice P1b; sms.md section 4b rules 6, 7 and
-- 8 (a) and (b); INTEGRATION X5, X6).
--
-- Until now every job insert ran context_job_created_reconsider, which re-ran
-- up to 250 of the contact's bucketed rows with no date limit, and for a job
-- with no GHL contact re-ran the whole bucket for every customer (audit I9).
-- A message already placed on a sibling job by a contact rule was never
-- looked at again, even when the new job was just as likely its home. This
-- migration:
--   1. context_reconsider_contact(contact, since, reason, job): the one
--      reconsideration of a contact's messages when something new can change
--      where they belong. Reason 'job_created' (the only reason in P1b; sites'
--      'party_linked' is P3's): for every message of the contact whose time
--      (coalesce(event_at, occurred_at)) is at or after `since` and for which
--      the new job is a candidate as the jobs stood at that time
--      (context_contact_jobs_at, P1a):
--        a. waiting in the bucket (admin_bucket or no status, no job): the
--           ladder decides again (rule 6). A message before any job binds to
--           the new job when it is the only candidate, or goes to review.
--        b. resting unplaced (rule 8 a/b): back to review once, with the new
--           job added to its stored candidates.
--        c. waiting for review (pending_luna): the new job is added to its
--           stored candidates; it stays in review and is not otherwise moved.
--        d. placed on another job by a contact rule (single_open, single_line,
--           luna; never direct, thread, content_ref, party or hand placement):
--           taken off that job and sent to review with the old job, the new
--           job and every candidate at its time (rule 7, the sibling reopen).
--      Only messages up to the job's creation (the lead window ends there).
--      "At most once per event": a message whose stored candidates already
--      name the new job, or that was already reconsidered for it, is left
--      alone, so a second call is a no-op. The test is applied again under the
--      row lock, so a row that changed status meanwhile is never moved.
--      A non-GHL row whose conversation is bound to a job (event_threads) is
--      kept: Luna's answer would follow that binding anyway (re-deciding
--      guess-bound threads is P4 / B-RUN).
--      Every message moved by (a), (b) or (d) is stamped capture_mode 'relink'
--      (the value it had is kept in metadata.capture_mode_before), so it never
--      wakes an extraction read on its own (cadence 5.1, INTEGRATION X15).
--      metadata.placement_reconsidered records reason, job, time and, for (d),
--      the placement it came from. Ids and codes only, no message text.
--      A message another session holds is skipped and counted (SKIP LOCKED),
--      so a job insert never waits on a row lock. At most 500 messages and 2
--      seconds of work per call, newest first; more is reported as truncated.
--      Returns counts as jsonb. Does nothing while the attribution lane is off.
--   2. context_job_created_reconsider (the AFTER INSERT trigger on jobs): a
--      job with no GHL contact returns at once (audit I9); a holding job
--      (metadata.do_not_schedule) is never a candidate and reconsiders
--      nothing; otherwise it calls (1) with `since` = the new job's lead-window
--      start (the later of created minus 30 days and the contact's previous
--      job becoming terminal). It never fails the job insert: an error is
--      logged as a warning with its SQLSTATE and the job id only.
--
-- Not changed: the ladder, the bucket re-run, the Luna guard, the candidate
-- set (P1a). No flag or switch changes. No existing row is written by the
-- migration itself: rows move only when a job is created after it lands.
--
-- Built on the LIVE production definitions, read from production 23 Sep 2026
-- (read-only):
--   context_job_created_reconsider()                   md5(prosrc) f351722c0a1ae9a77e6e3ac7168aab34
--     NOT the repository body (5345aed9...): hand-applied without the
--     20260911171000 comment line "Bounded deterministic work only; ...".
--     Same behaviour. EXECUTE held by postgres and service_role.
--   context_contact_job_timeline(text,timestamptz)      md5(prosrc) 2bc8e76f14fda242eb6e4d414e93fefa (P1a)
--   context_contact_jobs_at(text,timestamptz)           md5(prosrc) 911811b617fa760f5ddf847fb1ab853d (P1a)
--   resolve_context_attribution(business_events)        md5(prosrc) fe50f14f4ab28d4d6c9dbb70bc85e7df (P1a)
--   trigger context_job_created_reconsider AFTER INSERT ON jobs FOR EACH ROW, enabled.
--   jobs.created_at timestamptz default now(); business_events has
--   idx_events_contact_occurred (contact_id, occurred_at DESC), which serves
--   the per-contact scan (at most 257 rows for one contact, 35k rows in all),
--   so no index is added.
--   context_event_is_ghl(business_events)              md5(prosrc) 6bd4046317c4530a67ae38b0d7052cf4 (P1a)
--   context_reconsider_contact, context_reconsider_eligible: absent.
-- The guard refuses unless each replaced or read object is still that body
-- (or, for the replaced trigger function, already this migration's body on a
-- re-apply) and the new name is absent or already this migration's body.
-- Rollback: supabase/rollbacks/20260924160000_context_reconsider_contact_down.sql
-- restores the live trigger body byte for byte and drops the new function.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: live pre-image, or this migration's body.
  ('public.context_job_created_reconsider()',ARRAY['f351722c0a1ae9a77e6e3ac7168aab34','2e199e27d38730e95bd5f2b0b8a9b165'],false),
  -- Read, not replaced: must be P1a's body.
  ('public.context_contact_job_timeline(text,timestamptz)',ARRAY['2bc8e76f14fda242eb6e4d414e93fefa'],false),
  ('public.context_contact_jobs_at(text,timestamptz)',ARRAY['911811b617fa760f5ddf847fb1ab853d'],false),
  ('public.resolve_context_attribution(public.business_events)',ARRAY['fe50f14f4ab28d4d6c9dbb70bc85e7df'],false),
  ('public.context_event_is_ghl(public.business_events)',ARRAY['6bd4046317c4530a67ae38b0d7052cf4'],false),
  -- New: absent, or already this migration's body.
  ('public.context_reconsider_eligible(public.business_events,uuid)',ARRAY['375857877700389aa8f6f730095b8800'],true),
  ('public.context_reconsider_contact(text,timestamptz,text,uuid)',ARRAY['c4353d7e562bd5e92a5fd847d80c6238'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- Any other overload of the new names is a live change nobody read.
 FOR x IN SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('context_reconsider_contact','context_reconsider_eligible')
  AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' NOT IN (
   'context_reconsider_contact(p_contact_id text, p_since timestamp with time zone, p_reason text, p_job_id uuid)',
   'context_reconsider_eligible(e business_events, p_job_id uuid)') LOOP
  problems:=problems||format('unexpected overload %s',x.sig);
 END LOOP;
 -- The trigger that calls the replaced function: exactly one, AFTER INSERT, per row.
 IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.jobs'::regclass AND NOT t.tgisinternal
      AND t.tgfoid='public.context_job_created_reconsider()'::regprocedure)<>1
  OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.jobs'::regclass AND t.tgname='context_job_created_reconsider'
      AND t.tgfoid='public.context_job_created_reconsider()'::regprocedure
      AND t.tgtype=5 AND t.tgenabled<>'D')  -- 5 = ROW (1) + INSERT (4), no BEFORE bit: AFTER INSERT FOR EACH ROW, enabled
 THEN problems:=problems||'trigger context_job_created_reconsider on jobs is not the one AFTER INSERT FOR EACH ROW trigger'::text; END IF;
 -- Columns read.
 FOR x IN SELECT * FROM (VALUES
  ('jobs','id','uuid'),('jobs','ghl_contact_id','text'),('jobs','created_at','timestamp with time zone'),
  ('business_events','contact_id','text'),('business_events','job_id','uuid'),('business_events','event_at','timestamp with time zone'),
  ('business_events','occurred_at','timestamp with time zone'),('business_events','attribution_status','text'),
  ('business_events','candidate_job_ids','uuid[]'),('business_events','metadata','jsonb')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_reconsider_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The one reconsideration of a contact's messages.
-- The eligibility test is written once, as a private helper, and applied both
-- when scanning and again under the row lock, so a row that changed status in
-- between (placed direct by the bucket re-run, bound to a thread by Luna, made
-- automated) is never moved.
CREATE OR REPLACE FUNCTION public.context_reconsider_eligible(e public.business_events,p_job_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(
  ((e.job_id IS NULL AND (e.attribution_status IS NULL OR e.attribution_status IN ('admin_bucket','unplaced','pending_luna')))
   OR (e.job_id IS NOT NULL AND e.job_id<>p_job_id AND e.attribution_status IN ('single_open','single_line','luna')))
  -- Once per event: never a row that already names this job as a candidate
  -- or was already reconsidered for it.
  AND NOT (p_job_id=ANY(coalesce(e.candidate_job_ids,'{}'::uuid[])))
  AND coalesce(e.metadata->'placement_reconsidered'->>'job_id','') IS DISTINCT FROM p_job_id::text
  AND coalesce(e.metadata->'placement_candidates_widened'->>'job_id','') IS DISTINCT FROM p_job_id::text,
 false)
$$;
COMMENT ON FUNCTION public.context_reconsider_eligible(public.business_events,uuid) IS
 'Private to context_reconsider_contact: a row it may reconsider for a new job (bucket, unplaced, pending review, or placed on another job by single_open, single_line or luna), not already offered that job.';

CREATE OR REPLACE FUNCTION public.context_reconsider_contact(p_contact_id text,p_since timestamptz,p_reason text,p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 c record; e public.business_events; resolved public.business_events;
 v_until timestamptz; v_at timestamptz; v_start timestamptz:=clock_timestamp(); v_set uuid[]; v_cands uuid[]; v_note jsonb; v_mode jsonb;
 n_seen int:=0; n_placed int:=0; n_review int:=0; n_reopened int:=0; n_widened int:=0; n_unchanged int:=0;
 n_busy int:=0; n_thread int:=0;
 v_limit constant int:=500; v_budget constant interval:='2 seconds'; v_truncated text;
BEGIN
 IF p_reason IS NULL OR p_reason<>'job_created' THEN RAISE EXCEPTION 'context_reconsider_contact: unknown reason'; END IF;
 IF p_job_id IS NULL THEN RAISE EXCEPTION 'context_reconsider_contact: job_created needs the new job'; END IF;
 IF nullif(btrim(p_contact_id),'') IS NULL THEN RETURN jsonb_build_object('outcome','no_contact'); END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','lane_off'); END IF;
 -- The lead window ends at the job's creation (rules 6 and 7).
 SELECT coalesce(j.created_at,now()) INTO v_until FROM public.jobs j WHERE j.id=p_job_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_job'); END IF;
 FOR c IN
  SELECT b.id, coalesce(b.event_at,b.occurred_at) AS at FROM public.business_events b
  WHERE b.contact_id=p_contact_id
   AND coalesce(b.event_at,b.occurred_at)>=coalesce(p_since,'-infinity'::timestamptz)
   AND coalesce(b.event_at,b.occurred_at)<=v_until
   AND public.context_reconsider_eligible(b,p_job_id)
  -- Newest first: the rows nearest the new job matter most if the cap is hit.
  ORDER BY coalesce(b.event_at,b.occurred_at) DESC,b.id DESC
  LIMIT v_limit+1
 LOOP
  IF n_seen>=v_limit THEN v_truncated:='row_cap'; EXIT; END IF;
  IF clock_timestamp()-v_start>v_budget THEN v_truncated:='time_budget'; EXIT; END IF;
  n_seen:=n_seen+1;
  -- Cheap test first, no lock: is the new job a candidate at this row's time?
  SELECT coalesce(array_agg(j.job_id ORDER BY j.created_at,j.job_id),'{}') INTO v_set FROM public.context_contact_jobs_at(p_contact_id,c.at) j;
  IF NOT (p_job_id=ANY(v_set)) THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
  -- Never wait on a row another session holds (say, Luna placing it): skip it.
  SELECT * INTO e FROM public.business_events b WHERE b.id=c.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
   IF EXISTS(SELECT 1 FROM public.business_events b WHERE b.id=c.id) THEN n_busy:=n_busy+1; ELSE n_unchanged:=n_unchanged+1; END IF;
   CONTINUE;
  END IF;
  -- Re-check under the lock: the row may have changed since the scan.
  IF e.contact_id IS DISTINCT FROM p_contact_id OR NOT public.context_reconsider_eligible(e,p_job_id) THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
  v_at:=coalesce(e.event_at,e.occurred_at);
  IF v_at IS DISTINCT FROM c.at THEN
   IF v_at<coalesce(p_since,'-infinity'::timestamptz) OR v_at>v_until THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
   SELECT coalesce(array_agg(j.job_id ORDER BY j.created_at,j.job_id),'{}') INTO v_set FROM public.context_contact_jobs_at(p_contact_id,v_at) j;
   IF NOT (p_job_id=ANY(v_set)) THEN n_unchanged:=n_unchanged+1; CONTINUE; END IF;
  END IF;
  -- The first value this row was captured with survives later moves.
  v_mode:=coalesce(e.metadata->'capture_mode_before',to_jsonb(coalesce(e.metadata->>'capture_mode','live')));
  v_note:=jsonb_build_object('reason',p_reason,'job_id',p_job_id,'at',clock_timestamp());

  IF e.job_id IS NULL AND (e.attribution_status IS NULL OR e.attribution_status='admin_bucket') THEN
   -- (a) Before any job: the ladder decides with the new job now a candidate.
   resolved:=public.resolve_context_attribution(e);
   -- Only a placement or a review case is a move; anything else is left for
   -- the bucket re-run exactly as it was.
   IF resolved.job_id IS NULL AND resolved.attribution_status IS DISTINCT FROM 'pending_luna' THEN
    n_unchanged:=n_unchanged+1; CONTINUE;
   END IF;
   UPDATE public.business_events SET
    job_id=resolved.job_id,contact_id=resolved.contact_id,
    attribution_status=resolved.attribution_status,attribution_step=resolved.attribution_step,
    attribution_confidence=resolved.attribution_confidence,attributed_at=resolved.attributed_at,
    attribution_checked_at=resolved.attribution_checked_at,event_at=resolved.event_at,
    match_status=resolved.match_status,match_method=resolved.match_method,match_confidence=resolved.match_confidence,
    candidate_job_ids=resolved.candidate_job_ids,payload=resolved.payload,
    metadata=coalesce(resolved.metadata,'{}'::jsonb)||jsonb_build_object('capture_mode','relink','capture_mode_before',v_mode,
     'placement_reconsidered',v_note||jsonb_build_object('from_status',coalesce(e.attribution_status,'none')))
   WHERE id=e.id;
   IF resolved.job_id IS NOT NULL THEN n_placed:=n_placed+1; ELSE n_review:=n_review+1; END IF;

  ELSIF e.job_id IS NULL AND e.attribution_status='pending_luna' THEN
   -- (c) Already waiting for review: the new job joins its stored candidates.
   SELECT array_agg(x ORDER BY o) INTO v_cands FROM (
    SELECT x, min(o) AS o FROM unnest(coalesce(e.candidate_job_ids,'{}'::uuid[])||v_set) WITH ORDINALITY AS u(x,o) GROUP BY x) d;
   UPDATE public.business_events SET candidate_job_ids=v_cands,attribution_checked_at=clock_timestamp(),
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('placement_candidates_widened',v_note)
   WHERE id=e.id;
   n_widened:=n_widened+1;

  ELSIF nullif(e.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(e)
   AND EXISTS(SELECT 1 FROM public.event_threads t WHERE t.thread_key=e.thread_key) THEN
   -- A non-GHL row whose conversation is bound to a job: Luna's answer would
   -- follow that binding anyway, so reopening would spend an ask for nothing.
   -- Re-deciding guess-bound threads is the placement track's P4 / B-RUN work.
   n_thread:=n_thread+1;

  ELSE
   -- (b) resting unplaced, or (d) placed on a sibling by a contact rule:
   -- back to review, once, with the old job, the new job and every candidate
   -- at its time.
   SELECT array_agg(x ORDER BY o) INTO v_cands FROM (
    SELECT x, min(o) AS o FROM unnest(coalesce(e.candidate_job_ids,'{}'::uuid[])||CASE WHEN e.job_id IS NOT NULL THEN ARRAY[e.job_id] ELSE '{}'::uuid[] END||v_set)
     WITH ORDINALITY AS u(x,o) GROUP BY x) d;
   IF e.job_id IS NOT NULL THEN
    v_note:=v_note||jsonb_build_object('from_status',e.attribution_status,'from_job_id',e.job_id,'from_step',e.attribution_step,
     'from_confidence',e.attribution_confidence,'from_attributed_at',e.attributed_at);
   ELSE
    v_note:=v_note||jsonb_build_object('from_status',e.attribution_status);
   END IF;
   UPDATE public.business_events SET job_id=NULL,attribution_status='pending_luna',attribution_step=5,
    attribution_confidence=NULL,attributed_at=NULL,attribution_checked_at=clock_timestamp(),
    match_status='unresolved',match_method='none',match_confidence=NULL,candidate_job_ids=v_cands,
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('capture_mode','relink','capture_mode_before',v_mode,
     'placement_rule','reopen_new_job','placement_reconsidered',v_note)
   WHERE id=e.id;
   n_reopened:=n_reopened+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('outcome','done','reason',p_reason,'job_id',p_job_id,'seen',n_seen,'placed',n_placed,
  'to_review',n_review,'reopened',n_reopened,'widened',n_widened,'unchanged',n_unchanged,'skipped_busy',n_busy,
  'kept_thread_bound',n_thread,'truncated',v_truncated);
END $$;
COMMENT ON FUNCTION public.context_reconsider_contact(text,timestamptz,text,uuid) IS
 'Reconsiders a GHL contact''s messages between p_since and the new job''s creation (reason job_created) when that job is a candidate at their time: bucket rows re-run the ladder; unplaced rows and rows placed on a sibling by single_open, single_line or luna go back to review once with the new job added; review rows gain it as a candidate. Moved rows are capture_mode relink. Never direct, thread, content_ref or party placements; never waits on a locked row. Returns counts.';

-- 2. The job-created trigger body.
CREATE OR REPLACE FUNCTION public.context_job_created_reconsider() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_since timestamptz; v_result jsonb;
BEGIN
 -- A job with no customer reconsiders nothing (audit I9).
 IF nullif(btrim(NEW.ghl_contact_id),'') IS NULL THEN RETURN NEW; END IF;
 -- The new job's lead window; a holding job has none and is never a candidate.
 SELECT t.window_start INTO v_since FROM public.context_contact_job_timeline(NEW.ghl_contact_id,NEW.created_at) t WHERE t.job_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 v_result:=public.context_reconsider_contact(NEW.ghl_contact_id,v_since,'job_created',NEW.id);
 IF coalesce((v_result->>'skipped_busy')::int,0)>0 OR v_result->>'truncated' IS NOT NULL THEN
  RAISE WARNING 'context job reconsideration incomplete for job %: skipped_busy % truncated %',NEW.id,v_result->>'skipped_busy',v_result->>'truncated';
 END IF;
 RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 -- Never fail the job insert; log the code and the job id only.
 RAISE WARNING 'context job reconsideration failed for job %: SQLSTATE %',NEW.id,SQLSTATE;
 RETURN NEW;
END $$;
COMMENT ON FUNCTION public.context_job_created_reconsider() IS
 'AFTER INSERT on jobs: returns at once for a job with no GHL contact or a holding job; otherwise context_reconsider_contact over the new job''s lead window. Never fails the insert.';

-- 3. Grants: nothing reachable by the public key or a signed-in login; the
-- eligibility helper is private.
REVOKE ALL ON FUNCTION public.context_reconsider_contact(text,timestamptz,text,uuid),public.context_job_created_reconsider(),
 public.context_reconsider_eligible(public.business_events,uuid)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_reconsider_eligible(public.business_events,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.context_reconsider_contact(text,timestamptz,text,uuid) TO service_role;
