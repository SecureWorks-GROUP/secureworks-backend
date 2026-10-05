-- The job ledger store: the only way anything is written into the ledger
-- (story slice B2, 6 Oct 2026; contract section 6).
--
-- Why. The ledger tables (20261006010000) hold what a reader found in a job's
-- whole history: promises, requests, claims, issues, constraints,
-- dependencies, agreements, events no record shows and phase notes, each
-- cited to the rows that opened it and closed only by evidence. This
-- migration adds the custody around them, so a model can only write what the
-- evidence on the job says, people's corrections are never overwritten, and
-- the ledger never spends the model calls the live fact pass needs.
--
-- What it does:
--  1. Budget. context_extraction_runs and context_model_call_reservations
--     admit the phase 'ledger'. reserve_context_model_call (the one admission
--     every model call goes through) is the live body (20261006001000, the
--     vision slice) plus one block: a ledger call needs a running ledger run
--     holding its lease (the existing stale rule), the extraction lane on,
--     context_ledger_settings.mode not off (else ledger_off), fewer than
--     calls_per_day ledger calls today, and the day's calls below the
--     ledger's own live reserve line (context_ledger_settings, apart from the
--     fact backlog's context_cadence_settings, so slowing the backlog never
--     starves the ledger): model_call_cap less live_reserve_calls all day,
--     and morning_cap less live_reserve_calls_morning before morning_until
--     (else ledger_budget). Every other phase takes exactly the path it took
--     before.
--  2. context_ledger_evidence_rows(job ids, as_of): the admissible worded
--     evidence of a set of jobs, one definition for the due list, the packet
--     and the write. business_events on the job, linked, admissible, written
--     as service_role, worded, not status-only, of a message kind (texts,
--     emails, calls, transcripts, notes, document text), plus legacy
--     inbox_events mail on the job or from the client's address that has no
--     business_events copy. Copies of one message (same channel, direction,
--     sender address and words within 120 seconds) are marked, never changed.
--  3. context_ledger_due(limit): jobs a ledger reader should read now. When
--     context_ledger_settings.job_ids is set (a staged start), only those
--     jobs: the judgement blocks every other job as not_in_rollout.
--  4. context_ledger_claim(job, kind, run_date): a ledger run (phase ledger,
--     30-minute lease) and, for a backfill or rebuild, a building generation.
--  5. context_ledger_packet(job, since, as_of): everything the reader sees
--     except the record text (ledger-packet-v1).
--  6. context_ledger_write(run, lease, generation, items, transitions,
--     reader): the custody checks; accepted items are inserted whole, refused
--     items are reported with a code, a repeated request returns its first
--     answer (context_ledger_writes keeps the receipt).
--  7. context_ledger_finish(run, lease, generation, outcome, meta): closes
--     the run; built -> shadow, carries people's corrections forward, and
--     promotes when the lane is live and the checks pass.
--  8. context_ledger_promote(generation, by): shadow -> live, the previous
--     live -> retired, people's corrections carried forward. The one rule for
--     promoting without a person is context_ledger_checks_pass.
--     context_ledger_promote_shadow(by, jobs, limit): bulk go-live, each job's
--     newest passing shadow promoted once the lane is live.
--  9. context_ledger_person_edit(job, user, action, key, note, item): staff
--     corrections on the live ledger (close, reopen, dispute, add); each one
--     locks the item against the model.
--
-- Unchanged: the fact pass. Every reader of context_extraction_runs filters
-- phase 'extraction' (context_jobs_cadence runs, context_catchup_mark_done,
-- context_cadence_status, context_core_status, context_extraction_event_flags,
-- the catch-up and read-request writers), so a ledger run moves no runs_today,
-- no catch-up completion, no freshness line and no lease. Ledger reservations
-- count toward the shared daily total, as every phase does. No flag, switch
-- or settings value is changed: the ledger stays off until the owner sets
-- context_ledger_settings.mode. No business_events row is written.
--
-- Replaces one function: reserve_context_model_call(text,uuid,uuid) (live md5
-- f50de57b906f28fc9b5b286821d64cb1, the 20261006001000 body), and widens two
-- CHECK constraints (the phase lists of the runs and the reservations).
--
-- Rollback: supabase/rollbacks/20261006013000_context_ledger_store_down.sql
-- (deletes ledger reservations and ledger runs, restores the vision body and
-- both phase checks, drops the store functions and the receipts table; the
-- ledger tables and their rows stay).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; chk text; f text; t text;
BEGIN
 -- The one replaced function: the live vision body, or this migration's (re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)',
   ARRAY['f50de57b906f28fc9b5b286821d64cb1','28545c710b6234b76ba25eb09093fa39'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Functions read, never replaced: they must exist with these signatures.
 FOREACH f IN ARRAY ARRAY['public.context_event_text(public.business_events)',
  'public.context_event_source_admissible(public.business_events)',
  'public.context_event_status_only(public.business_events)',
  'public.context_event_is_ours(public.business_events)',
  'public.context_internal_text_role(public.business_events)',
  'public.context_linked_status(text)',
  'public.context_supported_due_date(text,timestamptz)',
  'public.automation_lane_enabled(text)',
  'public.context_cadence_policy()'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 -- The ledger model (20261006010000) and the live reserve settings (20261005233000).
 FOREACH t IN ARRAY ARRAY['public.context_ledger_generations','public.context_ledger_items',
   'public.context_ledger_transitions','public.context_ledger_settings'] LOOP
  IF to_regclass(t) IS NULL OR coalesce(obj_description(to_regclass(t), 'pg_class'), '') NOT LIKE 'Context ledger:%' THEN
   problems := problems || format('%s missing or not the ledger model''s (apply 20261006010000 first)', t);
  END IF;
 END LOOP;
 -- The settings this store reads beyond the first cut: the rollout list and the ledger's own live reserve.
 FOREACH f IN ARRAY ARRAY['job_ids', 'live_reserve_calls', 'live_reserve_calls_morning', 'backfill_from_hour', 'backfill_to_hour'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.context_ledger_settings')
    AND a.attname = f AND NOT a.attisdropped) THEN
   problems := problems || format('public.context_ledger_settings.%s missing (apply the ledger model 20261006010000 as it is now)', f);
  END IF;
 END LOOP;
 IF to_regclass('public.inbox_events') IS NULL OR to_regclass('public.users') IS NULL THEN
  problems := problems || 'public.inbox_events or public.users missing'::text;
 END IF;
 -- The two phase lists: as live, already widened by this migration, or narrowed
 -- NOT VALID by its rollback (which keeps the ledger's runs and calls).
 SELECT string_agg(pg_get_constraintdef(c.oid), ' | ') INTO chk FROM pg_constraint c
 WHERE c.conrelid = 'public.context_extraction_runs'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%phase = ANY%';
 IF chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$c$
  AND chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text]))) NOT VALID$c$
  AND chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'ledger'::text])))$c$ THEN
  problems := problems || format('context_extraction_runs phase check is %s', coalesce(chk, '<missing>'));
 END IF;
 SELECT string_agg(pg_get_constraintdef(c.oid), ' | ') INTO chk FROM pg_constraint c
 WHERE c.conrelid = 'public.context_model_call_reservations'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%phase = ANY%';
 IF chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text])))$c$
  AND chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text]))) NOT VALID$c$
  AND chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$c$ THEN
  problems := problems || format('context_model_call_reservations phase check is %s', coalesce(chk, '<missing>'));
 END IF;
 -- New objects: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('context_ledger_text_norm','context_ledger_message_kind',
   'context_ledger_row_admissible','context_ledger_evidence_rows','context_ledger_current_generation',
   'context_ledger_judge','context_ledger_due','context_ledger_claim','context_ledger_packet','context_ledger_cite','context_ledger_check_item',
   'context_ledger_write','context_ledger_carry_forward','context_ledger_promote','context_ledger_finish',
   'context_ledger_person_edit','context_ledger_checks_pass','context_ledger_promote_shadow','context_ledger_failures',
   'context_ledger_budget','context_ledger_backfill_open') LOOP
  IF x.c NOT LIKE 'Context ledger store%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF to_regclass('public.context_ledger_writes') IS NOT NULL
  AND coalesce(obj_description(to_regclass('public.context_ledger_writes'), 'pg_class'), '') NOT LIKE 'Context ledger store:%' THEN
  problems := problems || 'public.context_ledger_writes exists and is not this migration''s'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_store_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The phase lists admit 'ledger' (drop and re-add only the expected definition).
DO $chk$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_extraction_runs'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) IN ($d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$d$,
    $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text]))) NOT VALID$d$) LOOP
  EXECUTE format('ALTER TABLE public.context_extraction_runs DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_extraction_runs'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'ledger'::text])))$d$) THEN
  ALTER TABLE public.context_extraction_runs ADD CONSTRAINT context_extraction_runs_phase_check
   CHECK (phase IN ('attribution','extraction','bucket','ledger'));
 END IF;
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) IN ($d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text])))$d$,
    $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text]))) NOT VALID$d$) LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$d$) THEN
  ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
   CHECK (phase IN ('attribution','extraction','bucket','vision','ledger'));
 END IF;
END $chk$;

-- 2. The admission: the 20261006001000 body plus the ledger block (marked
-- "ledger"). The ledger needs a run (like extraction) and the extraction lane.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
 v_ledger_mode text; v_ledger_calls integer; v_pol jsonb; v_calls integer; v_reserve_day integer; v_reserve_morning integer;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket','vision','ledger')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase IN ('extraction','ledger') AND p_run_id IS NULL)
 OR (p_phase='vision' AND p_run_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
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
 -- ledger: only while the lane is switched on, within its own daily ceiling,
 -- and never inside its own live reserve (context_ledger_settings, all day and
 -- before noon), whatever reserve the fact backlog keeps.
 IF p_phase='ledger' THEN
  -- plain variables, read only here: no other phase depends on the ledger table
  SELECT st.mode, st.calls_per_day, st.live_reserve_calls, st.live_reserve_calls_morning
  INTO v_ledger_mode, v_ledger_calls, v_reserve_day, v_reserve_morning FROM public.context_ledger_settings st WHERE st.id;
  IF v_ledger_mode IS NULL OR v_ledger_mode='off' THEN RETURN jsonb_build_object('outcome','ledger_off'); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='ledger')>=v_ledger_calls
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','ledger_calls_per_day','run_date',v_date,'limit',v_ledger_calls); END IF;
  v_pol := public.context_cadence_policy();
  SELECT count(*) INTO v_calls FROM public.context_model_call_reservations WHERE run_date=v_date;
  IF v_calls>=(v_pol->>'model_call_cap')::integer-v_reserve_day
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve','run_date',v_date,
   'ceiling',(v_pol->>'model_call_cap')::integer-v_reserve_day); END IF;
  IF (v_now AT TIME ZONE 'Australia/Perth')::time<(v_pol->>'morning_until')::time
   AND v_calls>=(v_pol->>'morning_cap')::integer-v_reserve_morning
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve_morning','run_date',v_date,
   'ceiling',(v_pol->>'morning_cap')::integer-v_reserve_morning); END IF;
 END IF;
 -- B-5b: vision only while the job reads keep their share, and within its own daily cap.
 IF p_phase='vision' THEN
  IF v_ordinal>(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer
  THEN RETURN jsonb_build_object('outcome','vision_reserve','run_date',v_date,
   'ceiling',(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='vision')
   >=public.context_document_vision_daily_cap()
  THEN RETURN jsonb_build_object('outcome','vision_budget','run_date',v_date,'limit',public.context_document_vision_daily_cap()); END IF;
 END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $$;
REVOKE ALL ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) TO service_role;
COMMENT ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) IS
 'The one admission for every context model call (400 a Perth day). Attribution at most 60; vision within its share and daily cap (20261006001000); ledger (20261006013000) only while context_ledger_settings.mode is not off, under calls_per_day, and never inside its own live reserve (model_call_cap less context_ledger_settings.live_reserve_calls; before morning_until morning_cap less live_reserve_calls_morning), apart from the fact backlog''s context_cadence_settings. Outcomes reserved, paused, stale, cap, attribution_budget, vision_reserve, vision_budget, ledger_off, ledger_budget.';

-- 2b. The ledger's budget as the admission would answer it, so a worker can
-- hold before it claims instead of burning a claim on a refused call.
CREATE OR REPLACE FUNCTION public.context_ledger_budget()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.context_ledger_settings; v_pol jsonb; v_now timestamptz := clock_timestamp(); v_local timestamp; v_date date;
 v_total integer; v_max integer; v_ledger integer; r_cap integer; r_day integer; r_live integer; r_morning integer;
 v_left integer; v_reason text; v_midnight timestamptz; v_resets timestamptz; v_window jsonb;
BEGIN
 v_local := v_now AT TIME ZONE 'Australia/Perth';
 v_date := v_local::date;
 v_midnight := (v_date + 1)::timestamp AT TIME ZONE 'Australia/Perth';
 SELECT * INTO s FROM public.context_ledger_settings WHERE id;
 -- the backfill hours: backfills and rebuilds wait outside them, updates never do
 v_window := jsonb_build_object('backfill_window', jsonb_build_object('from_hour', s.backfill_from_hour, 'to_hour', s.backfill_to_hour,
  'open', public.context_ledger_backfill_open(s.backfill_from_hour, s.backfill_to_hour, v_now)));
 -- The admission's own order: lane, the 400 cap, the switch, the ledger's
 -- daily ceiling, its live reserve all day, then before morning_until.
 IF NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('mode', coalesce(s.mode, 'off'), 'lane_on', false, 'calls_left', 0, 'reason', 'lane_off', 'resets_at', NULL) || v_window;
 END IF;
 v_pol := public.context_cadence_policy();
 SELECT count(*)::integer, coalesce(max(m.ordinal), 0)::integer, (count(*) FILTER (WHERE m.phase = 'ledger'))::integer
 INTO v_total, v_max, v_ledger FROM public.context_model_call_reservations m WHERE m.run_date = v_date;
 r_cap := 400 - v_max;
 IF r_cap <= 0 THEN
  RETURN jsonb_build_object('mode', coalesce(s.mode, 'off'), 'lane_on', true, 'calls_left', 0, 'reason', 'cap', 'resets_at', v_midnight) || v_window;
 END IF;
 IF s.id IS NULL OR s.mode = 'off' THEN
  RETURN jsonb_build_object('mode', 'off', 'lane_on', true, 'calls_left', 0, 'reason', 'ledger_off', 'resets_at', NULL) || v_window;
 END IF;
 r_day := s.calls_per_day - v_ledger;
 r_live := ((v_pol ->> 'model_call_cap')::integer - s.live_reserve_calls) - v_total;
 IF v_local::time < (v_pol ->> 'morning_until')::time THEN
  r_morning := ((v_pol ->> 'morning_cap')::integer - s.live_reserve_calls_morning) - v_total;
 END IF;
 v_left := greatest(0, least(r_cap, r_day, r_live, coalesce(r_morning, r_cap)));
 v_reason := CASE WHEN r_day <= 0 THEN 'ledger_calls_per_day' WHEN r_live <= 0 THEN 'live_reserve'
  WHEN r_morning <= 0 THEN 'live_reserve_morning' END;
 -- The line that binds resets with it: the morning line at morning_until,
 -- every other line at the next Perth midnight.
 v_resets := CASE WHEN r_morning IS NOT NULL AND r_morning <= least(r_cap, r_day, r_live)
  THEN (v_date + (v_pol ->> 'morning_until')::time) AT TIME ZONE 'Australia/Perth' ELSE v_midnight END;
 RETURN jsonb_build_object('mode', s.mode, 'lane_on', true, 'calls_left', v_left, 'reason', v_reason, 'resets_at', v_resets) || v_window;
