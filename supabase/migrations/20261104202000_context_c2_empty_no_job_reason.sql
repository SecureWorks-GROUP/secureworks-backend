-- C2 place (row C2, CIO chat helper, 3 Nov 2026): a customer message with no
-- words from a sender who has no job is marked not about a job, with the
-- reason a worded message gets in the same place.
--
-- Why (production, read only, 3 Nov 2026 19:28Z to 20:0xZ; verify/evidence/
-- 20261103-c2-place in the context-system project): of the 3,309 C2 misses,
-- 1,098 are "empty" (no words read: a call with no transcript, a blank text,
-- our own tool's copy). 756 of those rest with the named rule
-- no_candidate_at_time: the contact had no job at the message time and no
-- finished job in the aftercare window. A worded message in exactly that
-- place is set aside (admin_bucket) with context_bucket_reason, which says
-- contact_no_jobs or before_any_job (finish line C2's not-about-a-job
-- reasons), but context_empty_row_job (20261104095000) leaves an empty row
-- "empty", so C2 counts it as neither placed nor marked.
--
-- Changed: context_empty_row_job, two branches.
-- 1. A copy our own tool logged follows its twin only onto a job that can be a
--    customer's (context_job_real: numbered, not a test, not holding). Read
--    19:58Z: 5 copies would follow a twin its writer had put on the holding
--    record SWF-PDF-BUCKET; the contact's own jobs now decide them.
-- 2. The last branch (no_candidate_at_time) asks context_bucket_reason with
--    the contact it found and returns copy_status admin_bucket with that
--    reason when the message's own keys agree (the four-argument timeline
--    with its phone and email, every basis):
--   contact_no_jobs  - no job of the contact's and none carrying its phone or
--                      email, any contact's or contactless;
--   before_any_job   - none of those existed at the message time and the
--                      first came more than 60 days after it (inside 60 days
--                      a worded message can be placed as the only open job's
--                      lead, so an empty one is left for a person).
-- resolve_context_attribution (20261104095000, md5 f9cd8d311bf00a92f7b708ff2d2dc8a7) already sets
-- such a row aside with copy_reason as its bucket_reason (the path a copy of
-- a set-aside twin takes). Any other reason (only finished work, a job hint
-- taken off, an error) leaves the row empty with its named rule as before.
-- Nothing new is placed and nothing is guessed: a row with any job at its
-- time, several jobs, a finished job beside, a shared phone or email or no
-- contact is decided exactly as before.
-- Every other character of the body is the live body (20261104095000).
-- md5(prosrc), old -> new:
--   public.context_empty_row_job(public.business_events)  130b29784228b2542306f5c0e5a5f0e7 -> b057fc7da940afe25833028d511594b5
--
-- Not changed: the ladder, the hand run (context_redecide_one already writes
-- an empty row the ladder sets aside: outcome set_aside), P1b (a new job
-- reconsiders bucket rows, so a lead set aside before its job is placed when
-- the job arrives inside its window), the bucket reasons and the finish line.
-- No row moves at apply: a row changes only when it is inserted or decided
-- again (the guarded backfill in verify/evidence/20261103-c2-place/backfill).
-- Rollback: supabase/rollbacks/20261104202000_context_c2_empty_no_job_reason_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard: the helper is the live one above or this migration's (a
-- repeated apply), and the ladder is the one that sets a row aside with the
-- helper's reason.
DO $guard$
DECLARE problems text[]:='{}'; live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_empty_row_job(public.business_events)');
 IF live IS NULL OR live NOT IN ('130b29784228b2542306f5c0e5a5f0e7','b057fc7da940afe25833028d511594b5') THEN
  problems:=problems||format('context_empty_row_job md5 %s',coalesce(live,'<missing>'));
 END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)');
 IF live IS DISTINCT FROM 'f9cd8d311bf00a92f7b708ff2d2dc8a7' THEN
  problems:=problems||format('resolve_context_attribution md5 %s',coalesce(live,'<missing>'));
 END IF;
 IF to_regprocedure('public.context_bucket_reason(public.business_events)') IS NULL THEN
  problems:=problems||'context_bucket_reason missing'::text;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_c2_empty_no_job_reason_preimage_mismatch: %; build on the live bodies',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The helper.
