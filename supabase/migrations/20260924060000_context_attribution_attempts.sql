-- A1-BE: safe attribution (INTEGRATION.md Wave 2, slice A1-BE; sms.md section
-- 4b rule 8; cadence.md section 6 step 7 and 9.A item 11).
--
-- A message the model cannot place gets one answer and rests, instead of being
-- asked about again every tick:
--   1. context_attribution_attempts: one row per event the attribution loop
--      asked about (attempts, asks today, last and next ask, outcome, last
--      error code, candidate hash). Written only by the two functions below,
--      through one private writer. Counts and codes only, never message text.
--   2. attribute_context_event_with_luna(uuid,uuid,numeric,text): the outcome
--      argument. 'job' places the row (confidence at least 0.8, otherwise it
--      rests as 'undecided'); 'several' and 'undecided' set the resting status
--      'unplaced', keep candidate_job_ids and record metadata.luna_outcome.
--      The legacy three-argument function is NOT touched: the deployed runtime
--      keeps calling it, with exactly today's behaviour, until A1-RT sends the
--      outcome. PostgreSQL overloads by argument count and the new one has no
--      default, so the two never collide (PostgREST matches by argument names).
--   3. record_attribution_error(uuid,text): a model or RPC failure is recorded
--      against its row with backoff (30 minutes, then 2 hours, then the next
--      Perth day; at most 2 asks per row per Perth day unless the row's
--      candidate list changed). It never raises for a known event, so a row
--      error never has to fail the worker's tick.
--   4. context_attribution_due(integer): the read side of the attempt record,
--      the pending_luna rows an ask is allowed for now, oldest first. Paging in
--      SQL means rows waiting on backoff can never hide newer rows behind them.
--   5. reserve_context_model_call: attribution gets its own sub-budget of 60 of
--      the 400 daily model calls. Beyond it the reservation is refused with
--      outcome 'attribution_budget' and nothing is reserved.
--
-- No flag or switch changes. No existing row is written or rewritten.
--
-- Built on the LIVE production definitions, read from production 23 Sep 2026
-- (read-only):
--   reserve_context_model_call(text,uuid,uuid)  md5(prosrc) 569a31f3e75c7e5e5e75e85cc628adde
--     = the 20260911170001 body. The only replaced object.
--   context_contact_jobs(text)                  md5(prosrc) 110233fcc96446fdcf1f50d1fa65c43c
--     = the 20260921140000 body. Read by the job path, not replaced.
--   attribute_context_event_with_luna(uuid,uuid,numeric)
--                                               md5(prosrc) 48eabf7e132092cd225ff5060ce58846
--     NOT the repository body (c19a54cb...): hand-applied by ledger row
--     20260914012038 b2_context_attribution_fns, which differs from the
--     20260911171000 body only by one missing comment line ("A racing reply
--     follows the thread winner"). Same behaviour. Not replaced; the new
--     overload's job path is that live body's job path.
--   context_attribution_attempts, record_attribution_error and the other new
--   names: absent.
-- The guard refuses unless each is still that pre-image (or, for replaced and
-- new objects, already this migration's body on a re-apply).
-- Rollback: supabase/rollbacks/20260924060000_context_attribution_attempts_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: live pre-image, or this migration's body.
  ('public.reserve_context_model_call(text,uuid,uuid)',ARRAY['569a31f3e75c7e5e5e75e85cc628adde','86bfd48365b6aa26c4400ec2b5d476c3'],false),
  -- Read by the new function, not replaced: must still be the live body.
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric)',ARRAY['48eabf7e132092cd225ff5060ce58846'],false),
  ('public.context_contact_jobs(text)',ARRAY['110233fcc96446fdcf1f50d1fa65c43c'],false),
  -- New: absent, or already this migration's body.
  ('public.context_attribution_candidate_hash(public.business_events)',ARRAY['4b606a8d60a731593ae433fe4288895b'],true),
  ('public.context_attribution_next_perth_day(timestamptz)',ARRAY['cf6272dd8b9999f5dbe55b3bb1f47909'],true),
  ('public.context_attribution_record_attempt(public.business_events,text,text)',ARRAY['a5b5009535543486c63e2f7f2c2d5552'],true),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric,text)',ARRAY['407832111a538b414897fa0b359232d2'],true),
  ('public.record_attribution_error(uuid,text)',ARRAY['e1b568e2242bb956647d0af36d6a0d4b'],true),
  ('public.context_attribution_due(integer)',ARRAY['47a19f03f58470e29642ff84eec7c4be'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- Any other overload of the two public entry points is a live change nobody read.
 FOR x IN SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('attribute_context_event_with_luna','record_attribution_error','context_attribution_due','reserve_context_model_call')
  AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' NOT IN (
   'attribute_context_event_with_luna(p_event_id uuid, p_job_id uuid, p_confidence numeric)',
   'attribute_context_event_with_luna(p_event_id uuid, p_job_id uuid, p_confidence numeric, p_outcome text)',
   'record_attribution_error(p_event_id uuid, p_code text)',
   'context_attribution_due(p_limit integer)',
   'reserve_context_model_call(p_phase text, p_run_id uuid, p_lease_token uuid)') LOOP
  problems:=problems||format('unexpected overload %s',x.sig);
 END LOOP;
 -- The attempt table, if present, must be this migration's shape.
 IF to_regclass('public.context_attribution_attempts') IS NOT NULL AND (
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_attribution_attempts') AND a.attnum>0 AND NOT a.attisdropped)
  IS DISTINCT FROM 'event_id:uuid,attempts:integer,asks_date:date,asks_on_date:integer,last_at:timestamp with time zone,next_at:timestamp with time zone,outcome:text,last_code:text,candidate_hash:text,updated_at:timestamp with time zone'
 THEN problems:=problems||'context_attribution_attempts exists with another shape'::text; END IF;
 -- The resting status must exist (F1).
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.business_events'::regclass
   AND c.conname='business_events_attribution_status_check' AND pg_get_constraintdef(c.oid) LIKE '%''unplaced''::text%')
 THEN problems:=problems||'business_events_attribution_status_check does not allow unplaced (F1 not applied)'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_attribution_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The attempt record. One row per event the attribution loop asked about.
CREATE TABLE IF NOT EXISTS public.context_attribution_attempts (
 event_id uuid PRIMARY KEY REFERENCES public.business_events(id) ON DELETE CASCADE,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 asks_date date,
 asks_on_date integer NOT NULL DEFAULT 0 CHECK (asks_on_date >= 0),
 last_at timestamptz,
 next_at timestamptz,
 outcome text CHECK (outcome IN ('job','several','undecided','error')),
 last_code text CHECK (last_code IS NULL OR last_code ~ '^[a-z0-9_.:-]{1,64}$'),
 candidate_hash text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.context_attribution_attempts IS
 'Attribution asks per business_events row: attempts under the current candidate list, asks on the current Perth day, last and next allowed ask, last outcome and error code. Written only by attribute_context_event_with_luna(uuid,uuid,numeric,text) and record_attribution_error. service_role may read. Counts and codes, never message text.';
CREATE INDEX IF NOT EXISTS context_attribution_attempts_next_at
 ON public.context_attribution_attempts (next_at) WHERE next_at IS NOT NULL;
ALTER TABLE public.context_attribution_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_attribution_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.context_attribution_attempts TO service_role;

-- 2. Helpers.
-- The row's candidate list as it stands: the stored list when the placement
-- track wrote one, otherwise the contact's open jobs (the list the legacy
-- guard checks today). A change in it re-allows an ask the same day.
CREATE OR REPLACE FUNCTION public.context_attribution_candidate_hash(e public.business_events) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT md5(coalesce(string_agg(c.id::text,',' ORDER BY c.id::text),''))
 FROM (
  SELECT DISTINCT s.id FROM unnest(e.candidate_job_ids) AS s(id) WHERE e.candidate_job_ids IS NOT NULL
  UNION
  SELECT j.id FROM public.context_contact_jobs(e.contact_id) j WHERE e.candidate_job_ids IS NULL
 ) c
$$;

-- Start of the next Perth calendar day after p_at.
CREATE OR REPLACE FUNCTION public.context_attribution_next_perth_day(p_at timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT (date_trunc('day',p_at AT TIME ZONE 'Australia/Perth')+interval '1 day') AT TIME ZONE 'Australia/Perth'
$$;

-- The one writer of context_attribution_attempts. Private: callable only by
-- the two SECURITY DEFINER entry points below.
--   p_outcome 'error': attempts+1; next ask after 30 minutes, then 2 hours,
--   then the next Perth day.
--   p_outcome job/several/undecided: the row was answered; no backoff.
-- Either way, a row asked twice on one Perth day under an unchanged candidate
-- list waits for the next Perth day. A changed candidate list starts afresh.
CREATE OR REPLACE FUNCTION public.context_attribution_record_attempt(e public.business_events,p_outcome text,p_code text)
RETURNS public.context_attribution_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.context_attribution_attempts; v_now timestamptz:=clock_timestamp();
 v_date date:=(clock_timestamp() AT TIME ZONE 'Australia/Perth')::date; v_hash text; v_attempts integer; v_asks integer; v_next timestamptz;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('job','several','undecided','error') THEN RAISE EXCEPTION 'invalid attempt outcome'; END IF;
 v_hash:=public.context_attribution_candidate_hash(e);
 SELECT * INTO a FROM public.context_attribution_attempts WHERE event_id=e.id FOR UPDATE;
 IF FOUND AND a.candidate_hash IS NOT DISTINCT FROM v_hash THEN
  v_attempts:=a.attempts+1;
  v_asks:=CASE WHEN a.asks_date=v_date THEN a.asks_on_date+1 ELSE 1 END;
 ELSE
  v_attempts:=1; v_asks:=1;
 END IF;
 v_next:=CASE WHEN p_outcome='error' THEN
   CASE v_attempts WHEN 1 THEN v_now+interval '30 minutes' WHEN 2 THEN v_now+interval '2 hours'
    ELSE public.context_attribution_next_perth_day(v_now) END END;
 IF v_asks>=2 THEN v_next:=greatest(coalesce(v_next,'-infinity'::timestamptz),public.context_attribution_next_perth_day(v_now)); END IF;
 INSERT INTO public.context_attribution_attempts AS t(event_id,attempts,asks_date,asks_on_date,last_at,next_at,outcome,last_code,candidate_hash,updated_at)
 VALUES(e.id,v_attempts,v_date,v_asks,v_now,v_next,p_outcome,p_code,v_hash,v_now)
 ON CONFLICT (event_id) DO UPDATE SET attempts=EXCLUDED.attempts,asks_date=EXCLUDED.asks_date,asks_on_date=EXCLUDED.asks_on_date,
  last_at=EXCLUDED.last_at,next_at=EXCLUDED.next_at,outcome=EXCLUDED.outcome,last_code=EXCLUDED.last_code,
  candidate_hash=EXCLUDED.candidate_hash,updated_at=EXCLUDED.updated_at
 RETURNING * INTO a;
 RETURN a;
END $$;

-- 3. The outcome argument. The job path keeps the legacy guard and thread
-- binding exactly; the placement slices (P1a) change the guard, in both
-- overloads, when they land.
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
  IF NOT EXISTS (SELECT 1 FROM public.context_contact_jobs(e.contact_id) WHERE id=p_job_id) THEN RAISE EXCEPTION 'job is not a contact candidate'; END IF;
  IF p_confidence<0.8 THEN
   -- Below the floor: honestly unknown beats confidently wrong. Rest it.
   v_outcome:='undecided';
   v_note:=jsonb_build_object('luna_outcome','undecided','luna_outcome_at',v_now,
    'luna_below_floor',jsonb_build_object('job_id',p_job_id,'confidence',p_confidence));
  END IF;
 END IF;
 IF v_outcome='job' THEN
  chosen:=p_job_id;
  IF nullif(e.thread_key,'') IS NOT NULL THEN
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
COMMENT ON FUNCTION public.attribute_context_event_with_luna(uuid,uuid,numeric,text) IS
 'Luna''s answer for a pending_luna row. job: place it (confidence at least 0.8, else it rests as undecided). several or undecided: rest it as unplaced with candidate_job_ids kept and metadata.luna_outcome recorded. Records the ask in context_attribution_attempts.';

-- 4. A failed ask, recorded against its row. Raises only for a bad call (no
-- such event, malformed code), never for the row's own state.
CREATE OR REPLACE FUNCTION public.record_attribution_error(p_event_id uuid,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; a public.context_attribution_attempts;
BEGIN
 IF p_code IS NULL OR p_code !~ '^[a-z0-9_.:-]{1,64}$' THEN RAISE EXCEPTION 'invalid attribution error code'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;
 a:=public.context_attribution_record_attempt(e,'error',p_code);
 RETURN jsonb_build_object('event_id',a.event_id,'attempts',a.attempts,'asks_on_date',a.asks_on_date,
  'next_at',a.next_at,'outcome',a.outcome,'last_code',a.last_code);
END $$;
COMMENT ON FUNCTION public.record_attribution_error(uuid,text) IS
 'Records a failed attribution ask (model or RPC error code, lowercase, at most 64 characters) against its row with backoff: 30 minutes, 2 hours, then the next Perth day; at most 2 asks a Perth day unless the candidate list changed.';

-- 5. Rows an ask is allowed for now, oldest first. Empty while the
-- attribution lane is off.
CREATE OR REPLACE FUNCTION public.context_attribution_due(p_limit integer DEFAULT 50) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.* FROM public.business_events e
 LEFT JOIN public.context_attribution_attempts a ON a.event_id=e.id
 WHERE public.automation_lane_enabled('attribution') AND e.attribution_status='pending_luna'
  AND (a.event_id IS NULL OR a.next_at IS NULL OR a.next_at<=clock_timestamp()
   OR a.candidate_hash IS DISTINCT FROM public.context_attribution_candidate_hash(e))
 ORDER BY e.occurred_at,e.id
 LIMIT greatest(0,least(coalesce(p_limit,50),200))
$$;
COMMENT ON FUNCTION public.context_attribution_due(integer) IS
 'pending_luna rows the attribution loop may ask about now: never asked, or past their next_at, or their candidate list changed. Oldest first, at most 200.';

-- 6. Attribution sub-budget: 60 of the 400 daily model calls. The body is the
-- live one with one added refusal after the daily cap check, before the insert.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase='extraction' AND p_run_id IS NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END)
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END)
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF p_run_id IS NOT NULL THEN
  SELECT * INTO r FROM public.context_extraction_runs WHERE id=p_run_id FOR UPDATE;
 END IF;
 v_now := clock_timestamp();
 v_date := (v_now AT TIME ZONE 'Australia/Perth')::date;
 IF p_run_id IS NOT NULL AND (r.id IS NULL OR r.lease_token IS DISTINCT FROM p_lease_token
 OR r.phase IS DISTINCT FROM p_phase OR r.status <> 'running'
 OR r.lease_expires_at IS NULL OR r.lease_expires_at <= v_now OR r.run_date <> v_date)
 THEN RETURN jsonb_build_object('outcome','stale'); END IF;
 SELECT coalesce(max(ordinal),0)+1 INTO v_ordinal FROM public.context_model_call_reservations WHERE run_date=v_date;
 IF v_ordinal>400 THEN RETURN jsonb_build_object('outcome','cap'); END IF;
 -- A1: attribution may use at most 60 of the day's 400 calls.
 IF p_phase='attribution' AND (SELECT count(*) FROM public.context_model_call_reservations
   WHERE run_date=v_date AND phase='attribution')>=60
 THEN RETURN jsonb_build_object('outcome','attribution_budget','run_date',v_date,'limit',60); END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $$;

-- 7. Grants: nothing reachable by the public key or a signed-in login.
REVOKE ALL ON FUNCTION
 public.context_attribution_candidate_hash(public.business_events),
 public.context_attribution_next_perth_day(timestamptz),
 public.context_attribution_record_attempt(public.business_events,text,text),
 public.attribute_context_event_with_luna(uuid,uuid,numeric,text),
 public.record_attribution_error(uuid,text),
 public.context_attribution_due(integer),
 public.reserve_context_model_call(text,uuid,uuid)
FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.context_attribution_record_attempt(public.business_events,text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION
 public.attribute_context_event_with_luna(uuid,uuid,numeric,text),
 public.record_attribution_error(uuid,text),
 public.context_attribution_due(integer),
 public.reserve_context_model_call(text,uuid,uuid)
TO service_role;