END $$;
COMMENT ON FUNCTION public.context_ledger_budget() IS
 'Context ledger store (20261006013000): the ledger''s budget now, as reserve_context_model_call''s ledger branch would answer: {mode, lane_on, calls_left, reason, resets_at}. calls_left is the smallest of what is left under the 400 cap, the ledger''s calls_per_day, its own live reserve line (model_call_cap less live_reserve_calls) and, before morning_until, its morning line (morning_cap less live_reserve_calls_morning). reason, when nothing is left, in the admission''s order: lane_off, cap, ledger_off, ledger_calls_per_day, live_reserve, live_reserve_morning; null while calls are left. resets_at: morning_until when the morning line binds, else the next Perth midnight; null when switched off. backfill_window: {from_hour, to_hour, open} (Perth; both null = any time): backfills and rebuilds wait outside it, updates never do. Service role only.';

-- 3. Write receipts: one row per distinct write request, so a retried write
-- returns its first answer and finish can count refusals.
CREATE TABLE IF NOT EXISTS public.context_ledger_writes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL REFERENCES public.context_extraction_runs(id),
 generation_id uuid NOT NULL REFERENCES public.context_ledger_generations(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
 items_accepted integer NOT NULL DEFAULT 0 CHECK (items_accepted >= 0),
 items_refused integer NOT NULL DEFAULT 0 CHECK (items_refused >= 0),
 transitions_accepted integer NOT NULL DEFAULT 0 CHECK (transitions_accepted >= 0),
 transitions_refused integer NOT NULL DEFAULT 0 CHECK (transitions_refused >= 0),
 result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (run_id, request_sha256)
);
CREATE INDEX IF NOT EXISTS context_ledger_writes_generation ON public.context_ledger_writes (generation_id, created_at);
COMMENT ON TABLE public.context_ledger_writes IS
 'Context ledger store: one receipt per distinct context_ledger_write request (20261006013000): counts of accepted and refused items and transitions and the answer returned. A repeated identical request in the same run returns the stored answer. Refusal codes and refs only, never message text. Service role read only; written only by context_ledger_write.';
ALTER TABLE public.context_ledger_writes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ledger_writes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_ledger_writes TO service_role;