CREATE OR REPLACE FUNCTION public.context_empty_row_job(e public.business_events)
 RETURNS TABLE(placed_job uuid, rule_name text, candidates uuid[], contact text, contact_by text, copy_of uuid, copy_status text, copy_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_at timestamptz:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
 c text; c_by text; ek text; pk text; nc int; ours boolean; pv text;
 tw_jobs uuid[]; tw_first uuid; tw_reasons text[]; tw_reason_first uuid; tw_other int;
 line text; ids uuid[]; line_ids uuid[]; guard_ids uuid[]; other_ids uuid[]; unpaid_ids uuid[]; window_ids uuid[];
 n int; cand uuid;
 -- C2 place (20261104202000).
 n_all int; n_before int; first_at timestamptz; e2 public.business_events; rsn text;
BEGIN
 -- A customer message only: the finish line's message kinds (row C2) in the
 -- customer lane, never crew or staff traffic.
 IF e.event_type IS NULL OR e.event_type NOT IN ('client.sms_out','client.sms_in','client.reply','client.call_logged',
   'client.call_complete','call.transcript_completed','client.email_in','client.email_out','client.email_forwarded',
   'client.call_initiated','client_comms.sent','sms_sent','staff.email_unknown_audience')
  OR public.context_unplaced_lane(e)<>'customer'
  OR coalesce(e.metadata->>'recipient_role','') IN ('crew','staff') THEN
  RETURN;
 END IF;
 ours:=public.context_event_is_ours(e);
 -- Who it is with: the row's contact; else the recipient our own tool wrote
 -- into the payload (to_contact_id, else contact_id); else exactly one
 -- contact for the row's email or phone key (the ladder's step 2).
 c:=nullif(btrim(e.contact_id),'');
 IF c IS NULL AND ours THEN
  c:=nullif(btrim(coalesce(e.payload->>'to_contact_id',e.payload->>'contact_id')),'');
  IF c !~ '^[A-Za-z0-9]{10,40}$' THEN c:=NULL; END IF;
  IF c IS NOT NULL THEN c_by:='payload_recipient'; END IF;
 END IF;
 SELECT i.email_key,i.phone_key INTO ek,pk FROM public.context_event_identity(e) i;
 IF c IS NULL AND (ek IS NOT NULL OR pk IS NOT NULL) THEN
  SELECT k.contact_id,k.contacts INTO c,nc FROM public.context_contact_for_key(ek,pk) k;
  IF nc=1 THEN
   c_by:=CASE WHEN ek IS NOT NULL AND (SELECT k2.contacts FROM public.context_contact_for_key(ek,NULL) k2)=1 THEN 'email' ELSE 'phone' END;
  ELSE
   c:=NULL;
  END IF;
 END IF;
 IF c IS NULL THEN
  RETURN QUERY SELECT NULL::uuid,CASE WHEN nc>1 THEN 'empty_identity_conflict' ELSE 'no_contact' END,NULL::uuid[],NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text;
  RETURN;
 END IF;
 -- Our own tool's copy of a message the CRM also captured (its twin: the same
 -- recipient contact, the same words, within 10 minutes, from another source,
 -- itself no copy) follows the twin: onto the one job its twins sit on, or
 -- the not-about-a-job reason its twin was set aside with.
 pv:=btrim(coalesce(e.payload->>'message_preview',e.payload->>'message',''));
 IF ours AND length(pv)>=10 THEN
  SELECT array_agg(DISTINCT x.job_id) FILTER (WHERE x.job_id IS NOT NULL),
   (array_agg(x.id ORDER BY coalesce(x.event_at,x.occurred_at),x.id) FILTER (WHERE x.job_id IS NOT NULL))[1],
   array_agg(DISTINCT x.metadata->>'bucket_reason') FILTER (WHERE x.job_id IS NULL AND x.attribution_status='admin_bucket'
    AND x.metadata->>'bucket_reason' IN ('contact_no_jobs','before_any_job','own_party','platform_sender')),
   (array_agg(x.id ORDER BY coalesce(x.event_at,x.occurred_at),x.id) FILTER (WHERE x.job_id IS NULL AND x.attribution_status='admin_bucket'
    AND x.metadata->>'bucket_reason' IN ('contact_no_jobs','before_any_job','own_party','platform_sender')))[1],
   count(*) FILTER (WHERE x.job_id IS NULL AND NOT coalesce(x.attribution_status='admin_bucket'
    AND x.metadata->>'bucket_reason' IN ('contact_no_jobs','before_any_job','own_party','platform_sender'),false))
  INTO tw_jobs,tw_first,tw_reasons,tw_reason_first,tw_other
  FROM public.business_events x
  WHERE x.contact_id=c AND x.id<>e.id AND x.source IS DISTINCT FROM e.source
   AND x.occurred_at BETWEEN v_at-interval '2 days' AND v_at+interval '2 days'
   AND coalesce(x.event_at,x.occurred_at) BETWEEN v_at-interval '10 minutes' AND v_at+interval '10 minutes'
   AND x.event_type IN ('client.sms_out','client.email_out','sms_sent','client_comms.sent')
   AND NOT (coalesce(x.metadata,'{}'::jsonb) ? 'placement_copy_of')
   AND position(left(pv,40) IN coalesce(public.context_event_text(x),''))>0;
  -- C2 place (20261104202000): only onto a job that can be a customer's
  -- (numbered, not a test, not holding). A twin its writer put on a holding
  -- or test record is not followed; the contact's own jobs decide below.
  IF cardinality(tw_jobs)=1 AND public.context_job_real(tw_jobs[1]) THEN
   RETURN QUERY SELECT tw_jobs[1],'twin_copy',NULL::uuid[],c,c_by,tw_first,NULL::text,NULL::text;
   RETURN;
  ELSIF coalesce(cardinality(tw_jobs),0)=0 AND cardinality(tw_reasons)=1 AND tw_other=0 THEN
   RETURN QUERY SELECT NULL::uuid,'twin_copy',NULL::uuid[],c,c_by,tw_reason_first,'admin_bucket'::text,tw_reasons[1];
   RETURN;
  END IF;
 END IF;
 -- The contact's jobs at the message time, read as the ladder's step 5 reads
 -- them (the four-argument timeline with the message's keys).
 line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
 SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
  coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
  coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
   AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
  coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='key_other_contact' AND t.candidate),'{}'),
  coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND t.unpaid_at
   AND t.created_at<=v_at),'{}'),
  coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND NOT t.unpaid_at
   AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '60 days'),'{}'),
  count(*),count(*) FILTER (WHERE t.created_at<=v_at),min(t.created_at)
 INTO ids,line_ids,guard_ids,other_ids,unpaid_ids,window_ids,n_all,n_before,first_at
 FROM public.context_contact_job_timeline(c,v_at,pk,ek) t;
 n:=cardinality(ids);
 IF n>0 AND cardinality(other_ids)>0 THEN
  -- A phone or email another contact's job also carries: never chosen.
  RETURN QUERY SELECT NULL::uuid,'empty_identity_conflict',ids||guard_ids,c,c_by,NULL::uuid,NULL::text,NULL::text;
 ELSIF n=1 AND cardinality(guard_ids)=0 THEN
  -- One job then, and no finished job beside it: that job, when it can be a
  -- customer's job (numbered, not a test, not holding).
  IF public.context_job_real(ids[1]) THEN
   RETURN QUERY SELECT ids[1],'empty_single_open',NULL::uuid[],c,c_by,NULL::uuid,NULL::text,NULL::text;
  ELSE
   RETURN QUERY SELECT NULL::uuid,'empty_no_real_job',ids,c,c_by,NULL::uuid,NULL::text,NULL::text;
  END IF;
 ELSIF n>1 AND cardinality(line_ids)=1 AND public.context_job_real(line_ids[1]) THEN
  RETURN QUERY SELECT line_ids[1],'empty_single_line',NULL::uuid[],c,c_by,NULL::uuid,NULL::text,NULL::text;
 ELSIF n>0 THEN
  -- Stage 1's ranking (context_rank_contact_set): exactly one job that can be
  -- a customer's left and no finished work beside it. Otherwise set aside,
  -- never guessed: several jobs at the message time, or one beside a
  -- recently finished one.
  SELECT r.job_id INTO cand FROM public.context_rank_contact_set(ids,guard_ids) r;
  IF cand IS NOT NULL THEN
   RETURN QUERY SELECT cand,'empty_ranked_open',NULL::uuid[],c,c_by,NULL::uuid,NULL::text,NULL::text;
  ELSE
   RETURN QUERY SELECT NULL::uuid,CASE WHEN n=1 THEN 'empty_recent_other_job' ELSE 'empty_several' END,ids||guard_ids,c,c_by,NULL::uuid,NULL::text,NULL::text;
  END IF;
 ELSIF cardinality(unpaid_ids)+cardinality(window_ids)>0 THEN
  -- After the work: aftercare never places (N7, N17); the finished jobs are named.
  RETURN QUERY SELECT NULL::uuid,'empty_after_job',unpaid_ids||window_ids,c,c_by,NULL::uuid,NULL::text,NULL::text;
 ELSE
  -- C2 place (20261104202000): no job then, and no finished job in the
  -- aftercare window. A message from a sender who has no job is not about a
  -- job: set aside with the reason a worded message gets here
  -- (context_bucket_reason with the contact), when the message's own keys
  -- agree. contact_no_jobs: no job of the contact's, and none carrying the
  -- message's phone or email (any contact's, contactless included).
  -- before_any_job: none of those existed at the message time and the first
  -- came more than 60 days after it (a worded message's only_open_job window;
  -- a nearer job is a possible lead, so the row is left for a person). Any
  -- other reason (only finished work, a job hint taken off, an error) leaves
  -- the row empty with its named rule as before.
  e2:=e; e2.contact_id:=c;
  rsn:=public.context_bucket_reason(e2);
  IF (rsn='contact_no_jobs' AND n_all=0)
   OR (rsn='before_any_job' AND n_before=0 AND first_at>v_at+interval '60 days') THEN
   RETURN QUERY SELECT NULL::uuid,'no_candidate_at_time',NULL::uuid[],c,c_by,NULL::uuid,'admin_bucket'::text,rsn;
  ELSE
   RETURN QUERY SELECT NULL::uuid,'no_candidate_at_time',NULL::uuid[],c,c_by,NULL::uuid,NULL::text,NULL::text;
  END IF;
 END IF;