-- 4. Per-row helpers (no SET clause, so they inline; never to_jsonb() a row).
-- Whitespace collapsed, curly quotes straightened: how excerpts are compared.
CREATE OR REPLACE FUNCTION public.context_ledger_text_norm(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT btrim(regexp_replace(translate(coalesce(p_text, ''),
  U&'\2018\2019\201A\201B\2032\201C\201D\201E\201F\2033\00A0', '''''''''''""""" '), '\s+', ' ', 'g'))
$$;
COMMENT ON FUNCTION public.context_ledger_text_norm(text) IS
 'Context ledger store (20261006013000): text with curly quotes straightened, non-breaking spaces made plain and whitespace collapsed. Excerpts are compared to evidence text after this, case kept.';

-- A message kind: texts, emails, calls and call logs, transcripts, notes,
-- document text. Record rows (quotes, invoices, statuses, bookings) are read
-- from the record layer, not from here.
CREATE OR REPLACE FUNCTION public.context_ledger_message_kind(e public.business_events) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(
  (e.channel IN ('sms','email','call','note','document')
   OR e.event_type IN ('client.reply','client.sms_in','client.sms_out','client.email_in','client.email_out',
    'client.call_logged','client.message_in','call.transcript_completed','note.added','ghl.internal_comment',
    'document.text_extracted','supplier.email_in','staff.email_internal'))
  AND e.event_type !~ '^(invoice|quote|job|payment|po|schedule|assignment|trade|booking|scope|makesafe|variation|opportunity|proposed_action)\.',
  false)
$$;
COMMENT ON FUNCTION public.context_ledger_message_kind(public.business_events) IS
 'Context ledger store (20261006013000): true for the message kinds the ledger reads (texts, emails, calls and call logs, transcripts, notes, document text); record families are read from the record layer instead.';

-- Admissible worded evidence on its job: linked, admissible (on its own job,
-- source time, confidence, not retracted), written as service_role, worded,
-- not status-only, a message kind.
CREATE OR REPLACE FUNCTION public.context_ledger_row_admissible(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT coalesce(
  e.job_id IS NOT NULL
  AND public.context_linked_status(e.attribution_status)
  AND coalesce(e.metadata OPERATOR(pg_catalog.->>) 'written_as', 'service_role') OPERATOR(pg_catalog.=) 'service_role'
  AND pg_catalog.btrim(public.context_event_text(e)) OPERATOR(pg_catalog.<>) ''
  AND public.context_event_source_admissible(e)
  AND NOT public.context_event_status_only(e)
  AND public.context_ledger_message_kind(e),
  false)
$$;
COMMENT ON FUNCTION public.context_ledger_row_admissible(public.business_events) IS
 'Context ledger store (20261006013000): a business_events row the ledger reader may read and cite as evidence: placed and linked, admissible, written as service_role, worded, not status-only, a message kind.';

-- The one verdict for promoting without a person: checks.passed, which
-- finish computes (both sides' refusals at most 20% of what was proposed, the
-- store's own at most 20%, a build with at least one item unless there was no
-- evidence, and after an update the build's and that update's verdicts
-- together). finish (both branches), context_ledger_promote_shadow, the judge
-- and the scorecard read it here and nowhere else.
CREATE OR REPLACE FUNCTION public.context_ledger_checks_pass(p_checks jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(p_checks OPERATOR(pg_catalog.->>) 'passed' OPERATOR(pg_catalog.=) 'true', false)
$$;
COMMENT ON FUNCTION public.context_ledger_checks_pass(jsonb) IS
 'Context ledger store (20261006013000): the one promotion verdict, a generation''s stored checks.passed (finish computes it from both sides'' refusals over what was proposed). Read by finish, context_ledger_promote_shadow, the judge and the scorecard. Service role only.';

-- Whether an instant falls in the backfill hours (Perth): from_hour inclusive,
-- to_hour exclusive, wrapping midnight when from_hour > to_hour; no hours set =
-- any time. The judge holds backfills and rebuilds outside them; the budget
-- shows them.
CREATE OR REPLACE FUNCTION public.context_ledger_backfill_open(p_from smallint, p_to smallint, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p_from IS NULL OR p_to IS NULL THEN true
  WHEN p_from OPERATOR(pg_catalog.<) p_to
   THEN extract(hour FROM p_at AT TIME ZONE 'Australia/Perth') OPERATOR(pg_catalog.>=) p_from
    AND extract(hour FROM p_at AT TIME ZONE 'Australia/Perth') OPERATOR(pg_catalog.<) p_to
  ELSE extract(hour FROM p_at AT TIME ZONE 'Australia/Perth') OPERATOR(pg_catalog.>=) p_from
    OR extract(hour FROM p_at AT TIME ZONE 'Australia/Perth') OPERATOR(pg_catalog.<) p_to END
$$;
COMMENT ON FUNCTION public.context_ledger_backfill_open(smallint, smallint, timestamptz) IS
 'Context ledger store (20261006013000): whether an instant is inside the ledger''s backfill hours (context_ledger_settings.backfill_from_hour inclusive to backfill_to_hour exclusive, Perth, wrapping midnight; both null = any time). Read by the judge and the budget. Service role only.';

-- 5. The evidence of a set of jobs. One definition for due, packet and write.
CREATE OR REPLACE FUNCTION public.context_ledger_evidence_rows(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, src_table text, src_id uuid, at timestamptz, landed_at timestamptz, channel text, kind text,
 direction text, sender_role text, recipient_role text, audience text, counterpart_role text, role_basis text,
 sender text, recipient text, ours boolean, automated boolean, subject text, body text, placed_on text, has_transcript boolean,
 copy_of uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, nullif(btrim(jb.client_name), '') AS cname, jb.created_at,
   -- the client has another job (the same CRM contact or client email)
   (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
    OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)) AS repeat_client
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), be AS (
  SELECT e.job_id, 'business_events'::text AS src_table, e.id AS src_id,
   coalesce(e.event_at, e.occurred_at) AS at,
   greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) AS landed_at,
   coalesce(e.channel, CASE WHEN e.event_type LIKE '%email%' THEN 'email' WHEN e.event_type LIKE '%call%' THEN 'call'
    WHEN e.event_type LIKE 'note.%' THEN 'note' ELSE 'sms' END) AS channel,
   e.event_type AS kind, e.direction,
   e.metadata #>> '{party_roles,sender_role}' AS sender_role,
   e.metadata #>> '{party_roles,recipient_role}' AS recipient_role,
   coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') AS audience,
   e.metadata #>> '{party_roles,counterpart_role}' AS counterpart_role,
   e.metadata #>> '{party_roles,basis}' AS role_basis,
   CASE WHEN e.metadata #>> '{party_roles,sender_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer' THEN j.cname
    ELSE coalesce((SELECT s.label FROM public.staff_ghl_users s
      WHERE s.ghl_user_id = coalesce(e.payload ->> 'sent_by_user', e.payload ->> 'by_user') LIMIT 1),
     nullif(btrim(coalesce(e.payload ->> 'from_name', e.payload ->> 'from', e.payload ->> 'from_email')), '')) END AS sender,
   CASE WHEN e.metadata #>> '{party_roles,recipient_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer' THEN j.cname
    ELSE nullif(btrim(coalesce(e.payload ->> 'to_name', e.payload ->> 'to', e.payload ->> 'to_email')), '') END AS recipient,
   public.context_event_is_ours(e) AS ours,
   (coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other') AS automated,
   nullif(btrim(e.payload ->> 'subject'), '') AS subject,
   public.context_event_text(e) AS body,
   'this_job'::text AS placed_on,
   -- A call log (not a transcript) says whether its transcript is on the job: the
   -- transcript names the call's GHL message id in payload.ghl_call_id (and in its
   -- key ghltx:<id>); the call row's key is ghl:<id>.
   CASE WHEN e.event_type <> 'call.transcript_completed'
         AND (e.channel = 'call' OR e.event_type IN ('client.call_logged', 'client.call_complete'))
    THEN coalesce(e.provider_message_id LIKE 'ghl:%' AND EXISTS (SELECT 1 FROM public.business_events t
     WHERE t.job_id = e.job_id AND t.event_type = 'call.transcript_completed' AND public.context_linked_status(t.attribution_status)
      AND (t.payload ->> 'ghl_call_id' = substr(e.provider_message_id, 5)
       OR t.provider_message_id = 'ghltx:' || substr(e.provider_message_id, 5))), false) END AS has_transcript,
   lower(nullif(btrim(coalesce(e.payload ->> 'from', e.payload ->> 'from_email')), '')) AS sender_key
  FROM j JOIN public.business_events e ON e.job_id = j.id
  WHERE public.context_ledger_row_admissible(e)
   AND coalesce(e.event_at, e.occurred_at) <= p_as_of
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= p_as_of
 ), inbox_c AS (
  -- Legacy mail placed on the job, or from the client's own address and placed
  -- on no job. Mail the old matcher put on another job stays there: a repeat
  -- customer's mail about one job never enters every job of theirs. Unplaced
  -- mail is evidence only when the client has no other job (else it may be that
  -- job's), from 30 days before the job was created (the record layer's
  -- context_job_record_legacy_mail keeps the same rule).
  SELECT j.id AS job_id, i.id, i.received_at, i.processed_at, i.subject, i.body_preview, i.from_email, i.from_name,
   i.to_email, i.mailbox, i.graph_message_id, i.classification, j.cmail, j.cname, 'this_job'::text AS placed_on
  FROM j JOIN public.inbox_events i ON i.job_id = j.id
  UNION
  SELECT j.id, i.id, i.received_at, i.processed_at, i.subject, i.body_preview, i.from_email, i.from_name,
   i.to_email, i.mailbox, i.graph_message_id, i.classification, j.cmail, j.cname, 'none'::text
  FROM j JOIN public.inbox_events i ON j.cmail IS NOT NULL AND lower(btrim(i.from_email)) = j.cmail AND i.job_id IS NULL
  WHERE NOT j.repeat_client AND i.received_at >= j.created_at - interval '30 days'
 ), email_copy AS MATERIALIZED (
  -- Any email row with the same sender at the same instant is the same mail.
  SELECT DISTINCT coalesce(b.event_at, b.occurred_at) AS at,
   lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) AS sender
  FROM public.business_events b
  WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) IN (SELECT ic.received_at FROM inbox_c ic)
 ), inbox AS (
  SELECT c.job_id, 'inbox_events'::text AS src_table, c.id AS src_id, c.received_at AS at,
   coalesce(c.processed_at, c.received_at) AS landed_at, 'email'::text AS channel, 'inbox.email_in'::text AS kind,
   'inbound'::text AS direction,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer'
    WHEN lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN 'staff' END AS sender_role,
   'staff'::text AS recipient_role,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer'
    WHEN lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN 'internal' END AS audience,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer' END AS counterpart_role,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'client_email' END AS role_basis,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN coalesce(c.cname, nullif(btrim(c.from_name), ''), c.from_email)
    ELSE coalesce(nullif(btrim(c.from_name), ''), c.from_email) END AS sender,
   coalesce(nullif(btrim(c.to_email), ''), c.mailbox) AS recipient,
   lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' AS ours,
   false AS automated,
   nullif(btrim(c.subject), '') AS subject,
   coalesce(nullif(btrim(c.body_preview), ''), btrim(c.subject)) AS body,
   c.placed_on, NULL::boolean AS has_transcript,
   lower(nullif(btrim(c.from_email), '')) AS sender_key
  FROM inbox_c c
  WHERE c.received_at IS NOT NULL AND c.received_at <= p_as_of
   AND coalesce(c.processed_at, c.received_at) <= p_as_of
   AND coalesce(c.classification, '') NOT IN ('spam', 'newsletter')
   AND coalesce(c.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
   AND btrim(coalesce(c.subject, '') || coalesce(c.body_preview, '')) <> ''
   -- No business_events copy anywhere: the copy's own placement decides.
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = c.id::text)
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE c.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || c.graph_message_id)
   -- An old-path copy names its inbox row only in the payload (containment, so
   -- the payload index answers it instead of a scan of every business_events row).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', c.id::text))
   AND NOT EXISTS (SELECT 1 FROM email_copy m WHERE m.at = c.received_at AND m.sender = lower(btrim(c.from_email)))
 ), allrows AS (
  SELECT * FROM be UNION ALL SELECT * FROM inbox
 ), keyed AS (
  SELECT a.*,
   lag(a.at) OVER w AS prev_at, lag(a.src_id) OVER w AS prev_id
  FROM allrows a
  WINDOW w AS (PARTITION BY a.job_id, a.channel, coalesce(a.direction, ''), coalesce(a.sender_key, ''),
   md5(lower(public.context_ledger_text_norm(a.body))) ORDER BY a.at, a.src_id)
 )
 SELECT k.job_id, k.src_table, k.src_id, k.at, k.landed_at, k.channel, k.kind, k.direction, k.sender_role, k.recipient_role,
  k.audience, k.counterpart_role, k.role_basis, k.sender, k.recipient, k.ours, k.automated, k.subject, k.body,
  k.placed_on, k.has_transcript,
  CASE WHEN k.prev_at IS NOT NULL AND k.at - k.prev_at <= interval '120 seconds' THEN k.prev_id END AS copy_of
 FROM keyed k
 ORDER BY k.job_id, k.at, k.src_id
$$;
COMMENT ON FUNCTION public.context_ledger_evidence_rows(uuid[], timestamptz) IS
 'Context ledger store (20261006013000): the admissible worded evidence of the given jobs as of an instant, oldest first: business_events rows passing context_ledger_row_admissible, plus legacy inbox_events mail placed on the job, or from the client''s address and placed on no job (placed_on this_job or none; mail placed on another job stays there; unplaced mail only when the client has no other job by CRM contact or client email, and from 30 days before the job was created), with no business_events copy (source pointer, graph key, payload inbox_events_id, or the same sender at the same instant), spam, newsletters and auto-replies left out. has_transcript on a call log: its transcript (payload.ghl_call_id or key ghltx:<id> naming the call''s ghl:<id>) is on the job. copy_of names the earlier row when this row is a copy (same channel, direction, sender address and words within 120 seconds); nothing is changed. Placement is read as it is now. Service role only.';

-- 6. The job's current generation: the live one, else the newest shadow.
CREATE OR REPLACE FUNCTION public.context_ledger_current_generation(p_job_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT g.id FROM public.context_ledger_generations g
 WHERE g.job_id = p_job_id AND g.status IN ('live', 'shadow')
 ORDER BY (g.status = 'live') DESC, g.created_at DESC, g.id DESC LIMIT 1
$$;
COMMENT ON FUNCTION public.context_ledger_current_generation(uuid) IS
 'Context ledger store (20261006013000): the job''s current ledger generation: the live one, else the newest shadow (shadow mode keeps one up to date without showing it). Service role only.';

-- 6b. A job's failure record: consecutive failed ledger runs (a run that
-- failed, or finished with checks_failed) since its newest success, the
-- escalating backoff they earn (2 hours, 8 hours, until the next Perth day,
-- then 7 days), and consecutive check-failed builds by the current reader
-- (three in a row need a person). A released run (a stop: budget, switch,
-- pause, rate limit, sign-in, worker stopping) never counts.
CREATE OR REPLACE FUNCTION public.context_ledger_failures(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, failures integer, last_failure_at timestamptz, backoff_until timestamptz, failed_builds integer,
 needs_person boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH ids AS (SELECT DISTINCT x.id FROM unnest(p_job_ids) AS x(id) WHERE x.id IS NOT NULL),
 s AS (SELECT (SELECT st.reader FROM public.context_ledger_settings st WHERE st.id) AS reader),
 runs AS (  -- every ended ledger run that was not released, newest first
  SELECT r.job_id, r.finished_at, (r.status = 'failed' OR coalesce(r.error, '') = 'checks_failed') AS failed,
   row_number() OVER (PARTITION BY r.job_id ORDER BY r.finished_at DESC, r.id DESC) AS n
  FROM public.context_extraction_runs r JOIN ids ON ids.id = r.job_id
  WHERE r.phase = 'ledger' AND r.status IN ('done', 'failed') AND r.finished_at IS NOT NULL
   AND coalesce(r.error, '') NOT LIKE 'released:%'
 ),
 streak AS (  -- the failures since the newest success
  SELECT r.job_id, count(*)::integer AS failures, max(r.finished_at) AS last_failure_at
  FROM runs r
  WHERE r.failed AND r.n < coalesce((SELECT min(r2.n) FROM runs r2 WHERE r2.job_id = r.job_id AND NOT r2.failed), 2147483647)
  GROUP BY r.job_id
 ),
 builds AS (  -- completed readings by the current reader, newest first (a failed or released build is not a reading)
  SELECT g.job_id, (g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks)) AS check_failed,
   row_number() OVER (PARTITION BY g.job_id ORDER BY g.finished_at DESC NULLS LAST, g.created_at DESC, g.id DESC) AS n
  FROM public.context_ledger_generations g JOIN ids ON ids.id = g.job_id CROSS JOIN s
  WHERE g.kind IN ('backfill', 'rebuild') AND g.status IN ('shadow', 'live', 'retired') AND g.reader = s.reader
 ),
 fb AS (
  SELECT b.job_id, count(*)::integer AS failed_builds
  FROM builds b
  WHERE b.check_failed AND b.n < coalesce((SELECT min(b2.n) FROM builds b2 WHERE b2.job_id = b.job_id AND NOT b2.check_failed), 2147483647)
  GROUP BY b.job_id
 )
 SELECT ids.id, coalesce(st.failures, 0), st.last_failure_at,
  CASE WHEN st.failures IS NULL THEN NULL
   WHEN st.failures = 1 THEN st.last_failure_at + interval '2 hours'
   WHEN st.failures = 2 THEN st.last_failure_at + interval '8 hours'
   WHEN st.failures = 3 THEN (date_trunc('day', st.last_failure_at AT TIME ZONE 'Australia/Perth') + interval '1 day') AT TIME ZONE 'Australia/Perth'
   ELSE st.last_failure_at + interval '7 days' END,
  coalesce(fb.failed_builds, 0), coalesce(fb.failed_builds, 0) >= 3
 FROM ids LEFT JOIN streak st ON st.job_id = ids.id LEFT JOIN fb ON fb.job_id = ids.id
$$;
COMMENT ON FUNCTION public.context_ledger_failures(uuid[]) IS
 'Context ledger store (20261006013000): per job, consecutive failed ledger runs since the newest success (status failed, or done with error checks_failed; runs released with error released:<code> never count), the backoff they earn from the last one (1: 2 hours, 2: 8 hours, 3: the next Perth midnight, 4 or more: 7 days), and consecutive check-failed builds by the current settings reader (a shadow whose checks.passed is false; a live or retired reading breaks the run). needs_person when three in a row failed their checks. Read by the judge and the scorecard. Service role only.';

-- 7. The judgement: is a job due a ledger read, what kind, and why.
CREATE OR REPLACE FUNCTION public.context_ledger_judge(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamptz,
 evidence_rows integer, generation_id uuid, blocked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH s AS (
  SELECT coalesce((SELECT st.mode FROM public.context_ledger_settings st WHERE st.id), 'off') AS mode,
   (SELECT st.reader FROM public.context_ledger_settings st WHERE st.id) AS reader,
   (SELECT st.job_ids FROM public.context_ledger_settings st WHERE st.id) AS job_ids,
   public.automation_lane_enabled('extraction') AS lane,
   public.context_ledger_backfill_open((SELECT st.backfill_from_hour FROM public.context_ledger_settings st WHERE st.id),
    (SELECT st.backfill_to_hour FROM public.context_ledger_settings st WHERE st.id), now()) AS window_open
 ), j AS (
  SELECT jb.id, jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost') AS live_job,
   coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1') AS schedulable
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), cur AS (
  SELECT j.id AS job_id, public.context_ledger_current_generation(j.id) AS gid FROM j
 ), g AS (
  SELECT c.job_id, gen.id, gen.status, gen.reader, gen.evidence_until, gen.created_at, gen.checks
  FROM cur c JOIN public.context_ledger_generations gen ON gen.id = c.gid
 ), cbe AS (
  -- The read every judgement can afford: the admitted business_events rows
  -- exactly (count and newest landed time, no text compare, no copy grouping)...
  SELECT e.job_id, count(*)::integer AS n,
   max(greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at)) AS newest
  FROM j JOIN public.business_events e ON e.job_id = j.id
  WHERE j.live_job AND public.context_ledger_row_admissible(e) AND coalesce(e.event_at, e.occurred_at) <= now()
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= now()
  GROUP BY e.job_id
 ), cib AS (
  -- ...and the legacy mail that could be evidence, before its copy checks (a superset).
  SELECT x.job_id, count(*)::integer AS n, max(x.landed) AS newest FROM (
   SELECT j.id AS job_id, coalesce(i.processed_at, i.received_at) AS landed
   FROM j JOIN public.inbox_events i ON i.job_id = j.id WHERE j.live_job AND i.received_at <= now()
   UNION ALL
   SELECT j.id, coalesce(i.processed_at, i.received_at)
   FROM j JOIN public.jobs jb ON jb.id = j.id
   JOIN public.inbox_events i ON lower(btrim(i.from_email)) = lower(nullif(btrim(jb.client_email), '')) AND i.job_id IS NULL
   WHERE j.live_job AND i.received_at <= now() AND i.received_at >= jb.created_at - interval '30 days'
    AND NOT (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
    OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id))) x
  WHERE x.landed <= now()
  GROUP BY x.job_id
 ), need AS (
  -- The full evidence read (text, copies) only where it can change the judgement:
  -- a reading whose newest possible evidence is past its evidence_until, or a
  -- never-read job whose only possible evidence is legacy mail.
  SELECT j.id FROM j LEFT JOIN g ON g.job_id = j.id LEFT JOIN cbe ON cbe.job_id = j.id LEFT JOIN cib ON cib.job_id = j.id
  WHERE j.live_job AND CASE WHEN g.id IS NULL THEN coalesce(cbe.n, 0) = 0 AND coalesce(cib.n, 0) > 0
                            ELSE g.evidence_until IS NULL OR greatest(cbe.newest, cib.newest) > g.evidence_until END
 ), er AS MATERIALIZED (
  SELECT r.job_id, r.src_id, r.at, r.landed_at, r.copy_of
  FROM public.context_ledger_evidence_rows(ARRAY(SELECT need.id FROM need), now()) r
 ), ev AS (
  -- Exact where read in full; elsewhere the cheap read gives the same judgement
  -- (newest only ever overstates, by legacy copies, and stays at or before the
  -- reading's evidence_until; a count above zero stays above zero).
  SELECT j.id AS job_id,
   CASE WHEN nd.id IS NOT NULL THEN (SELECT max(r.landed_at) FROM er r WHERE r.job_id = j.id)
        ELSE greatest(cbe.newest, cib.newest) END AS newest,
   CASE WHEN nd.id IS NOT NULL THEN (SELECT (count(*) FILTER (WHERE r.copy_of IS NULL))::integer FROM er r WHERE r.job_id = j.id)
        ELSE coalesce(cbe.n, 0) + coalesce(cib.n, 0) END AS n
  FROM j LEFT JOIN need nd ON nd.id = j.id LEFT JOIN cbe ON cbe.job_id = j.id LEFT JOIN cib ON cib.job_id = j.id
  WHERE j.live_job
 ), moved AS (
  -- An item of the current generation citing a business_events row that is
  -- gone, on another job, or no longer admissible. A person-locked item is
  -- left out: a rebuild carries it straight back, so it waits for a person
  -- (the story says so) instead of looping.
  SELECT DISTINCT i.job_id FROM g JOIN public.context_ledger_items i ON i.generation_id = g.id AND NOT i.person_locked
  CROSS JOIN LATERAL jsonb_array_elements(i.opened_by || coalesce(i.closed_by, '[]'::jsonb)) c(cite)
  LEFT JOIN public.business_events b ON c.cite ->> 'table' = 'business_events'
   AND b.id = CASE WHEN c.cite ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.cite ->> 'id')::uuid END
  WHERE c.cite ->> 'table' = 'business_events'
   AND (b.id IS NULL OR b.job_id IS DISTINCT FROM i.job_id OR NOT public.context_event_source_admissible(b))
 ), answered AS (
  -- A newer passing reading by the current reader already answers a rebuild of
  -- the live one (it waits for promotion); one that failed its checks answers
  -- it only while the job backs off.
  SELECT DISTINCT g.job_id FROM g CROSS JOIN s
  JOIN public.context_ledger_generations n ON n.job_id = g.job_id AND n.status = 'shadow' AND n.reader = s.reader
   AND n.created_at > g.created_at AND public.context_ledger_checks_pass(n.checks)
  WHERE g.status = 'live'
 ), fnew AS (
  -- Where the unread evidence starts (the earliest row that landed after the reading).
  SELECT DISTINCT ON (r.job_id) r.job_id, r.at, r.src_id
  FROM er r JOIN g ON g.job_id = r.job_id
  WHERE r.copy_of IS NULL AND g.evidence_until IS NOT NULL AND r.landed_at > g.evidence_until
  ORDER BY r.job_id, r.at, r.src_id
 ), late AS (
  -- How much already-read evidence follows it (an update packet carries all of it).
  SELECT f.job_id, f.at AS first_new_at,
   (count(*) FILTER (WHERE r.copy_of IS NULL AND r.landed_at <= g.evidence_until AND (r.at, r.src_id) > (f.at, f.src_id)))::integer AS read_after
  FROM fnew f JOIN g ON g.job_id = f.job_id JOIN er r ON r.job_id = f.job_id
  GROUP BY f.job_id, f.at
 ), fail AS (
  SELECT f.* FROM public.context_ledger_failures(ARRAY(SELECT j.id FROM j)) f
 ), busy AS (
  SELECT j.id AS job_id,
   EXISTS (SELECT 1 FROM public.context_ledger_generations bg JOIN public.context_extraction_runs br ON br.id = bg.run_id
    WHERE bg.job_id = j.id AND bg.status = 'building' AND br.status = 'running' AND br.lease_expires_at > now()) AS building_live,
   EXISTS (SELECT 1 FROM public.context_ledger_generations bg LEFT JOIN public.context_extraction_runs br ON br.id = bg.run_id
    WHERE bg.job_id = j.id AND bg.status = 'building'
     AND coalesce(br.lease_expires_at, br.finished_at, bg.updated_at) > now() - interval '2 hours'
     AND NOT (br.status = 'running' AND br.lease_expires_at > now())) AS building_lapsed_recent,
   EXISTS (SELECT 1 FROM public.context_extraction_runs r WHERE r.job_id = j.id AND r.phase = 'ledger'
    AND r.status = 'running' AND r.lease_expires_at > now()) AS run_live
  FROM j
 ), judged AS (
  SELECT j.id AS job_id, ev.newest, coalesce(ev.n, 0) AS n, g.id AS gid,
   CASE WHEN g.id IS NULL THEN 'never_read'
    WHEN g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks) THEN 'checks_failed'
    WHEN m.job_id IS NOT NULL AND a.job_id IS NULL THEN 'citation_moved'
    WHEN g.reader IS DISTINCT FROM s.reader AND a.job_id IS NULL THEN 'reader_changed'
    WHEN g.evidence_until IS NULL OR g.evidence_until < ev.newest THEN
     CASE WHEN lt.first_new_at < g.evidence_until - interval '14 days' OR lt.read_after > 150 THEN 'late_evidence'
      ELSE 'new_evidence' END END AS reason,
   CASE WHEN s.mode = 'off' THEN 'ledger_off' WHEN NOT s.lane THEN 'lane_off'
    WHEN s.job_ids IS NOT NULL AND NOT (j.id = ANY(s.job_ids)) THEN 'not_in_rollout' WHEN NOT j.live_job THEN 'not_live'
    WHEN NOT j.schedulable THEN 'holding_job' WHEN coalesce(ev.n, 0) = 0 THEN 'no_evidence'
    WHEN b.building_live OR b.run_live THEN 'busy'
    WHEN f.needs_person THEN 'needs_person'
    WHEN f.backoff_until > now() OR b.building_lapsed_recent THEN 'backoff' END AS blocked
  FROM j CROSS JOIN s LEFT JOIN ev ON ev.job_id = j.id LEFT JOIN g ON g.job_id = j.id
  LEFT JOIN moved m ON m.job_id = j.id LEFT JOIN answered a ON a.job_id = j.id LEFT JOIN late lt ON lt.job_id = j.id
  LEFT JOIN fail f ON f.job_id = j.id LEFT JOIN busy b ON b.job_id = j.id
 )
 SELECT d.job_id, d.blk IS NULL AND d.reason IS NOT NULL,
  CASE WHEN d.reason IS NULL THEN NULL WHEN d.reason = 'never_read' THEN 'backfill' WHEN d.reason = 'new_evidence' THEN 'update'
   ELSE 'rebuild' END,
  d.reason,
  CASE d.reason WHEN 'citation_moved' THEN 1 WHEN 'new_evidence' THEN 1 WHEN 'late_evidence' THEN 1 WHEN 'never_read' THEN 2
   WHEN 'reader_changed' THEN 3 WHEN 'checks_failed' THEN 3 END,
  d.newest, d.n, d.gid, d.blk
 FROM (  -- backfills and rebuilds wait for the backfill hours; an update is never held
  SELECT d0.*, coalesce(d0.blocked, CASE WHEN NOT s.window_open AND d0.reason IS NOT NULL AND d0.reason <> 'new_evidence'
                                         THEN 'outside_window' END) AS blk
  FROM judged d0 CROSS JOIN s) d
$$;
COMMENT ON FUNCTION public.context_ledger_judge(uuid[]) IS
 'Context ledger store (20261006013000): the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only.';

-- 8. Jobs due a ledger read now.
CREATE OR REPLACE FUNCTION public.context_ledger_due(p_limit integer DEFAULT 20)
RETURNS TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH st AS (SELECT x.mode, x.job_ids FROM public.context_ledger_settings x WHERE x.id)
 SELECT d.job_id, d.kind, d.reason, d.priority, d.newest_evidence_at
 FROM public.context_ledger_judge(ARRAY(
   -- only jobs the judgement could find due: live, the lane on, in the rollout list
   SELECT jb.id FROM public.jobs jb, st
   WHERE jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
    AND st.mode <> 'off' AND public.automation_lane_enabled('extraction')
    AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids)))) d
 WHERE d.due
 ORDER BY d.priority, d.newest_evidence_at DESC NULLS LAST, d.job_id
 LIMIT greatest(0, least(coalesce(p_limit, 20), 200))
$$;
COMMENT ON FUNCTION public.context_ledger_due(integer) IS
 'Context ledger store (20261006013000): live jobs due a ledger read now (context_ledger_judge), new evidence and moved citations first, then never-read jobs newest evidence first, then reader changes. At most 200. Empty while context_ledger_settings.mode is off or the extraction lane is off; only jobs on settings.job_ids when that rollout list is set. Service role only.';

-- 9. The claim: a ledger run, and for a backfill or rebuild a building generation.
CREATE OR REPLACE FUNCTION public.context_ledger_claim(p_job_id uuid, p_kind text, p_run_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.context_ledger_settings; d record; r public.context_extraction_runs; g public.context_ledger_generations;
 v_seq integer; v_lease interval; x record;
BEGIN
 IF p_job_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('backfill','update','rebuild')
  OR p_run_date IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date THEN
  RAISE EXCEPTION 'context_ledger_claim_invalid';
 END IF;
 SELECT * INTO s FROM public.context_ledger_settings WHERE id;
 IF s.id IS NULL OR s.mode = 'off' OR NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('outcome', 'off');
 END IF;
 -- One claim at a time per job (never the admission's lock, which every model call takes).
 PERFORM pg_advisory_xact_lock(20261006, hashtext(p_job_id::text));
 -- A building generation whose run lost its lease is failed here (it would
 -- otherwise block the job for ever); the job then waits out the backoff.
 FOR x IN SELECT bg.id AS gid, br.id AS rid, br.status AS rstatus FROM public.context_ledger_generations bg
  LEFT JOIN public.context_extraction_runs br ON br.id = bg.run_id
  WHERE bg.job_id = p_job_id AND bg.status = 'building'
   AND NOT (br.status IS NOT DISTINCT FROM 'running' AND br.lease_expires_at > now()) FOR UPDATE OF bg LOOP
  UPDATE public.context_ledger_generations SET status = 'failed', failure = 'lease_expired', finished_at = now(), updated_at = now()
  WHERE id = x.gid;
  IF x.rid IS NOT NULL AND x.rstatus = 'running' THEN
   UPDATE public.context_extraction_runs SET status = 'failed', error = 'lease_expired', finished_at = now(), lease_expires_at = NULL
   WHERE id = x.rid;
  END IF;
 END LOOP;
 -- Any other ledger run of the job that lost its lease (a crashed update) closes
 -- the same way, so it counts toward the backoff instead of hanging as running.
 UPDATE public.context_extraction_runs SET status = 'failed', error = 'lease_expired', finished_at = now(), lease_expires_at = NULL
 WHERE job_id = p_job_id AND phase = 'ledger' AND status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= now());
 SELECT * INTO d FROM public.context_ledger_judge(ARRAY[p_job_id]);
 IF d.job_id IS NULL THEN RAISE EXCEPTION 'context_ledger_claim_invalid'; END IF;
 IF d.blocked_reason = 'busy' THEN RETURN jsonb_build_object('outcome', 'busy'); END IF;
 IF NOT d.due OR d.kind IS DISTINCT FROM p_kind THEN
  RETURN jsonb_build_object('outcome', 'not_due', 'kind', d.kind, 'reason', coalesce(d.blocked_reason, d.reason));
 END IF;
 v_lease := make_interval(mins => (public.context_cadence_policy() ->> 'run_lease_min')::integer);
 SELECT coalesce(max(run_seq), 0) + 1 INTO v_seq FROM public.context_extraction_runs
 WHERE job_id = p_job_id AND run_date = p_run_date AND phase = 'ledger';
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq)
 VALUES (p_job_id, p_run_date, 'ledger', 'running', gen_random_uuid(), now() + v_lease, v_seq) RETURNING * INTO r;
 IF p_kind = 'update' THEN
  SELECT * INTO g FROM public.context_ledger_generations WHERE id = d.generation_id;
 ELSE
  INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, run_id)
  VALUES (p_job_id, p_kind, 'building', s.reader, r.id) RETURNING * INTO g;
 END IF;
 RETURN jsonb_build_object('outcome', 'claimed', 'run_id', r.id, 'lease_token', r.lease_token,
  'lease_expires_at', r.lease_expires_at, 'generation_id', g.id, 'generation_status', g.status, 'kind', p_kind,
  'reason', d.reason, 'mode', s.mode, 'reader', g.reader, 'max_prompt_bytes', s.max_prompt_bytes,
  'since', CASE WHEN p_kind = 'update' THEN g.evidence_until END,
  -- build the packet as of the claim: finish never records evidence past it
  'evidence_as_of', r.started_at);
END $$;
COMMENT ON FUNCTION public.context_ledger_claim(uuid, text, date) IS
 'Context ledger store (20261006013000): claims one ledger read of a job: a context_extraction_runs row (phase ledger, running, run_lease_min lease) and, for backfill or rebuild, a building generation with the settings reader; for update, the job''s current generation (since = its evidence_until). Outcomes claimed (with evidence_as_of, the claim''s instant: build the packet as of it), busy, off (mode off or extraction lane off), not_due (the judgement disagrees with the asked kind). Claims serialise per job (an advisory lock on the job), never on the admission''s lock. A building generation whose run lost its lease is failed first, and any ledger run of the job that lost its lease (a crashed update) is closed failed (lease_expired): it counts toward the backoff. Service role only.';

-- 10. The packet: everything the reader sees except the record text.
CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamptz DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid;
BEGIN
 v_as_of := coalesce(p_as_of, now());
 SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, j.client_name, j.site_suburb, j.created_at,
  nullif(btrim(j.ghl_contact_id), '') AS ghl_contact_id
 INTO jb FROM public.jobs j WHERE j.id = p_job_id;
 IF jb.id IS NULL THEN RAISE EXCEPTION 'context_ledger_packet_job_not_found'; END IF;
 v_job := jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
  'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
  'customer_contact_ref', jb.ghl_contact_id);
 -- Parties: the job's own client, then every other party on job_contacts
 -- (the owner row that repeats the job's client is not listed twice).
 SELECT jsonb_build_array(jsonb_build_object('name', jb.client_name, 'role', 'customer', 'contact_ref', jb.ghl_contact_id, 'label', 'job_client'))
  || coalesce(jsonb_agg(jsonb_build_object('name', c.client_name, 'role', 'customer',
   'contact_ref', coalesce(nullif(btrim(c.ghl_contact_id), ''), lower(nullif(btrim(c.client_email), ''))),
   'label', coalesce(c.contact_label, c.contact_type)) ORDER BY c.is_primary DESC NULLS LAST, c.created_at, c.id), '[]'::jsonb)
 INTO v_parties
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND NOT (coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, '')));
 -- Evidence: copies left out. In update mode: the rows that landed after
 -- p_since; every already-read row after the earliest of them (so a late row,
 -- such as old mail placed on the job today, is read with what followed it);
 -- and the six rows before it. Each row says whether it was already read.
 WITH r AS (
  SELECT * FROM public.context_ledger_evidence_rows(ARRAY[p_job_id], v_as_of)
 ), u AS (
  SELECT * FROM r WHERE r.copy_of IS NULL
 ), firstnew AS (
  SELECT u.at, u.src_id FROM u WHERE p_since IS NOT NULL AND u.landed_at > p_since ORDER BY u.at, u.src_id LIMIT 1
 ), ctx AS (
  SELECT u.src_id FROM u, firstnew f
  WHERE (u.at, u.src_id) < (f.at, f.src_id) AND NOT (u.landed_at > p_since)
  ORDER BY u.at DESC, u.src_id DESC LIMIT 6
 ), sel AS (
  SELECT u.*, CASE WHEN u.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END AS lim
  FROM u WHERE p_since IS NULL OR u.landed_at > p_since OR u.src_id IN (SELECT ctx.src_id FROM ctx)
   OR EXISTS (SELECT 1 FROM firstnew f WHERE (u.at, u.src_id) > (f.at, f.src_id))
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at, 'recorded_at', sel.landed_at,
   'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction, 'sender_role', sel.sender_role,
   'recipient_role', sel.recipient_role, 'audience', sel.audience, 'counterpart_role', sel.counterpart_role,
   'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient, 'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject,
   'already_read', p_since IS NOT NULL AND sel.landed_at <= p_since, 'placed_on', sel.placed_on, 'has_transcript', sel.has_transcript,
   'text', left(sel.body, sel.lim)) ORDER BY sel.at, sel.src_id), '[]'::jsonb),
  count(*)::integer, (count(*) FILTER (WHERE length(sel.body) > sel.lim))::integer,
  (SELECT max(r.landed_at) FROM r), (SELECT count(*) FILTER (WHERE r.copy_of IS NOT NULL) FROM r)::integer
 INTO v_evidence, v_rows, v_truncated, v_until, v_dups FROM sel;
 -- Items the reader must know: in update mode the current generation's open,
 -- disputed and in-force items; otherwise the live generation's person-locked
 -- items (a rebuild must not write them again).
 IF p_since IS NOT NULL THEN
  v_gen := public.context_ledger_current_generation(p_job_id);
 ELSE
  SELECT g.id INTO v_gen FROM public.context_ledger_generations g WHERE g.job_id = p_job_id AND g.status = 'live';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_key', i.item_key, 'item_type', i.item_type, 'status', i.status, 'what', i.what,
   'about_key', i.about_key, 'phase', i.phase, 'from_role', i.from_role, 'to_role', i.to_role, 'opened_at', i.opened_at,
   'closes_on', i.closes_on, 'opened_by', i.opened_by, 'person_locked', i.person_locked) ORDER BY i.opened_at, i.item_key), '[]'::jsonb)
 INTO v_open FROM public.context_ledger_items i
 WHERE v_gen IS NOT NULL AND i.generation_id = v_gen
  AND CASE WHEN p_since IS NOT NULL THEN i.status IN ('open', 'disputed', 'info') ELSE i.person_locked END;
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open);
END $$;
COMMENT ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) IS
 'Context ledger store (20261006013000): ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties, evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only.';

-- 11. One citation: allowed table, a row on this job, a verbatim excerpt.
-- Returns {ok, code, detail} on refusal, else the canonical citation and the
-- facts the speaker, time and due-date checks need.
CREATE OR REPLACE FUNCTION public.context_ledger_cite(p_job_id uuid, p_cite jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_table text; v_id uuid; v_excerpt text; v_norm text; e public.business_events; v_text text; v_at timestamptz;
 v_cmail text; v_job uuid; v_found boolean; i record; v_ours boolean := false; v_customer boolean := false;
 v_call_note boolean := false; v_internal boolean := false; v_record boolean := false; v_worded boolean := false;
 v_subject text; v_body text; v_close_at timestamptz; v_automated boolean := false; v_made_at timestamptz;
 v_job_created timestamptz; v_repeat boolean;
BEGIN
 IF p_cite IS NULL OR jsonb_typeof(p_cite) <> 'object'
  OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_cite) k WHERE k NOT IN ('table', 'id', 'excerpt'))
  OR jsonb_typeof(p_cite -> 'table') IS DISTINCT FROM 'string' OR jsonb_typeof(p_cite -> 'id') IS DISTINCT FROM 'string'
  OR coalesce(jsonb_typeof(p_cite -> 'excerpt'), 'null') NOT IN ('string', 'null') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_shape', 'detail', 'a citation is {table, id, excerpt}');
 END IF;
 v_table := p_cite ->> 'table';
 IF v_table NOT IN ('business_events','inbox_events','job_documents','xero_invoices','job_assignments','job_events','email_events') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_table_not_allowed', 'detail', left(v_table, 40));
 END IF;
 IF (p_cite ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_shape', 'detail', 'id is not a uuid');
 END IF;
 v_id := (p_cite ->> 'id')::uuid;
 v_excerpt := p_cite ->> 'excerpt';
 v_norm := public.context_ledger_text_norm(v_excerpt);
 IF length(v_norm) > 400 THEN RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_long', 'detail', v_table || ':' || v_id); END IF;
 IF v_table = 'business_events' THEN
  SELECT * INTO e FROM public.business_events b WHERE b.id = v_id;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  IF e.job_id IS DISTINCT FROM p_job_id THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id); END IF;
  -- the same admission as the evidence: linked, not retracted, our own writer,
  -- worded, a message (never a status-only or record-kind row)
  IF NOT public.context_ledger_row_admissible(e) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id);
  END IF;
  v_body := public.context_event_text(e);
  v_worded := btrim(v_body) <> '';
  v_subject := nullif(btrim(e.payload ->> 'subject'), '');
  v_text := concat_ws(' ', v_subject, v_body);
  v_at := coalesce(e.event_at, e.occurred_at);
  IF e.event_type = 'call.transcript_completed' THEN
   -- A transcript holds both sides' words: it counts as the customer's only on
   -- its call's stamp (the job's customer was the other party on that call).
   v_customer := EXISTS (SELECT 1 FROM public.business_events c
    WHERE c.job_id = e.job_id AND c.event_type <> 'call.transcript_completed'
     AND c.provider_message_id = 'ghl:' || coalesce(e.payload ->> 'ghl_call_id',
      CASE WHEN e.provider_message_id LIKE 'ghltx:%' THEN substr(e.provider_message_id, 7) END)
     AND c.metadata #>> '{party_roles,counterpart_role}' = 'customer' AND c.metadata #>> '{party_roles,basis}' = 'job_customer');
  ELSE
   v_customer := (e.metadata #>> '{party_roles,sender_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer')
    OR (NOT coalesce(e.metadata ? 'party_roles', false) AND e.event_type LIKE 'client.%' AND e.direction = 'inbound');
  END IF;
  v_automated := coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other';
  v_ours := public.context_event_is_ours(e);
  v_call_note := e.channel IN ('call', 'note') OR e.event_type IN ('call.transcript_completed', 'client.call_logged', 'note.added', 'ghl.internal_comment');
  v_internal := e.channel IN ('sms', 'email') AND (public.context_internal_text_role(e) <> 'other'
   OR coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') = 'internal');
 ELSIF v_table = 'inbox_events' THEN
  SELECT lower(nullif(btrim(jb.client_email), '')), jb.created_at, (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
    OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id))
  INTO v_cmail, v_job_created, v_repeat FROM public.jobs jb WHERE jb.id = p_job_id;
  SELECT x.id, x.job_id, x.from_email, x.subject, x.body_preview, x.received_at, x.graph_message_id, x.classification INTO i
  FROM public.inbox_events x WHERE x.id = v_id;
  IF i.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  IF NOT (i.job_id IS NOT DISTINCT FROM p_job_id OR (i.job_id IS NULL AND v_cmail IS NOT NULL AND lower(btrim(i.from_email)) = v_cmail)) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id);
  END IF;
  -- Unplaced mail as the evidence admits it: never when the client has another
  -- job (it may be that job's), never from before 30 days ahead of the job.
  IF i.job_id IS NULL AND (coalesce(v_repeat, false) OR i.received_at < v_job_created - interval '30 days') THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible',
    'detail', v_table || ':' || v_id || ' is placed on no job and ' || CASE WHEN coalesce(v_repeat, false)
     THEN 'the client has another job' ELSE 'is older than 30 days before the job' END);
  END IF;
  -- Same admission as the evidence: a mail with a business_events copy is cited by its copy.
  IF i.received_at IS NULL OR coalesce(i.classification, '') IN ('spam', 'newsletter')
   OR coalesce(i.subject, '') ~* '^(automatic reply|auto[- ]?reply|out of office)'
   OR btrim(coalesce(i.subject, '') || coalesce(i.body_preview, '')) = ''
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = i.id::text)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE i.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || i.graph_message_id)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', i.id::text))
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) = i.received_at
    AND lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = lower(btrim(i.from_email))) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id);
  END IF;
  v_subject := nullif(btrim(i.subject), ''); v_body := i.body_preview;
  v_text := concat_ws(' ', v_subject, v_body);
  v_worded := btrim(coalesce(v_text, '')) <> '';
  v_at := i.received_at;
  v_customer := v_cmail IS NOT NULL AND lower(btrim(i.from_email)) = v_cmail;
  v_ours := lower(coalesce(i.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$';
 ELSE
  -- A record row: on this job; its time is when the record was made or sent.
  v_record := true; v_ours := true;
  -- v_close_at: when the record can close an item; null when it cannot (a
  -- document never sent, an invoice not issued, a booking nobody attended)
  IF v_table = 'job_documents' THEN
   SELECT d.job_id, coalesce(d.sent_at, d.created_at), d.sent_at, true INTO v_job, v_at, v_close_at, v_found
   FROM public.job_documents d WHERE d.id = v_id;
  ELSIF v_table = 'xero_invoices' THEN
   SELECT x.job_id, coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at),
    CASE WHEN upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID')
         THEN coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) END, true
   INTO v_job, v_at, v_close_at, v_found FROM public.xero_invoices x WHERE x.id = v_id;
  ELSIF v_table = 'job_assignments' THEN
   -- a booking closes on attendance: completed_at, else started_at, else a
   -- status-only completion at the end of its booked Perth day; it is made
   -- (booking_made) while it stands, at its created time. Crew planning's
   -- confirmation is never read; an observer's mirror is never a booking.
   SELECT a.job_id, a.created_at,
    CASE WHEN coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' THEN NULL
         ELSE coalesce(a.completed_at, a.started_at,
          CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
               THEN ((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second' END) END,
    CASE WHEN NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')
          AND lower(coalesce(a.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined') THEN a.created_at END,
    true INTO v_job, v_at, v_close_at, v_made_at, v_found
   FROM public.job_assignments a WHERE a.id = v_id;
  ELSIF v_table = 'job_events' THEN
   SELECT je.job_id, je.created_at, je.created_at, true INTO v_job, v_at, v_close_at, v_found FROM public.job_events je WHERE je.id = v_id;
  ELSE
   SELECT ee.job_id, coalesce(ee.sent_at, ee.created_at), coalesce(ee.sent_at, ee.created_at), true INTO v_job, v_at, v_close_at, v_found
   FROM public.email_events ee WHERE ee.id = v_id;
  END IF;
  IF NOT coalesce(v_found, false) THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  IF v_job IS DISTINCT FROM p_job_id THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id); END IF;
  IF v_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id); END IF;
 END IF;
 IF NOT v_record THEN
  v_close_at := v_at;
  IF v_worded AND v_norm = '' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_required', 'detail', v_table || ':' || v_id);
  END IF;
  IF v_norm <> '' AND position(v_norm IN public.context_ledger_text_norm(v_text)) = 0 THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_not_verbatim', 'detail', v_table || ':' || v_id);
  END IF;
  -- A quote is at least 12 characters or 3 words, unless it is the whole row
  -- (or its whole subject or body) because the row is shorter.
  IF v_norm <> '' AND length(v_norm) < 12 AND coalesce(array_length(regexp_split_to_array(v_norm, '\s+'), 1), 0) < 3
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_text)
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_body)
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_subject) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_short', 'detail', v_table || ':' || v_id);
  END IF;
 END IF;
 RETURN jsonb_build_object('ok', true, 'cite', jsonb_build_object('table', v_table, 'id', v_id::text, 'excerpt', v_excerpt),
  'at', v_at, 'close_at', v_close_at, 'made_at', v_made_at, 'customer_sender', v_customer, 'ours', v_ours, 'call_or_note', v_call_note,
  'internal_text', v_internal, 'record', v_record, 'worded', v_worded, 'automated', v_automated);
END $$;
COMMENT ON FUNCTION public.context_ledger_cite(uuid, jsonb) IS
 'Context ledger store (20261006013000): checks one {table, id, excerpt} citation for a job: an allowed table; a business_events row on this job that is ledger evidence (context_ledger_row_admissible: linked, not retracted, written as service_role, worded, a message); a call transcript counts as the customer''s only when its call (ghl:<id>) is stamped with the job''s customer; an inbox_events mail placed on the job, or from the client''s address and placed on no job when the client has no other job and the mail is from 30 days before the job on, with no business_events copy; a record row (job_documents, xero_invoices, job_assignments, job_events, email_events) on this job. A worded evidence row needs an excerpt that, quotes straightened and whitespace collapsed, is in its subject and text, and is at least 12 characters or 3 words unless it is the whole row, subject or body. close_at: when the row can close an item (a worded row: its time; a document: sent_at; an invoice: only AUTHORISED, SUBMITTED or PAID; a booking: attendance, completed_at, else started_at, else a status-only completion at the end of its booked Perth day; null when it cannot); made_at: a standing booking''s created time (it closes a booking_made item; not standing = cancelled, deleted, draft, disputed, declined). Refusal codes citation_shape, citation_table_not_allowed, citation_missing, citation_off_job, citation_not_admissible, excerpt_required, excerpt_not_verbatim, excerpt_too_long, excerpt_too_short. Service role only.';

-- 12. One item: shape, citations, speaker, times, due date and key.
CREATE OR REPLACE FUNCTION public.context_ledger_check_item(p_job_id uuid, p_item jsonb, p_writer text, p_person uuid DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_type text; v_status text; v_from text; v_to text; v_what text; v_about text; v_due date; v_basis text;
 v_open jsonb := '[]'; v_close jsonb := '[]'; c jsonb; chk jsonb; n integer := 0; v_opened_at timestamptz; v_closed_at timestamptz;
 v_any_customer boolean := false; v_any_us boolean := false; v_any_external boolean := false; v_due_ok boolean := false;
 v_first_customer boolean; v_first_us boolean; v_close_at timestamptz;
 v_key text; v_first text; v_facts jsonb := '[]'; f jsonb; v_supported date;
 roles constant text[] := ARRAY['us','crew','customer','supplier','insurer_builder','third_party','unknown'];
BEGIN
 IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'an item is a JSON object');
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'unknown field '
   || (SELECT min(k) FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')));
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each(p_item) kv WHERE kv.key NOT IN ('opened_by','closed_by','needs_reply')
   AND jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'text fields must be strings or null');
 END IF;
 v_type := p_item ->> 'item_type'; v_status := p_item ->> 'status'; v_from := p_item ->> 'from_role';
 v_to := nullif(p_item ->> 'to_role', '');
 -- the ledger's own words carry no em or en dashes (they reach outbound text)
 v_what := btrim(replace(regexp_replace(coalesce(p_item ->> 'what', ''), '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-'));
 v_about := nullif(btrim(p_item ->> 'about_key'), ''); v_basis := coalesce(nullif(p_item ->> 'due_basis', ''), 'none');
 IF p_writer = 'model' AND coalesce(length(btrim(p_item ->> 'ref')), 0) NOT BETWEEN 1 AND 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'ref is 1 to 60 characters');
 END IF;
 IF v_type IS NULL OR v_type NOT IN ('commitment','request','claim','issue','constraint','dependency','agreement','event','phase_note') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'item_type');
 END IF;
 IF v_status IS NULL OR v_status NOT IN ('open','closed','declined','superseded','info')
  OR (v_type IN ('event','phase_note') AND v_status <> 'info')
  OR (v_type NOT IN ('event','phase_note','agreement') AND v_status = 'info')
  OR (p_writer = 'person' AND v_status NOT IN ('open','info')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'status ' || coalesce(v_status, 'null') || ' for ' || v_type);
 END IF;
 IF v_from IS NULL OR NOT v_from = ANY(roles) OR (v_to IS NOT NULL AND NOT v_to = ANY(roles)) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'from_role or to_role');
 END IF;
 IF length(v_what) NOT BETWEEN 1 AND 600 OR length(coalesce(p_item ->> 'from_name', '')) > 120
  OR length(coalesce(p_item ->> 'to_name', '')) > 120 OR length(coalesce(p_item ->> 'also_concerns', '')) > 200 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'what 1 to 600, names up to 120, also_concerns up to 200');
 END IF;
 IF v_about IS NOT NULL AND v_about !~ '^(invoice|quote|booking|payment|variation|materials|scope|access|preference|defect|approval|contact|other):[a-z0-9]+(-[a-z0-9]+){0,4}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'about_key ' || left(v_about, 60));
 END IF;
 IF v_about LIKE 'booking:%' AND v_about !~ '^booking:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'booking about_key is booking:yyyy-mm-dd');
 END IF;
 IF (p_item ->> 'modality') IS NOT NULL AND (p_item ->> 'modality') NOT IN ('requested','offered','agreed','declined','reported','confirmed')
  OR (v_type = 'agreement' AND (p_item ->> 'modality') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'modality');
 END IF;
 IF (p_item ->> 'phase') IS NOT NULL AND (p_item ->> 'phase') NOT IN ('enquiry','scope','quote','accepted','deposit','approvals','materials',
   'scheduled','install','complete','invoice','payment','rectification','makesafe','other')
  OR (v_type = 'phase_note' AND (p_item ->> 'phase') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'phase');
 END IF;
 IF (p_item ->> 'closes_on') IS NOT NULL AND (p_item ->> 'closes_on') NOT IN ('reply','call','quote_sent','invoice_issued','payment',
   'booking_made','visit','work_done','record','person','none')
  OR (p_item ->> 'blocks') IS NOT NULL AND (p_item ->> 'blocks') NOT IN ('quote','acceptance','deposit','booking','install','completion','payment','none')
  OR coalesce(jsonb_typeof(p_item -> 'needs_reply'), 'null') NOT IN ('boolean','null')
  OR v_basis NOT IN ('stated','none')
  OR length(coalesce(p_item ->> 'supersedes_key', '')) > 200 OR length(coalesce(p_item ->> 'supersedes_ref', '')) > 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'closes_on, blocks, needs_reply, due_basis or supersedes');
 END IF;
 IF (p_item ->> 'due_date') IS NOT NULL THEN
  IF (p_item ->> 'due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is yyyy-mm-dd');
  END IF;
  BEGIN v_due := (p_item ->> 'due_date')::date;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is not a date'); END;
 END IF;
 IF v_basis = 'stated' AND v_due IS NULL THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_basis stated needs a due_date');
 END IF;
 IF coalesce(jsonb_typeof(p_item -> 'opened_by'), 'null') NOT IN ('array','null')
  OR coalesce(jsonb_typeof(p_item -> 'closed_by'), 'null') NOT IN ('array','null')
  OR jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) > 25
  OR jsonb_array_length(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) > 25 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by and closed_by are arrays of at most 25');
 END IF;
 IF p_writer = 'model' AND jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by needs at least one citation');
 END IF;
 -- Opening citations.
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'opened_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  v_open := v_open || jsonb_build_array(chk -> 'cite');
  v_facts := v_facts || jsonb_build_array(chk);
  v_opened_at := least(v_opened_at, (chk ->> 'at')::timestamptz);
  IF n = 1 THEN  -- the speaker is whoever sent the first opening citation
   v_first_customer := (chk ->> 'customer_sender')::boolean;
   v_first_us := (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  END IF;
  v_any_customer := v_any_customer OR (chk ->> 'customer_sender')::boolean;
  v_any_us := v_any_us OR (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  v_any_external := v_any_external OR NOT (chk ->> 'internal_text')::boolean;
 END LOOP;
 -- A person's item with no citation cites the person and their note.
 IF jsonb_array_length(v_open) = 0 THEN
  v_open := jsonb_build_array(jsonb_build_object('table', 'person', 'id', p_person::text, 'excerpt', p_note));
  v_opened_at := now();
 END IF;
 n := 0;
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'closed_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  -- Only an issued or sent record closes: no draft invoice, unsent document or
  -- unattended booking; never the opening row itself; a request strictly after it.
  v_close_at := CASE WHEN chk #>> '{cite,table}' = 'job_assignments' AND (p_item ->> 'closes_on') = 'booking_made'
                     THEN (chk ->> 'made_at')::timestamptz ELSE (chk ->> 'close_at')::timestamptz END;
  IF v_close_at IS NULL THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_not_issued', 'detail', 'closed_by[' || n || '] ' || (chk #>> '{cite,table}'));
  END IF;
  IF v_open @> jsonb_build_array(jsonb_build_object('table', chk #>> '{cite,table}', 'id', chk #>> '{cite,id}')) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_is_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  IF v_close_at < v_opened_at OR (v_type = 'request' AND v_close_at <= v_opened_at) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_before_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  v_close := v_close || jsonb_build_array(chk -> 'cite');
  v_closed_at := greatest(v_closed_at, v_close_at);
 END LOOP;
 IF v_status IN ('closed','declined') AND jsonb_array_length(v_close) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_without_evidence', 'detail', v_status || ' needs closed_by');
 END IF;
 IF v_status IN ('open','info') AND jsonb_array_length(v_close) > 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_by_on_open', 'detail', v_status || ' cannot carry closed_by');
 END IF;
 -- Who said it (the model only; a person's own item is their word).
 IF p_writer = 'model' THEN
  IF v_from = 'customer' AND NOT coalesce(v_first_customer, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_customer', 'detail', 'the first opening citation was not sent by this job''s customer');
  END IF;
  IF v_from = 'us' AND NOT coalesce(v_first_us, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_us', 'detail', 'the first opening citation is not ours, a call, a note or a record');
  END IF;
  IF v_to = 'customer' AND NOT v_any_external THEN
   RETURN jsonb_build_object('ok', false, 'code', 'internal_to_customer', 'detail', 'every opening citation is a crew or staff internal text');
  END IF;
 END IF;
 -- A due date only when an opening excerpt states it.
 IF v_due IS NOT NULL THEN
  FOR f IN SELECT x FROM jsonb_array_elements(v_facts) x LOOP
   IF NOT (f ->> 'record')::boolean AND NOT coalesce((f ->> 'automated')::boolean, false) AND coalesce(f #>> '{cite,excerpt}', '') <> '' THEN
    BEGIN
     v_supported := public.context_supported_due_date(f #>> '{cite,excerpt}', (f ->> 'at')::timestamptz);
    EXCEPTION WHEN OTHERS THEN v_supported := NULL;
    END;
    IF v_supported = v_due THEN v_due_ok := true; END IF;
   END IF;
  END LOOP;
  IF NOT v_due_ok OR v_basis <> 'stated' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'due_date_unsupported', 'detail', 'no opening excerpt states ' || v_due);
  END IF;
 END IF;
 v_first := v_open -> 0 ->> 'id';
 v_key := v_type || ':' || coalesce(v_about, 'none') || ':' || left(md5(v_first || lower(v_what)), 12);
 RETURN jsonb_build_object('ok', true, 'item', jsonb_build_object('ref', p_item ->> 'ref', 'item_key', v_key, 'item_type', v_type,
  'status', v_status, 'from_role', v_from, 'from_name', nullif(btrim(p_item ->> 'from_name'), ''), 'to_role', v_to,
  'to_name', nullif(btrim(p_item ->> 'to_name'), ''), 'what', v_what, 'about_key', v_about, 'modality', p_item ->> 'modality',
  'phase', p_item ->> 'phase', 'due_date', v_due, 'due_basis', v_basis, 'opened_at', v_opened_at, 'opened_by', v_open,
  'closed_at', v_closed_at, 'closed_by', CASE WHEN jsonb_array_length(v_close) > 0 THEN v_close END,
  'closes_on', p_item ->> 'closes_on', 'supersedes_key', nullif(btrim(p_item ->> 'supersedes_key'), ''),
  'supersedes_ref', nullif(btrim(p_item ->> 'supersedes_ref'), ''), 'blocks', p_item ->> 'blocks',
  'needs_reply', CASE WHEN jsonb_typeof(p_item -> 'needs_reply') = 'boolean' THEN (p_item ->> 'needs_reply')::boolean END, 'also_concerns', nullif(btrim(p_item ->> 'also_concerns'), '')));
END $$;
COMMENT ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) IS
 'Context ledger store (20261006013000): checks one ledger item for a job and returns the row to insert or {ok false, code, detail}. Shape (types, roles, about_key vocabulary, modality, phase, status per type), every citation (context_ledger_cite), closed or declined needs closed_by and nothing open carries it; a closing citation must be able to close (close_at: no draft invoice, unsent document or unattended booking: closing_not_issued), may not be an opening citation (closing_is_opening) and is at or after the opening, strictly after for a request (closing_before_opening); speaker rules for the model on the first opening citation (customer: the job''s customer sent it; us: ours, a call, a note or a record; nothing only internal texts is to the customer), a due date only when an opening excerpt states it and that message is not automated (context_supported_due_date); what has em and en dashes replaced. opened_at and closed_at come from the cited rows, never the input. item_key = type:about:first 12 hex of md5(first opening citation id || lower(what)). Service role only.';

-- 13. The write: custody for every item and transition.
CREATE OR REPLACE FUNCTION public.context_ledger_write(p_run_id uuid, p_lease_token uuid, p_generation_id uuid,
 p_items jsonb, p_transitions jsonb, p_reader text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; v_items jsonb := coalesce(p_items, '[]'::jsonb);
 v_trans jsonb := coalesce(p_transitions, '[]'::jsonb); v_hash text; v_prior jsonb; v_by text; it jsonb; chk jsonb;
 cands jsonb[] := '{}'; refused jsonb := '[]'::jsonb; accepted jsonb := '[]'::jsonb; t_refused jsonb := '[]'::jsonb;
 t_accepted integer := 0; k integer; m integer; v_changed boolean; v_cand jsonb; v_other jsonb; v_key text; v_found boolean;
 v_rep_at timestamptz; v_result jsonb; refs text[] := '{}'; keys text[] := '{}'; v_id uuid; tr jsonb; li public.context_ledger_items;
 v_ev jsonb; v_ev_at timestamptz; v_code text; v_detail text; c jsonb; n integer; v_ok boolean;
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_generation_id IS NULL
  OR jsonb_typeof(v_items) <> 'array' OR jsonb_typeof(v_trans) <> 'array'
  OR jsonb_array_length(v_items) > 200 OR jsonb_array_length(v_trans) > 200
  OR p_reader IS NULL OR p_reader !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' THEN
  RAISE EXCEPTION 'context_ledger_write_invalid';
 END IF;
 v_by := 'model:' || p_reader;
 v_hash := encode(sha256(convert_to(jsonb_build_array(p_generation_id, v_items, v_trans, p_reader)::text, 'UTF8')), 'hex');
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = p_run_id FOR UPDATE;
 IF r.id IS NULL OR r.phase <> 'ledger' THEN RAISE EXCEPTION 'context_ledger_write_invalid'; END IF;
 -- A repeated request in the same run gets its first answer back, unchanged.
 SELECT w.result INTO v_prior FROM public.context_ledger_writes w WHERE w.run_id = p_run_id AND w.request_sha256 = v_hash;
 IF v_prior IS NOT NULL THEN RETURN v_prior || jsonb_build_object('replayed', true); END IF;
 IF r.lease_token IS DISTINCT FROM p_lease_token OR r.status <> 'running' OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 IF NOT public.automation_lane_enabled('extraction')
  OR coalesce((SELECT st.mode FROM public.context_ledger_settings st WHERE st.id), 'off') = 'off' THEN
  RETURN jsonb_build_object('outcome', 'off');
 END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = p_generation_id FOR UPDATE;
 IF g.id IS NULL OR g.job_id IS DISTINCT FROM r.job_id
  OR NOT ((g.status = 'building' AND g.run_id = p_run_id)
   OR (g.id = public.context_ledger_current_generation(r.job_id)
    AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations b WHERE b.run_id = p_run_id))) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch');
 END IF;
 IF g.reader <> p_reader THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reader_mismatch'); END IF;
 SELECT coalesce(array_agg(i.item_key), '{}') INTO keys FROM public.context_ledger_items i WHERE i.generation_id = g.id;

 -- Pass 1: each item on its own.
 FOR it IN SELECT x FROM jsonb_array_elements(v_items) x LOOP
  chk := public.context_ledger_check_item(r.job_id, it, 'model');
  IF NOT (chk ->> 'ok')::boolean THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', it ->> 'ref', 'code', chk ->> 'code', 'detail', chk ->> 'detail'));
   CONTINUE;
  END IF;
  v_cand := chk -> 'item';
  -- A person's correction stands: the model may not write the same matter (same
  -- type, same first opening citation) again, in an update or a rebuild.
  IF EXISTS (SELECT 1 FROM public.context_ledger_items pl JOIN public.context_ledger_generations pg ON pg.id = pl.generation_id
             WHERE pl.job_id = g.job_id AND pl.person_locked AND (pl.generation_id = g.id OR pg.status = 'live')
               AND pl.item_type = v_cand ->> 'item_type'
               AND pl.opened_by -> 0 ->> 'table' = v_cand -> 'opened_by' -> 0 ->> 'table'
               AND pl.opened_by -> 0 ->> 'id' = v_cand -> 'opened_by' -> 0 ->> 'id') THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'person_locked',
    'detail', 'a person corrected this matter'));
   CONTINUE;
  END IF;
  IF (v_cand ->> 'ref') = ANY(refs) THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'duplicate_ref', 'detail', 'ref used twice in one write'));
   CONTINUE;
  END IF;
  refs := refs || (v_cand ->> 'ref');
  IF (v_cand ->> 'item_key') = ANY(keys) THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'duplicate_item', 'detail', v_cand ->> 'item_key'));
   CONTINUE;
  END IF;
  keys := keys || (v_cand ->> 'item_key');
  cands := cands || v_cand;
 END LOOP;

 -- Pass 2: supersedes_ref names an item of this write.
 FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
  IF cands[k] ->> 'supersedes_ref' IS NOT NULL THEN
   v_key := NULL;
   FOR m IN 1 .. array_length(cands, 1) LOOP
    IF m <> k AND cands[m] ->> 'ref' = cands[k] ->> 'supersedes_ref' THEN v_key := cands[m] ->> 'item_key'; END IF;
   END LOOP;
   IF v_key IS NULL OR (cands[k] ->> 'supersedes_key' IS NOT NULL AND cands[k] ->> 'supersedes_key' <> v_key) THEN
    cands[k] := cands[k] || jsonb_build_object('refused', 'supersedes_unresolved');
   ELSE
    cands[k] := cands[k] || jsonb_build_object('supersedes_key', v_key);
   END IF;
  END IF;
 END LOOP;
 -- Pass 3, to a fixed point: a supersedes_key names an existing or accepted
 -- item; a superseded item has an accepted or existing replacement.
 LOOP
  v_changed := false;
  FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
   CONTINUE WHEN cands[k] ? 'refused';
   IF cands[k] ->> 'supersedes_key' IS NOT NULL THEN
    v_found := EXISTS (SELECT 1 FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = cands[k] ->> 'supersedes_key');
    FOR m IN 1 .. array_length(cands, 1) LOOP
     IF m <> k AND NOT cands[m] ? 'refused' AND cands[m] ->> 'item_key' = cands[k] ->> 'supersedes_key' THEN v_found := true; END IF;
    END LOOP;
    IF NOT v_found THEN cands[k] := cands[k] || jsonb_build_object('refused', 'supersedes_unresolved'); v_changed := true; CONTINUE; END IF;
   END IF;
   IF cands[k] ->> 'status' = 'superseded' THEN
    v_rep_at := NULL;
    SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i
    WHERE i.generation_id = g.id AND i.supersedes_key = cands[k] ->> 'item_key';
    FOR m IN 1 .. array_length(cands, 1) LOOP
     IF m <> k AND NOT cands[m] ? 'refused' AND cands[m] ->> 'supersedes_key' = cands[k] ->> 'item_key' THEN
      v_rep_at := least(v_rep_at, (cands[m] ->> 'opened_at')::timestamptz);
     END IF;
    END LOOP;
    IF v_rep_at IS NULL THEN
     cands[k] := cands[k] || jsonb_build_object('refused', 'superseded_without_replacement'); v_changed := true; CONTINUE;
    END IF;
    IF cands[k] ->> 'closed_at' IS NULL THEN
     IF v_rep_at < (cands[k] ->> 'opened_at')::timestamptz THEN
      cands[k] := cands[k] || jsonb_build_object('refused', 'closing_before_opening'); v_changed := true; CONTINUE;
     END IF;
     cands[k] := cands[k] || jsonb_build_object('closed_at', v_rep_at);
    END IF;
   END IF;
  END LOOP;
  EXIT WHEN NOT v_changed;
 END LOOP;

 -- Insert what stands, each item whole or not at all.
 FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
  v_cand := cands[k];
  IF v_cand ? 'refused' THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', v_cand ->> 'refused',
    'detail', coalesce(v_cand ->> 'supersedes_key', v_cand ->> 'supersedes_ref', v_cand ->> 'item_key')));
   CONTINUE;
  END IF;
  BEGIN
   INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, from_name, to_role, to_name,
    what, about_key, modality, phase, due_date, due_basis, opened_at, opened_by, closed_at, closed_by, closes_on, supersedes_key,
    blocks, needs_reply, also_concerns, written_by, person_locked)
   VALUES (g.id, g.job_id, v_cand ->> 'item_key', v_cand ->> 'item_type', v_cand ->> 'status', v_cand ->> 'from_role',
    v_cand ->> 'from_name', v_cand ->> 'to_role', v_cand ->> 'to_name', v_cand ->> 'what', v_cand ->> 'about_key',
    v_cand ->> 'modality', v_cand ->> 'phase', (v_cand ->> 'due_date')::date, v_cand ->> 'due_basis',
    (v_cand ->> 'opened_at')::timestamptz, v_cand -> 'opened_by', (v_cand ->> 'closed_at')::timestamptz,
    CASE WHEN jsonb_typeof(v_cand -> 'closed_by') = 'array' THEN v_cand -> 'closed_by' END, v_cand ->> 'closes_on',
    v_cand ->> 'supersedes_key', v_cand ->> 'blocks', (v_cand ->> 'needs_reply')::boolean, v_cand ->> 'also_concerns', v_by, false)
   RETURNING id INTO v_id;
   INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
   VALUES (v_id, g.id, g.job_id, NULL, v_cand ->> 'status', v_by,
    CASE WHEN v_cand ->> 'status' IN ('closed','declined') THEN v_cand -> 'closed_by' ELSE v_cand -> 'opened_by' END, 'written');
   accepted := accepted || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'item_key', v_cand ->> 'item_key'));
  EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR invalid_text_representation THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'invalid_shape', 'detail', left(SQLERRM, 200)));
  END;
 END LOOP;

 -- Transitions on items of this generation.
 FOR tr IN SELECT x FROM jsonb_array_elements(v_trans) x LOOP
  v_code := NULL; v_detail := NULL; v_ev := '[]'::jsonb; v_ev_at := NULL;
  IF jsonb_typeof(tr) <> 'object'
   OR EXISTS (SELECT 1 FROM jsonb_object_keys(tr) kk WHERE kk NOT IN ('item_key','to_status','evidence','reason'))
   OR jsonb_typeof(tr -> 'item_key') IS DISTINCT FROM 'string'
   OR coalesce(tr ->> 'to_status', '') NOT IN ('open','closed','declined','superseded','disputed')
   OR coalesce(jsonb_typeof(tr -> 'evidence'), 'null') NOT IN ('array','null')
   OR jsonb_array_length(coalesce(nullif(tr -> 'evidence', 'null'::jsonb), '[]')) > 25
   OR coalesce(jsonb_typeof(tr -> 'reason'), 'null') NOT IN ('string','null') OR length(coalesce(tr ->> 'reason', '')) > 600 THEN
   v_code := 'invalid_shape'; v_detail := 'a transition is {item_key, to_status, evidence, reason}';
  END IF;
  IF v_code IS NULL THEN
   SELECT * INTO li FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = tr ->> 'item_key' FOR UPDATE;
   IF li.id IS NULL THEN v_code := 'unknown_item';
   ELSIF li.person_locked THEN v_code := 'person_locked';
   ELSIF li.status = tr ->> 'to_status' THEN v_code := 'no_change';
   END IF;
  END IF;
  IF v_code IS NULL THEN
   n := 0;
   FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(tr -> 'evidence', 'null'::jsonb), '[]')) x LOOP
    n := n + 1;
    chk := public.context_ledger_cite(g.job_id, c);
    IF NOT (chk ->> 'ok')::boolean THEN v_code := chk ->> 'code'; v_detail := 'evidence[' || n || '] ' || coalesce(chk ->> 'detail', ''); EXIT; END IF;
    IF tr ->> 'to_status' IN ('closed', 'declined') THEN
     -- the same closing rules as an item's closed_by (a booking_made item closes on a made booking)
     IF chk #>> '{cite,table}' = 'job_assignments' AND li.closes_on = 'booking_made' THEN
      chk := chk || jsonb_build_object('close_at', chk -> 'made_at');
     END IF;
     IF chk ->> 'close_at' IS NULL THEN v_code := 'closing_not_issued'; v_detail := 'evidence[' || n || '] ' || (chk #>> '{cite,table}'); EXIT; END IF;
     IF li.opened_by @> jsonb_build_array(jsonb_build_object('table', chk #>> '{cite,table}', 'id', chk #>> '{cite,id}')) THEN
      v_code := 'closing_is_opening'; v_detail := 'evidence[' || n || ']'; EXIT;
     END IF;
     IF (chk ->> 'close_at')::timestamptz < li.opened_at OR (li.item_type = 'request' AND (chk ->> 'close_at')::timestamptz <= li.opened_at) THEN
      v_code := 'evidence_older_than_item'; v_detail := 'evidence[' || n || ']'; EXIT;
     END IF;
     v_ev_at := greatest(v_ev_at, (chk ->> 'close_at')::timestamptz);
    ELSE
     IF (chk ->> 'at')::timestamptz < li.opened_at THEN v_code := 'evidence_older_than_item'; v_detail := 'evidence[' || n || ']'; EXIT; END IF;
     v_ev_at := greatest(v_ev_at, (chk ->> 'at')::timestamptz);
    END IF;
    v_ev := v_ev || jsonb_build_array(chk -> 'cite');
   END LOOP;
  END IF;
  IF v_code IS NULL AND tr ->> 'to_status' <> 'superseded' AND jsonb_array_length(v_ev) = 0 THEN
   v_code := 'evidence_missing'; v_detail := tr ->> 'to_status' || ' needs evidence';
  END IF;
  IF v_code IS NULL AND tr ->> 'to_status' = 'superseded' THEN
   SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.supersedes_key = li.item_key;
   IF v_rep_at IS NULL THEN v_code := 'superseded_without_replacement';
   ELSIF coalesce(v_ev_at, v_rep_at) < li.opened_at THEN v_code := 'closing_before_opening';
   ELSE v_ev_at := coalesce(v_ev_at, v_rep_at);
   END IF;
  END IF;
  IF v_code IS NOT NULL THEN
   t_refused := t_refused || jsonb_build_array(jsonb_build_object('item_key', tr ->> 'item_key', 'code', v_code, 'detail', v_detail));
   CONTINUE;
  END IF;
  UPDATE public.context_ledger_items SET status = tr ->> 'to_status',
   closed_at = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') THEN v_ev_at END,
   closed_by = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') AND jsonb_array_length(v_ev) > 0 THEN v_ev END,
   updated_at = now()
  WHERE id = li.id;
  INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
  VALUES (li.id, g.id, g.job_id, li.status, tr ->> 'to_status', v_by, CASE WHEN jsonb_array_length(v_ev) > 0 THEN v_ev END, tr ->> 'reason');
  t_accepted := t_accepted + 1;
 END LOOP;

 v_result := jsonb_build_object('outcome', 'written', 'generation_id', g.id, 'accepted', accepted, 'refused', refused,
  'transitions_accepted', t_accepted, 'transitions_refused', t_refused);
 INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused,
  transitions_accepted, transitions_refused, result)
 VALUES (p_run_id, g.id, g.job_id, v_hash, jsonb_array_length(accepted), jsonb_array_length(refused), t_accepted,
  jsonb_array_length(t_refused), v_result);
 UPDATE public.context_ledger_generations SET updated_at = now() WHERE id = g.id;
 RETURN v_result;
END $$;
COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000): writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only.';

-- 14. People's corrections follow the ledger: every person-locked item of one
-- generation is copied into another (same key, written_by kept); a model item
-- with the same key gives way. Idempotent.
CREATE OR REPLACE FUNCTION public.context_ledger_carry_forward(p_from uuid, p_to uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.context_ledger_items; t public.context_ledger_items; v_id uuid; n integer := 0;
BEGIN
 IF p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN RETURN 0; END IF;
 IF (SELECT g.job_id FROM public.context_ledger_generations g WHERE g.id = p_from)
  IS DISTINCT FROM (SELECT g.job_id FROM public.context_ledger_generations g WHERE g.id = p_to) THEN
  RAISE EXCEPTION 'context_ledger_carry_forward_invalid';
 END IF;
 FOR s IN SELECT * FROM public.context_ledger_items i WHERE i.generation_id = p_from AND i.person_locked ORDER BY i.opened_at, i.item_key LOOP
  SELECT * INTO t FROM public.context_ledger_items i WHERE i.generation_id = p_to AND i.item_key = s.item_key FOR UPDATE;
  IF t.id IS NOT NULL AND t.person_locked
   AND (t.status, t.what, t.closed_at, t.closed_by, t.written_by, t.opened_by)
    IS NOT DISTINCT FROM (s.status, s.what, s.closed_at, s.closed_by, s.written_by, s.opened_by) THEN
   CONTINUE;
  END IF;
  IF t.id IS NOT NULL THEN DELETE FROM public.context_ledger_items WHERE id = t.id; END IF;
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, from_name, to_role, to_name,
   what, about_key, modality, phase, due_date, due_basis, opened_at, opened_by, closed_at, closed_by, closes_on, supersedes_key,
   blocks, needs_reply, also_concerns, written_by, person_locked)
  VALUES (p_to, s.job_id, s.item_key, s.item_type, s.status, s.from_role, s.from_name, s.to_role, s.to_name, s.what, s.about_key,
   s.modality, s.phase, s.due_date, s.due_basis, s.opened_at, s.opened_by, s.closed_at, s.closed_by, s.closes_on, s.supersedes_key,
   s.blocks, s.needs_reply, s.also_concerns, s.written_by, true)
  RETURNING id INTO v_id;
  INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
  VALUES (v_id, p_to, s.job_id, t.status, s.status, 'rule:carry_forward', NULL, 'carried forward from generation ' || p_from);
  n := n + 1;
 END LOOP;
 RETURN n;
END $$;
COMMENT ON FUNCTION public.context_ledger_carry_forward(uuid, uuid) IS
 'Context ledger store (20261006013000): copies every person-locked item of one generation into another (same item_key, written_by kept, a rule:carry_forward transition); a model item with the same key in the target is replaced. Skips items already carried unchanged. Called by finish (built) and promote. Service role only.';

-- 15. Promote: shadow to live; the previous live retired after its people's
-- corrections are carried across. Idempotent.
CREATE OR REPLACE FUNCTION public.context_ledger_promote(p_generation_id uuid, p_by text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g public.context_ledger_generations; prev public.context_ledger_generations; v_carried integer := 0;
BEGIN
 IF p_generation_id IS NULL OR p_by IS NULL
  OR p_by !~ '^(rule:.{1,80}|person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
  RAISE EXCEPTION 'context_ledger_promote_invalid';
 END IF;
 IF p_by LIKE 'person:%' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = substr(p_by, 8)::uuid
   AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_staff');
 END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = p_generation_id FOR UPDATE;
 IF g.id IS NULL THEN RAISE EXCEPTION 'context_ledger_promote_invalid'; END IF;
 IF g.status = 'live' THEN RETURN jsonb_build_object('outcome', 'promoted', 'generation_id', g.id, 'already', true); END IF;
 IF g.status <> 'shadow' THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_shadow', 'status', g.status); END IF;
 SELECT * INTO prev FROM public.context_ledger_generations WHERE job_id = g.job_id AND status = 'live' FOR UPDATE;
 IF prev.id IS NOT NULL THEN
  v_carried := public.context_ledger_carry_forward(prev.id, g.id);
  UPDATE public.context_ledger_generations SET status = 'retired', retired_at = now(), updated_at = now() WHERE id = prev.id;
 END IF;
 UPDATE public.context_ledger_generations SET status = 'live', promoted_at = now(), updated_at = now(),
  checks = checks || jsonb_build_object('promoted_by', p_by)
 WHERE id = g.id;
 RETURN jsonb_build_object('outcome', 'promoted', 'generation_id', g.id, 'retired_generation_id', prev.id, 'carried', v_carried);
END $$;
COMMENT ON FUNCTION public.context_ledger_promote(uuid, text) IS
 'Context ledger store (20261006013000): promotes a shadow generation to live; the job''s previous live generation is retired after its person-locked items are carried forward. Idempotent on a live generation. p_by is rule:<name> (rule:auto from finish) or person:<user id> (an active staff user: admin, owner, ops_manager). Service role only.';

-- 15b. Bulk go-live. A shadow is promoted by finish only on its next clean
-- update, so when the owner switches the lane to live the shadows already
-- built would wait for new evidence. This promotes each job's newest shadow
-- now, under the same rule finish uses (context_ledger_checks_pass), through
-- context_ledger_promote (people's corrections carried forward the same way).
-- Only while the mode is live; a shadow older than the job's live generation,
-- or off the rollout list, is never promoted. Bounded by p_limit; repeatable.
CREATE OR REPLACE FUNCTION public.context_ledger_promote_shadow(p_by text, p_job_ids uuid[] DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_mode text; v_list uuid[]; v_limit integer := coalesce(p_limit, 200); x record; g public.context_ledger_generations;
 lv public.context_ledger_generations; v jsonb; v_reason text; promoted jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
 v_eligible integer := 0; v_tried integer := 0;
BEGIN
 IF p_by IS NULL OR p_by !~ '^(person|rule):.{1,80}$'
  OR (p_by LIKE 'person:%' AND p_by !~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  OR v_limit NOT BETWEEN 1 AND 1000 OR cardinality(p_job_ids) > 1000 THEN
  RAISE EXCEPTION 'context_ledger_promote_shadow_invalid';
 END IF;
 IF p_by LIKE 'person:%' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = substr(p_by, 8)::uuid
   AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_staff');
 END IF;
 SELECT st.mode, st.job_ids INTO v_mode, v_list FROM public.context_ledger_settings st WHERE st.id;
 IF v_mode IS DISTINCT FROM 'live' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_live', 'mode', coalesce(v_mode, 'off'));
 END IF;
 FOR x IN
  WITH sh AS (  -- each job's newest shadow
   SELECT DISTINCT ON (s.job_id) s.id, s.job_id, s.checks, s.created_at
   FROM public.context_ledger_generations s
   WHERE s.status = 'shadow' AND (p_job_ids IS NULL OR s.job_id = ANY(p_job_ids))
   ORDER BY s.job_id, s.created_at DESC, s.id DESC
  )
  SELECT sh.job_id, sh.id AS generation_id, sh.created_at,
   CASE WHEN v_list IS NOT NULL AND NOT (sh.job_id = ANY(v_list)) THEN 'not_in_rollout'
        WHEN l.id IS NOT NULL AND l.created_at >= sh.created_at THEN 'older_than_live'
        WHEN NOT public.context_ledger_checks_pass(sh.checks) THEN 'checks_failed' END AS skip
  FROM sh LEFT JOIN public.context_ledger_generations l ON l.job_id = sh.job_id AND l.status = 'live'
  UNION ALL
  SELECT DISTINCT r.job_id, NULL::uuid, NULL::timestamptz, 'no_shadow'
  FROM unnest(p_job_ids) AS r(job_id)
  WHERE r.job_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations s WHERE s.job_id = r.job_id AND s.status = 'shadow')
  ORDER BY 4 NULLS FIRST, 3, 2, 1
 LOOP
  v_reason := x.skip;
  IF v_reason IS NULL THEN
   v_eligible := v_eligible + 1;
   IF v_tried >= v_limit THEN CONTINUE; END IF;
   v_tried := v_tried + 1;
   -- Judge again under the row locks finish and promote take, so a reading
   -- that changed since the scan is never promoted on a stale answer.
   SELECT * INTO g FROM public.context_ledger_generations WHERE id = x.generation_id FOR UPDATE;
   SELECT * INTO lv FROM public.context_ledger_generations WHERE job_id = x.job_id AND status = 'live' FOR UPDATE;
   v_reason := CASE WHEN g.status IS DISTINCT FROM 'shadow' THEN 'not_shadow'
                    WHEN lv.id IS NOT NULL AND lv.created_at >= g.created_at THEN 'older_than_live'
                    WHEN NOT public.context_ledger_checks_pass(g.checks) THEN 'checks_failed' END;
   IF v_reason IS NULL THEN
    v := public.context_ledger_promote(g.id, p_by);
    IF v ->> 'outcome' = 'promoted' AND NOT coalesce((v ->> 'already')::boolean, false) THEN
     promoted := promoted || jsonb_build_array(jsonb_build_object('job_id', x.job_id, 'generation_id', g.id,
      'retired_generation_id', v -> 'retired_generation_id', 'carried', coalesce((v ->> 'carried')::integer, 0)));
     CONTINUE;
    END IF;
    v_reason := coalesce(v ->> 'reason', 'not_shadow');
   END IF;
  END IF;
  skipped := skipped || jsonb_build_array(jsonb_build_object('job_id', x.job_id, 'generation_id', x.generation_id, 'reason', v_reason));
 END LOOP;
 RETURN jsonb_build_object('outcome', 'done', 'mode', v_mode, 'by', p_by, 'limit', v_limit,
  'promoted', jsonb_array_length(promoted), 'skipped', jsonb_array_length(skipped), 'remaining', v_eligible - v_tried,
  'skipped_reasons', coalesce((SELECT jsonb_object_agg(z.reason, z.n) FROM (SELECT k ->> 'reason' AS reason, count(*) AS n
    FROM jsonb_array_elements(skipped) k GROUP BY 1) z), '{}'::jsonb),
  'promoted_generations', promoted, 'skipped_generations', skipped);
END $$;
COMMENT ON FUNCTION public.context_ledger_promote_shadow(text, uuid[], integer) IS
 'Context ledger store (20261006013000): bulk go-live. Only while context_ledger_settings.mode is live (else refused not_live). For each job with a shadow generation (all, or only p_job_ids), its newest shadow is promoted through context_ledger_promote when context_ledger_checks_pass (the rule finish uses) holds; skipped with a reason otherwise: checks_failed, older_than_live (the job''s live generation is as new or newer), not_in_rollout (settings.job_ids is set and does not list the job), no_shadow (a listed job with no shadow), not_shadow (changed under the scan). Each candidate is judged again under row locks. p_by is person:<user id> (an active staff user, else refused not_staff) or rule:<name>, 1 to 80 characters after the prefix. At most p_limit (1 to 1000) promotions per call; remaining counts the eligible rest. Returns counts, reasons and ids, never message text. Service role only.';

-- 16. Finish: close the run; built -> shadow (and promote when the lane is
-- live and the checks pass), updated -> evidence_until moves, failed.
CREATE OR REPLACE FUNCTION public.context_ledger_finish(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_outcome text, p_meta jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; m jsonb := coalesce(p_meta, '{}'::jsonb);
 v_until timestamptz; v_rows integer; v_chunks integer; v_calls integer; v_tokens integer; v_failure text; v_model text; v_sha text;
 v_acc integer; v_ref integer; v_items integer; v_rate numeric; v_pass boolean; v_store jsonb; v_promoted boolean := false;
 v_carried integer := 0; v_live uuid; v_mode text; v_build boolean; v_checks jsonb; v_proposed integer; v_local integer;
 v_den integer; v_all_rate numeric; v_released boolean; v_code text;
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_generation_id IS NULL OR p_outcome IS NULL
  OR p_outcome NOT IN ('built', 'updated', 'failed') OR jsonb_typeof(m) <> 'object' THEN
  RAISE EXCEPTION 'context_ledger_finish_invalid';
 END IF;
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = p_run_id FOR UPDATE;
 IF r.id IS NULL OR r.phase <> 'ledger' THEN RAISE EXCEPTION 'context_ledger_finish_invalid'; END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = p_generation_id FOR UPDATE;
 IF g.id IS NULL OR g.job_id IS DISTINCT FROM r.job_id THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch'); END IF;
 -- A repeated finish after the first one closed the run: report, change nothing.
 IF r.status IN ('done', 'failed') AND r.lease_token = p_lease_token THEN
  RETURN jsonb_build_object('outcome', p_outcome, 'replayed', true, 'run_status', r.status, 'generation_status', g.status,
   'promoted', g.status = 'live');
 END IF;
 IF r.lease_token IS DISTINCT FROM p_lease_token OR r.status <> 'running' OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 v_build := g.status = 'building' AND g.run_id = p_run_id;
 IF NOT (v_build OR (g.id = public.context_ledger_current_generation(r.job_id)
   AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations b WHERE b.run_id = p_run_id)))
  OR (p_outcome = 'built' AND NOT v_build) OR (p_outcome = 'updated' AND v_build) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch');
 END IF;
 BEGIN
  v_until := (m ->> 'evidence_until')::timestamptz;
  v_rows := greatest(0, coalesce((m ->> 'evidence_rows')::integer, 0));
  v_chunks := greatest(0, coalesce((m ->> 'chunks')::integer, 0));
  v_calls := greatest(0, coalesce((m ->> 'calls')::integer, 0));
  v_tokens := greatest(0, coalesce((m ->> 'tokens_in')::integer, 0));
  -- The reader's own count of what it proposed and what it refused before the
  -- store saw it: the promotion verdict counts both sides' refusals.
  v_proposed := greatest(0, coalesce((m #>> '{checks,proposed}')::integer, 0));
  v_local := greatest(0, coalesce((m #>> '{checks,refused_local}')::integer, 0));
 EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'invalid_meta', 'detail', left(SQLERRM, 200));
 END;
 v_model := left(nullif(btrim(m ->> 'model'), ''), 80);
 v_sha := CASE WHEN m ->> 'prompt_sha256' ~ '^[0-9a-f]{64}$' THEN m ->> 'prompt_sha256' END;
 v_failure := left(coalesce(nullif(btrim(m ->> 'failure'), ''), 'failed'), 190);
 IF p_outcome <> 'failed' AND (v_until IS NULL OR v_until > now()) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'invalid_meta', 'detail', 'evidence_until is required and not in the future');
 END IF;
 -- The reader cannot have read what landed after its claim: cap at the claim's instant.
 v_until := least(v_until, r.started_at);
 IF p_outcome = 'failed' THEN
  -- A stop is not a failure: the worker ran out of budget, was switched off,
  -- paused, rate limited, logged out or stopped. The run and a building
  -- generation are released and never count toward the backoff.
  v_released := v_failure IN ('ledger_budget', 'model_cap', 'ledger_off', 'lane_off', 'paused', 'rate_limited',
   'auth_required', 'worker_stopping');
  v_code := CASE WHEN v_released THEN 'released:' || v_failure ELSE v_failure END;
  IF v_build THEN
   UPDATE public.context_ledger_generations SET status = 'failed', failure = v_code, finished_at = now(), updated_at = now(),
    model = coalesce(v_model, model), chunks = v_chunks, calls = v_calls WHERE id = g.id;
  END IF;
  UPDATE public.context_extraction_runs SET status = 'failed', error = v_code, finished_at = now(), tokens_in = v_tokens,
   lease_expires_at = NULL WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'failed', 'released', v_released, 'generation_status', CASE WHEN v_build THEN 'failed' ELSE g.status END,
   'promoted', false);
 END IF;
 SELECT coalesce(sum(w.items_accepted), 0), coalesce(sum(w.items_refused), 0) INTO v_acc, v_ref
 FROM public.context_ledger_writes w WHERE w.run_id = p_run_id AND w.generation_id = g.id;
 SELECT count(*) INTO v_items FROM public.context_ledger_items i WHERE i.generation_id = g.id;
 v_rate := CASE WHEN v_acc + v_ref = 0 THEN 0 ELSE trim_scale(round(v_ref::numeric / (v_acc + v_ref), 4)) END;
 -- Refusals on both sides over everything proposed: the reader's local refusals
 -- plus the store's, over the larger of what the reader proposed and what the
 -- store saw.
 v_den := greatest(v_proposed, v_acc + v_ref, 1);
 v_all_rate := trim_scale(round((v_local + v_ref)::numeric / v_den, 4));
 v_pass := (v_local + v_ref) <= 0.2 * v_den AND v_ref <= 0.2 * (v_acc + v_ref);
 IF p_outcome = 'updated' THEN
  IF g.evidence_until IS NOT NULL AND v_until < g.evidence_until THEN
   RETURN jsonb_build_object('outcome', 'refused', 'reason', 'evidence_until_backwards');
  END IF;
  -- The one verdict: the build passed and this update is clean.
  UPDATE public.context_ledger_generations SET evidence_until = v_until, chunks = chunks + v_chunks, calls = calls + v_calls,
   updated_at = now(), checks = checks || jsonb_build_object(
    'passed', coalesce((checks #>> '{store,pass}')::boolean, false) AND v_pass,
    'last_update', jsonb_build_object('run_id', r.id, 'at', now(), 'items_accepted', v_acc, 'items_refused', v_ref,
     'proposed', v_proposed, 'refused_local', v_local, 'refused_rate', v_rate, 'refusal_rate', v_all_rate,
     'evidence_rows', v_rows, 'pass', v_pass, 'reader', m -> 'checks'))
  WHERE id = g.id RETURNING checks INTO v_checks;
  UPDATE public.context_extraction_runs SET status = 'done', finished_at = now(), events_in = v_rows, tokens_in = v_tokens,
   facts_new = v_acc, error = CASE WHEN v_pass THEN NULL ELSE 'checks_failed' END, lease_expires_at = NULL WHERE id = r.id;
  -- A shadow kept current while the lane was in shadow is promoted on its
  -- first update after the lane goes live, if the verdict holds
  -- (context_ledger_checks_pass reads checks.passed).
  SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
  IF v_mode = 'live' AND g.status = 'shadow' AND public.context_ledger_checks_pass(v_checks) THEN
   PERFORM public.context_ledger_promote(g.id, 'rule:auto');
   v_promoted := true;
  END IF;
  RETURN jsonb_build_object('outcome', 'updated', 'generation_status', CASE WHEN v_promoted THEN 'live' ELSE g.status END,
   'promoted', v_promoted, 'items_accepted', v_acc, 'items_refused', v_ref, 'passed', (v_checks ->> 'passed')::boolean,
   'evidence_until', v_until);
 END IF;
 -- built: the verdict also needs at least one item unless there was no evidence.
 v_pass := v_pass AND (v_items >= 1 OR v_rows = 0);
 v_store := jsonb_build_object('items', v_items, 'items_accepted', v_acc, 'items_refused', v_ref, 'refused_rate', v_rate,
  'proposed', v_proposed, 'refused_local', v_local, 'refusal_rate', v_all_rate, 'evidence_rows', v_rows, 'pass', v_pass);
 UPDATE public.context_ledger_generations SET status = 'shadow', model = v_model, prompt_sha256 = v_sha, evidence_until = v_until,
  evidence_rows = v_rows, chunks = v_chunks, calls = v_calls, finished_at = now(), updated_at = now(),
  checks = jsonb_build_object('passed', v_pass, 'store', v_store, 'reader', coalesce(m -> 'checks', 'null'::jsonb))
 WHERE id = g.id RETURNING checks INTO v_checks;
 SELECT id INTO v_live FROM public.context_ledger_generations WHERE job_id = g.job_id AND status = 'live';
 IF v_live IS NOT NULL THEN v_carried := public.context_ledger_carry_forward(v_live, g.id); END IF;
 -- A build that fails its checks counts toward the job's backoff.
 UPDATE public.context_extraction_runs SET status = 'done', finished_at = now(), events_in = v_rows, tokens_in = v_tokens,
  facts_new = v_acc, error = CASE WHEN v_pass THEN NULL ELSE 'checks_failed' END, lease_expires_at = NULL WHERE id = r.id;
 SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
 IF v_mode = 'live' AND public.context_ledger_checks_pass(v_checks) THEN
  PERFORM public.context_ledger_promote(g.id, 'rule:auto');
  v_promoted := true;
 END IF;
 RETURN jsonb_build_object('outcome', 'built', 'generation_status', CASE WHEN v_promoted THEN 'live' ELSE 'shadow' END,
  'promoted', v_promoted, 'carried', v_carried, 'passed', v_pass, 'checks', v_store, 'evidence_until', v_until);
END $$;
COMMENT ON FUNCTION public.context_ledger_finish(uuid, uuid, uuid, text, jsonb) IS
 'Context ledger store (20261006013000): closes a ledger run. evidence_until is capped at the claim''s instant (the run''s started_at) and returned. The verdict counts both sides'' refusals: (p_meta.checks.refused_local + store refusals) / greatest(p_meta.checks.proposed, store accepted + refused, 1) at most 20%, the store''s own refusals at most 20% of what it saw, and for a build at least one item unless there was no evidence; it is stored as checks.passed (a build: its verdict; an update: the build''s and this update''s), and a run whose verdict fails is done with error checks_failed (it counts toward the backoff). built: the run''s building generation becomes shadow with the reader''s meta (model, prompt_sha256, evidence_until, evidence_rows, chunks, calls, checks), the live generation''s person-locked items are carried forward, and with mode live and checks.passed it is promoted. updated: the current generation''s evidence_until moves forward (never back), and a shadow is promoted on its first update with checks.passed once mode is live. failed: a building generation fails with the reason; a live or shadow one is untouched. A stop (p_meta.failure ledger_budget, model_cap, ledger_off, lane_off, paused, rate_limited, auth_required or worker_stopping) is released, not failed: error and failure released:<code>, never counted toward the backoff. A repeated finish of a closed run reports and changes nothing. Service role only.';

-- 17. A person's correction on the live ledger.
CREATE OR REPLACE FUNCTION public.context_ledger_person_edit(p_job_id uuid, p_user_id uuid, p_action text, p_item_key text,
 p_note text, p_item jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g public.context_ledger_generations; li public.context_ledger_items; v_by text; v_note text; v_cite jsonb; chk jsonb;
 v_item jsonb; v_id uuid; v_to text;
BEGIN
 IF p_job_id IS NULL OR p_user_id IS NULL OR p_action IS NULL OR p_action NOT IN ('close', 'reopen', 'dispute', 'add') THEN
  RAISE EXCEPTION 'context_ledger_person_edit_invalid';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'code', 'not_staff');
 END IF;
 v_note := btrim(coalesce(p_note, ''));
 IF length(v_note) NOT BETWEEN 1 AND 600 THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'note_required'); END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE job_id = p_job_id AND status = 'live' FOR UPDATE;
 IF g.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'no_live_ledger'); END IF;
 v_by := 'person:' || p_user_id;
 v_cite := jsonb_build_array(jsonb_build_object('table', 'person', 'id', p_user_id::text, 'excerpt', v_note));
 IF p_action = 'add' THEN
  chk := public.context_ledger_check_item(p_job_id, p_item, 'person', p_user_id, v_note);
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('outcome', 'refused', 'code', chk ->> 'code', 'detail', chk ->> 'detail');
  END IF;
  v_item := chk -> 'item';
  IF EXISTS (SELECT 1 FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = v_item ->> 'item_key') THEN
   RETURN jsonb_build_object('outcome', 'refused', 'code', 'duplicate_item', 'item_key', v_item ->> 'item_key');
  END IF;
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, from_name, to_role, to_name,
   what, about_key, modality, phase, due_date, due_basis, opened_at, opened_by, closes_on, supersedes_key, blocks, needs_reply,
   also_concerns, written_by, person_locked)
  VALUES (g.id, p_job_id, v_item ->> 'item_key', v_item ->> 'item_type', v_item ->> 'status', v_item ->> 'from_role',
   v_item ->> 'from_name', v_item ->> 'to_role', v_item ->> 'to_name', v_item ->> 'what', v_item ->> 'about_key',
   v_item ->> 'modality', v_item ->> 'phase', (v_item ->> 'due_date')::date, v_item ->> 'due_basis',
   (v_item ->> 'opened_at')::timestamptz, v_item -> 'opened_by', v_item ->> 'closes_on', v_item ->> 'supersedes_key',
   v_item ->> 'blocks', (v_item ->> 'needs_reply')::boolean, v_item ->> 'also_concerns', v_by, true)
  RETURNING id INTO v_id;
  INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
  VALUES (v_id, g.id, p_job_id, NULL, v_item ->> 'status', v_by, v_cite, v_note);
  RETURN jsonb_build_object('outcome', 'edited', 'action', p_action, 'item_key', v_item ->> 'item_key', 'status', v_item ->> 'status',
   'generation_id', g.id);
 END IF;
 SELECT * INTO li FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = p_item_key FOR UPDATE;
 IF li.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'unknown_item'); END IF;
 v_to := CASE p_action WHEN 'close' THEN 'closed' WHEN 'reopen' THEN 'open' ELSE 'disputed' END;
 IF li.status = v_to THEN
  RETURN jsonb_build_object('outcome', 'no_change', 'item_key', li.item_key, 'status', li.status, 'generation_id', g.id);
 END IF;
 UPDATE public.context_ledger_items SET status = v_to, person_locked = true, updated_at = now(),
  closed_at = CASE WHEN v_to = 'closed' THEN greatest(now(), li.opened_at) END,
  closed_by = CASE WHEN v_to = 'closed' THEN v_cite END
 WHERE id = li.id;
 INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
 VALUES (li.id, g.id, p_job_id, li.status, v_to, v_by, v_cite, v_note);
 RETURN jsonb_build_object('outcome', 'edited', 'action', p_action, 'item_key', li.item_key, 'status', v_to, 'generation_id', g.id);
END $$;
COMMENT ON FUNCTION public.context_ledger_person_edit(uuid, uuid, text, text, text, jsonb) IS
 'Context ledger store (20261006013000): a staff user''s correction on a job''s live ledger: close, reopen, dispute (the item is wrong) or add (a person-written item, open or in force; citations optional, a citation-free item cites {table person, id user, excerpt note}). The item is person-locked so the model never changes it again, and a person:<user id> transition records the note. Refusals not_staff (users.role admin, owner, ops_manager), note_required, no_live_ledger, unknown_item, duplicate_item and item check codes; repeating the same correction is no_change. Service role only.';

-- 18. Access: service role only.
DO $grants$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ledger_text_norm(text)','public.context_ledger_message_kind(public.business_events)',
  'public.context_ledger_row_admissible(public.business_events)','public.context_ledger_evidence_rows(uuid[],timestamptz)',
  'public.context_ledger_current_generation(uuid)','public.context_ledger_judge(uuid[])','public.context_ledger_due(integer)',
  'public.context_ledger_claim(uuid,text,date)','public.context_ledger_packet(uuid,timestamptz,timestamptz)',
  'public.context_ledger_cite(uuid,jsonb)','public.context_ledger_check_item(uuid,jsonb,text,uuid,text)',
  'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)','public.context_ledger_carry_forward(uuid,uuid)',
  'public.context_ledger_promote(uuid,text)','public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)',
  'public.context_ledger_person_edit(uuid,uuid,text,text,text,jsonb)','public.context_ledger_checks_pass(jsonb)',
  'public.context_ledger_promote_shadow(text,uuid[],integer)','public.context_ledger_failures(uuid[])',
  'public.context_ledger_budget()','public.context_ledger_backfill_open(smallint,smallint,timestamptz)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
 END LOOP;
END $grants$;