END $function$
;
COMMENT ON FUNCTION public.context_empty_row_job(public.business_events) IS
 'C2 known contacts (20261104095000): for a customer message with no words (the finish line''s message kinds in the customer lane; never crew or staff traffic), who it is with (the row''s contact, else the recipient our own tool wrote in payload.to_contact_id or payload.contact_id, else exactly one contact for its email or phone key) and its job: a copy our own tool logged of a message the CRM also captured (same recipient, same first 40 characters, within 10 minutes, another source) follows its twin (twin_copy: the one job its twins sit on, or the not-about-a-job reason its twin was set aside with); else the contact''s one real job at the message time with no finished job beside it (empty_single_open), the one job of its business line (empty_single_line) or stage 1''s ranking (empty_ranked_open). Anything else is set aside with a named rule and its candidates: empty_several, empty_recent_other_job, empty_identity_conflict, empty_no_real_job, empty_after_job, no_candidate_at_time, no_contact. Never guesses; computes, never writes. No row for any other row. Read by resolve_context_attribution. Service role only. C2 place (20261104202000): a copy follows its twin only onto a job that can be a customer''s (context_job_real); a known contact''s message with no job then and no finished job in the aftercare window (no_candidate_at_time) is set aside as not about a job with the reason a worded message gets there (context_bucket_reason with the contact; returned as copy_status admin_bucket and copy_reason) when the message''s own keys agree: contact_no_jobs (no job of the contact''s and none carrying its phone or email) or before_any_job (none existed then and the first came more than 60 days later). Any other reason leaves it empty with the named rule.';
REVOKE ALL ON FUNCTION public.context_empty_row_job(public.business_events) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_empty_row_job(public.business_events) TO service_role;

-- 2. Post-check: the body is this migration's.
DO $post$
BEGIN
 IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_empty_row_job(public.business_events)'))<>'b057fc7da940afe25833028d511594b5' THEN
  RAISE EXCEPTION 'context_c2_empty_no_job_reason: the helper is not this migration''s body';
 END IF;
END $post$;
