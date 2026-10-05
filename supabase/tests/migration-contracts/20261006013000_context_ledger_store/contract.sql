-- Contract: 20261006013000_context_ledger_store. Every fixture write is
-- rolled back. Ids, job numbers and text are synthetic. Evidence rows are
-- written straight in (pg_temp.lg_ev runs with session_replication_role
-- replica) so each fixture states exactly the columns the ledger reads.
--
--  1. Shape: functions, grants, comments, receipts table, phase checks.
--  2. The admission keeps every existing phase: the 20261006001000 body
--     (pg_temp.reserve_before, md5 proved equal to the live pre-image) and the
--     new body give identical answers and rows on the same fixtures.
--  3. Ledger admission: ledger_off, ledger_budget (own ceiling, live reserve
--     all day and before noon), stale, identity, lane.
--  4. The fact pass cannot see a ledger run: cadence, freshness, status
--     blocks, catch-up completion, the extraction claim and read flags are
--     identical with ledger runs present; ledger calls count in the total.
--  5. Due judgement (and the rollout list). 6. Claim. 7. Packet. 8. Write custody. 9. Finish,
--     promote and carry-forward. 10. Person corrections. 11. Bulk go-live.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.lg_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger store contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.lg_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;
CREATE FUNCTION pg_temp.lg_job(p_number text, p_email text DEFAULT NULL, p_status text DEFAULT 'scheduled', p_meta jsonb DEFAULT '{}')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', p_status, 'fencing', p_number, 'Pat Example', p_email, 'ghl-' || p_number,
  'Testville', p_meta, now() - interval '60 days');
 RETURN j;
END $$;
-- A placed evidence row. p_sender stamps metadata.party_roles (NULL = no stamp).
CREATE FUNCTION pg_temp.lg_ev(p_job uuid, p_type text, p_channel text, p_direction text, p_body text, p_ago interval,
 p_sender text DEFAULT NULL, p_basis text DEFAULT 'job_customer', p_payload jsonb DEFAULT '{}', p_meta jsonb DEFAULT '{}',
 p_status text DEFAULT 'direct', p_landed_ago interval DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid(); roles jsonb;
BEGIN
 roles := CASE WHEN p_sender IS NULL THEN NULL ELSE jsonb_build_object('version', 'party_roles_v2', 'sender_role', p_sender,
  'recipient_role', CASE WHEN p_sender = 'customer' THEN 'staff' WHEN p_direction = 'outbound' THEN 'customer' ELSE 'staff' END,
  'counterpart_role', CASE WHEN p_sender = 'staff' THEN 'customer' ELSE p_sender END, 'basis', p_basis,
  'audience', CASE WHEN p_sender = 'customer' OR p_direction = 'outbound' THEN 'customer' ELSE 'internal' END) END;
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, payload, metadata, occurred_at, event_at,
  recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 VALUES (v, p_job, p_type, 'ledger_contract', p_channel, p_direction, jsonb_build_object('body', p_body) || p_payload,
  jsonb_build_object('written_as', 'service_role') || CASE WHEN roles IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('party_roles', roles) END || p_meta,
  now() - p_ago, now() - p_ago, now() - coalesce(p_landed_ago, p_ago), now() - coalesce(p_landed_ago, p_ago), p_status, 1, 1,
  now() - coalesce(p_landed_ago, p_ago), 'direct_job_id');
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.lg_move(p_event uuid, p_job uuid) RETURNS void LANGUAGE sql SET session_replication_role = replica AS $$
 UPDATE public.business_events SET job_id = p_job WHERE id = p_event $$;
CREATE FUNCTION pg_temp.lg_inbox(p_job uuid, p_from text, p_subject text, p_body text, p_ago interval, p_class text DEFAULT 'client_reply',
 p_mailbox text DEFAULT 'office@secureworkswa.com.au') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.inbox_events (id, job_id, metadata, received_at, processed_at, graph_message_id, mailbox, subject, body_preview,
  from_email, from_name, to_email, classification)
 VALUES (v, p_job, '{}', now() - p_ago, now() - p_ago, 'g-' || v, p_mailbox, p_subject, p_body, p_from, 'Sender Name', p_mailbox, p_class);
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.lg_mode(p_mode text, p_calls integer DEFAULT 50, p_reader text DEFAULT 'luna-ledger:v1') RETURNS void LANGUAGE sql AS $$
 UPDATE public.context_ledger_settings SET mode = p_mode, calls_per_day = p_calls, reader = p_reader $$;
CREATE FUNCTION pg_temp.lg_lanes(p_capture boolean, p_attribution boolean, p_extraction boolean, p_all_stop boolean DEFAULT false)
RETURNS void LANGUAGE sql AS $$
 UPDATE public.automation_switches SET capture = p_capture, attribution = p_attribution, extraction = p_extraction, all_stop = p_all_stop WHERE id = 1 $$;
-- Exactly the given calls today, in order, every phase counting.
CREATE FUNCTION pg_temp.lg_calls(p_n integer, p_phase text DEFAULT 'attribution') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.lg_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.lg_today(), g, p_phase, now() FROM generate_series(1, p_n) g;
END $$;
CREATE FUNCTION pg_temp.lg_calls_add(p_n integer, p_phase text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m integer;
BEGIN
 SELECT coalesce(max(ordinal), 0) INTO m FROM public.context_model_call_reservations WHERE run_date = pg_temp.lg_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.lg_today(), m + g, p_phase, now() FROM generate_series(1, p_n) g;
END $$;
CREATE FUNCTION pg_temp.lg_run(p_job uuid, p_phase text, p_status text, p_lease interval, p_token uuid DEFAULT gen_random_uuid(),
 p_date date DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; s integer; d date := coalesce(p_date, pg_temp.lg_today());
BEGIN
 SELECT coalesce(max(run_seq), 0) + 1 INTO s FROM public.context_extraction_runs WHERE job_id = p_job AND run_date = d AND phase = p_phase;
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at, finished_at)
 VALUES (p_job, d, p_phase, p_status, p_token, CASE WHEN p_status = 'running' THEN now() + p_lease END, s, now() - interval '3 hours',
  CASE WHEN p_status <> 'running' THEN now() - interval '2 hours' END)
 RETURNING id INTO v;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.lg_token(p_run uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT lease_token FROM public.context_extraction_runs WHERE id = p_run $$;
CREATE FUNCTION pg_temp.lg_gen(p_job uuid, p_status text, p_until timestamptz, p_reader text DEFAULT 'luna-ledger:v1', p_ago interval DEFAULT '1 day')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, failure, created_at, finished_at, updated_at)
 VALUES (p_job, 'backfill', p_status, p_reader, p_until, CASE WHEN p_status = 'live' THEN now() - p_ago END,
  CASE WHEN p_status = 'failed' THEN 'test failure' END, now() - p_ago, now() - p_ago, now() - p_ago)
 RETURNING id INTO v;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.lg_item(p_gen uuid, p_key text, p_status text, p_cite uuid, p_locked boolean DEFAULT false, p_type text DEFAULT 'request',
 p_writer text DEFAULT 'model:luna-ledger:v1', p_opened timestamptz DEFAULT now() - interval '5 days') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by,
  closed_at, closed_by, written_by, person_locked)
 SELECT p_gen, g.job_id, p_key, p_type, p_status, 'customer', 'Fixture item ' || p_key, p_opened,
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', p_cite::text, 'excerpt', 'x')),
  CASE WHEN p_status IN ('closed','declined','superseded') THEN now() END,
  CASE WHEN p_status IN ('closed','declined') THEN jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', p_cite::text, 'excerpt', 'x')) END,
  p_writer, p_locked
 FROM public.context_ledger_generations g WHERE g.id = p_gen
 RETURNING id INTO v;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.lg_cite(p_id uuid, p_excerpt text, p_table text DEFAULT 'business_events') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(jsonb_build_object('table', p_table, 'id', p_id::text, 'excerpt', p_excerpt)) $$;
-- The refusal code a write gave one ref (NULL when accepted).
CREATE FUNCTION pg_temp.lg_code(p_result jsonb, p_ref text) RETURNS text LANGUAGE sql AS $$
 SELECT x ->> 'code' FROM jsonb_array_elements(p_result -> 'refused') x WHERE x ->> 'ref' = p_ref LIMIT 1 $$;
CREATE FUNCTION pg_temp.lg_accepted(p_result jsonb, p_ref text) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(p_result -> 'accepted') x WHERE x ->> 'ref' = p_ref) $$;
CREATE FUNCTION pg_temp.lg_tcode(p_result jsonb, p_key text) RETURNS text LANGUAGE sql AS $$
 SELECT x ->> 'code' FROM jsonb_array_elements(p_result -> 'transitions_refused') x WHERE x ->> 'item_key' = p_key LIMIT 1 $$;

-- 1. Shape.
DO $c$
DECLARE f text; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ledger_text_norm(text)','public.context_ledger_message_kind(public.business_events)',
  'public.context_ledger_row_admissible(public.business_events)','public.context_ledger_evidence_rows(uuid[],timestamptz)',
  'public.context_ledger_current_generation(uuid)','public.context_ledger_judge(uuid[])','public.context_ledger_due(integer)',
  'public.context_ledger_claim(uuid,text,date)','public.context_ledger_packet(uuid,timestamptz,timestamptz)',
  'public.context_ledger_cite(uuid,jsonb)','public.context_ledger_check_item(uuid,jsonb,text,uuid,text)',
  'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)','public.context_ledger_carry_forward(uuid,uuid)',
  'public.context_ledger_promote(uuid,text)','public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)',
  'public.context_ledger_person_edit(uuid,uuid,text,text,text,jsonb)','public.context_ledger_checks_pass(jsonb)',
  'public.context_ledger_promote_shadow(text,uuid[],integer)','public.reserve_context_model_call(text,uuid,uuid)'] LOOP
  PERFORM pg_temp.lg_assert(to_regprocedure(f) IS NOT NULL, f || ' missing');
  PERFORM pg_temp.lg_assert(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
   f || ' executable by anon or authenticated');
  PERFORM pg_temp.lg_assert(has_function_privilege('service_role', f, 'EXECUTE'), f || ' not executable by service_role');
  PERFORM pg_temp.lg_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), f || ' executable by PUBLIC');
  IF f NOT LIKE '%reserve_context_model_call%' THEN
   PERFORM pg_temp.lg_assert(obj_description(to_regprocedure(f), 'pg_proc') LIKE 'Context ledger store%', f || ' comment is not the owner marker');
  END IF;
 END LOOP;
 -- Store functions run as definer with a fixed path; per-row helpers carry no SET (they inline).
 FOR p IN SELECT pp.proname, pp.prosecdef, pp.proconfig FROM pg_proc pp JOIN pg_namespace n ON n.oid = pp.pronamespace
  WHERE n.nspname = 'public' AND pp.proname LIKE 'context_ledger_%' LOOP
  IF p.proname IN ('context_ledger_text_norm','context_ledger_message_kind','context_ledger_row_admissible','context_ledger_checks_pass') THEN
   PERFORM pg_temp.lg_assert(NOT p.prosecdef AND p.proconfig IS NULL, p.proname || ' must be an inlinable helper (no SET, no definer)');
  ELSE
   PERFORM pg_temp.lg_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], p.proname || ' must be definer with search_path public, pg_temp');
  END IF;
 END LOOP;
 PERFORM pg_temp.lg_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_extraction_runs'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'ledger'::text])))$d$),
  'runs phase check must admit ledger');
 PERFORM pg_temp.lg_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$d$),
  'reservations phase check must admit ledger');
 PERFORM pg_temp.lg_assert(obj_description('public.context_ledger_writes'::regclass, 'pg_class') LIKE 'Context ledger store:%', 'receipts comment');
 PERFORM pg_temp.lg_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_ledger_writes'::regclass), 'receipts RLS');
 PERFORM pg_temp.lg_assert(has_table_privilege('service_role', 'public.context_ledger_writes', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.context_ledger_writes', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.context_ledger_writes', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.context_ledger_writes', 'SELECT'), 'receipts privileges');
 -- The ledger tables stay read-only to service_role: writes go through the store.
 PERFORM pg_temp.lg_assert(NOT has_table_privilege('service_role', 'public.context_ledger_items', 'INSERT'), 'items writable by service_role');
 -- Nothing switched on: the lane stays off with no calls.
 PERFORM pg_temp.lg_assert((SELECT mode = 'off' AND calls_per_day = 0 FROM public.context_ledger_settings), 'ledger settings changed');
END $c$;

-- 2. Every existing phase answers exactly as before. pg_temp.reserve_before is
-- the 20261006001000 body, character for character (its md5 is checked
-- against the live pre-image f50de57b906f28fc9b5b286821d64cb1 below).
CREATE FUNCTION pg_temp.reserve_before(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket','vision')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase='extraction' AND p_run_id IS NULL)
 OR (p_phase='vision' AND p_run_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision') THEN 'extraction' ELSE 'attribution' END)
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
DO $c$ BEGIN
 PERFORM pg_temp.lg_assert((SELECT md5(prosrc) FROM pg_proc WHERE proname = 'reserve_before' AND pronamespace = pg_my_temp_schema())
  = 'f50de57b906f28fc9b5b286821d64cb1', 'the pre-image copy is not the live 20261006001000 body');
END $c$;
-- One call with either body, rolled back: the answer without its random id,
-- plus the reservation row it wrote, or the error it raised.
CREATE FUNCTION pg_temp.lg_try(p_which text, p_phase text, p_run uuid, p_tok uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; w jsonb; d text;
BEGIN
 BEGIN
  IF p_which = 'before' THEN r := pg_temp.reserve_before(p_phase, p_run, p_tok);
  ELSE r := public.reserve_context_model_call(p_phase, p_run, p_tok); END IF;
  SELECT jsonb_build_object('phase', m.phase, 'ordinal', m.ordinal, 'run_id', m.run_id, 'lease_token', m.lease_token, 'run_date', m.run_date)
  INTO w FROM public.context_model_call_reservations m WHERE m.id = (r ->> 'reservation_id')::uuid;
  r := (r - 'reservation_id') || jsonb_build_object('row', w, 'had_id', r ? 'reservation_id');
  RAISE EXCEPTION 'lg_rollback' USING DETAIL = r::text;
 EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
  IF SQLERRM = 'lg_rollback' THEN RETURN d::jsonb; END IF;
  RETURN jsonb_build_object('error', SQLERRM);
 END;
END $$;
CREATE TEMP TABLE lg_equiv (label text, before jsonb, after jsonb);
CREATE FUNCTION pg_temp.lg_same(p_label text, p_phase text, p_run uuid, p_tok uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a jsonb := pg_temp.lg_try('before', p_phase, p_run, p_tok); b jsonb := pg_temp.lg_try('after', p_phase, p_run, p_tok);
BEGIN
 INSERT INTO lg_equiv VALUES (p_label || ' ' || coalesce(p_phase, 'null'), a, b);
 PERFORM pg_temp.lg_assert(a IS NOT DISTINCT FROM b, format('phase %s in %s: before %s, after %s', p_phase, p_label, a, b));
END $$;
-- Every phase in one state: the no-run phases, a valid extraction run, and
-- an attribution run.
CREATE FUNCTION pg_temp.lg_all(p_label text, p_xrun uuid, p_arun uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_temp.lg_same(p_label, 'attribution', NULL, NULL);
 PERFORM pg_temp.lg_same(p_label, 'bucket', NULL, NULL);
 PERFORM pg_temp.lg_same(p_label, 'vision', NULL, NULL);
 PERFORM pg_temp.lg_same(p_label, 'extraction', p_xrun, pg_temp.lg_token(p_xrun));
 PERFORM pg_temp.lg_same(p_label || ' (run)', 'attribution', p_arun, pg_temp.lg_token(p_arun));
 PERFORM pg_temp.lg_same(p_label || ' (run)', 'bucket', p_arun, pg_temp.lg_token(p_arun));
END $$;

BEGIN;
DO $c$
DECLARE j uuid := pg_temp.lg_job('SWF-91001'); x uuid; a uuid; xs uuid; xl uuid; xd uuid; xy uuid; lr uuid; n integer;
BEGIN
 PERFORM pg_temp.lg_mode('shadow', 400);
 x := pg_temp.lg_run(j, 'extraction', 'running', '30 minutes');
 a := pg_temp.lg_run(j, 'attribution', 'running', '30 minutes');
 PERFORM pg_temp.lg_lanes(true, true, true); PERFORM pg_temp.lg_calls(0);
 PERFORM pg_temp.lg_all('empty day', x, a);
 -- Ledger and vision calls already on the day count the same for both bodies.
 PERFORM pg_temp.lg_calls(0); PERFORM pg_temp.lg_calls_add(20, 'vision'); PERFORM pg_temp.lg_calls_add(150, 'ledger');
 PERFORM pg_temp.lg_all('ledger and vision calls present', x, a);
 PERFORM pg_temp.lg_calls(0);
 PERFORM pg_temp.lg_lanes(true, true, false); PERFORM pg_temp.lg_all('extraction lane off', x, a);
 PERFORM pg_temp.lg_lanes(true, false, true); PERFORM pg_temp.lg_all('attribution lane off', x, a);
 PERFORM pg_temp.lg_lanes(false, true, true); PERFORM pg_temp.lg_all('capture lane off', x, a);
 PERFORM pg_temp.lg_lanes(true, true, true, true); PERFORM pg_temp.lg_all('all stop', x, a);
 PERFORM pg_temp.lg_lanes(true, true, true);
 PERFORM pg_temp.lg_calls(400); PERFORM pg_temp.lg_all('cap reached', x, a);
 PERFORM pg_temp.lg_calls(399); PERFORM pg_temp.lg_all('one call left', x, a);
 PERFORM pg_temp.lg_calls(60, 'attribution'); PERFORM pg_temp.lg_all('attribution budget spent', x, a);
 PERFORM pg_temp.lg_calls(59, 'attribution'); PERFORM pg_temp.lg_all('attribution one left', x, a);
 PERFORM pg_temp.lg_calls(199); PERFORM pg_temp.lg_all('vision ceiling edge', x, a);
 PERFORM pg_temp.lg_calls(200); PERFORM pg_temp.lg_all('vision ceiling passed', x, a);
 PERFORM pg_temp.lg_calls(0); PERFORM pg_temp.lg_calls_add(100, 'vision'); PERFORM pg_temp.lg_all('vision daily cap', x, a);
 PERFORM pg_temp.lg_calls(0); PERFORM pg_temp.lg_calls_add(250, 'ledger'); PERFORM pg_temp.lg_all('ledger spent past the live reserve', x, a);
 PERFORM pg_temp.lg_calls(0);
 -- Stale runs: expired lease, wrong token, wrong phase, finished, another day.
 xs := pg_temp.lg_run(j, 'extraction', 'running', '-1 minute');
 PERFORM pg_temp.lg_same('expired lease', 'extraction', xs, pg_temp.lg_token(xs));
 PERFORM pg_temp.lg_same('wrong token', 'extraction', x, gen_random_uuid());
 lr := pg_temp.lg_run(j, 'ledger', 'running', '30 minutes');
 PERFORM pg_temp.lg_same('ledger run as extraction', 'extraction', lr, pg_temp.lg_token(lr));
 PERFORM pg_temp.lg_same('extraction run as attribution', 'attribution', x, pg_temp.lg_token(x));
 xd := pg_temp.lg_run(j, 'extraction', 'done', '30 minutes');
 PERFORM pg_temp.lg_same('finished run', 'extraction', xd, pg_temp.lg_token(xd));
 xy := pg_temp.lg_run(j, 'extraction', 'running', '30 minutes', gen_random_uuid(), pg_temp.lg_today() - 1);
 PERFORM pg_temp.lg_same('yesterday''s run', 'extraction', xy, pg_temp.lg_token(xy));
 PERFORM pg_temp.lg_same('missing run', 'extraction', gen_random_uuid(), gen_random_uuid());
 -- Identity refusals.
 PERFORM pg_temp.lg_same('no run', 'extraction', NULL, NULL);
 PERFORM pg_temp.lg_same('vision with a run', 'vision', x, pg_temp.lg_token(x));
 PERFORM pg_temp.lg_same('run without token', 'attribution', x, NULL);
 PERFORM pg_temp.lg_same('unknown phase', 'transcription', NULL, NULL);
 PERFORM pg_temp.lg_same('no phase', NULL, NULL, NULL);
 SELECT count(*) INTO n FROM lg_equiv;
 PERFORM pg_temp.lg_assert(n = 96, 'expected 96 equivalence cases, ran ' || n);
 -- The only new answer: the ledger phase, which the old body refused outright.
 PERFORM pg_temp.lg_assert(pg_temp.lg_try('before', 'ledger', lr, pg_temp.lg_token(lr)) = '{"error":"Invalid model call identity"}',
  'the pre-image must refuse the ledger phase');
 PERFORM pg_temp.lg_assert(pg_temp.lg_try('after', 'ledger', lr, pg_temp.lg_token(lr)) ->> 'outcome' = 'reserved', 'the ledger phase must be admitted');
 -- The matrix covered every outcome the old body has.
 PERFORM pg_temp.lg_assert((SELECT array_agg(DISTINCT coalesce(after ->> 'outcome', 'error') ORDER BY coalesce(after ->> 'outcome', 'error')) FROM lg_equiv)
  = ARRAY['attribution_budget','cap','error','paused','reserved','stale','vision_budget','vision_reserve'], 'equivalence matrix does not reach every outcome');
END $c$;
ROLLBACK;

-- 3. The ledger's own admission: switched on, inside its ceiling, never in
-- the live reserve (the line the catch-up backlog stops at), all day and
-- before noon. pg_temp.lg_policy moves the morning boundary so both sides of
-- noon are tested at any clock time.
CREATE TABLE pg_temp.lg_base_policy AS SELECT public.context_cadence_policy() AS p;
CREATE FUNCTION pg_temp.lg_policy(p_over jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.lg_base_policy) || p_over);
END $$;
BEGIN;
DO $c$
DECLARE j uuid := pg_temp.lg_job('SWF-91002'); lr uuid; tok uuid; x uuid; r jsonb;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true);
 PERFORM pg_temp.lg_policy('{"morning_until":"00:00"}');   -- never morning
 lr := pg_temp.lg_run(j, 'ledger', 'running', '30 minutes'); tok := pg_temp.lg_token(lr);
 x := pg_temp.lg_run(j, 'extraction', 'running', '30 minutes');
 PERFORM pg_temp.lg_calls(0);
 PERFORM pg_temp.lg_mode('off', 0);
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) = '{"outcome":"ledger_off"}', 'mode off must answer ledger_off');
 PERFORM pg_temp.lg_mode('shadow', 3);
 r := public.reserve_context_model_call('ledger', lr, tok);
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1, 'first ledger call must be reserved: ' || r::text);
 PERFORM pg_temp.lg_assert((SELECT phase = 'ledger' AND run_id = lr AND lease_token = tok FROM public.context_model_call_reservations
  WHERE id = (r ->> 'reservation_id')::uuid), 'the ledger reservation row');
 PERFORM public.reserve_context_model_call('ledger', lr, tok); PERFORM public.reserve_context_model_call('ledger', lr, tok);
 r := public.reserve_context_model_call('ledger', lr, tok);
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'ledger_budget' AND r ->> 'reason' = 'ledger_calls_per_day' AND (r ->> 'limit')::integer = 3,
  'calls_per_day must stop the ledger: ' || r::text);
 -- The live reserve: 400 less 100 all day.
 PERFORM pg_temp.lg_mode('live', 400);
 PERFORM pg_temp.lg_calls(299);
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) ->> 'outcome' = 'reserved', 'call 300 is outside the live reserve');
 r := public.reserve_context_model_call('ledger', lr, tok);
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'ledger_budget' AND r ->> 'reason' = 'live_reserve' AND (r ->> 'ceiling')::integer = 300,
  'the ledger must never take the live reserve: ' || r::text);
 -- ...and the extraction pass still gets its reserve.
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('extraction', x, pg_temp.lg_token(x)) ->> 'outcome' = 'reserved',
  'extraction must still be admitted inside the live reserve');
 -- The desk's reserve is read from context_cadence_settings.
 INSERT INTO public.context_cadence_settings (id, live_reserve_calls_day, live_reserve_calls_morning, live_reserve_reads_per_job)
 VALUES (true, 50, 100, 2) ON CONFLICT (id) DO UPDATE SET live_reserve_calls_day = 50;
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) ->> 'outcome' = 'reserved', 'a 50-call reserve moves the line to 350');
 PERFORM pg_temp.lg_calls(350);
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) ->> 'reason' = 'live_reserve', 'line at 350');
 UPDATE public.context_cadence_settings SET live_reserve_calls_day = 100;
 -- Before noon: morning_cap 300 less the morning reserve 100.
 PERFORM pg_temp.lg_policy('{"morning_until":"23:59:59.999"}');
 PERFORM pg_temp.lg_calls(199);
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) ->> 'outcome' = 'reserved', 'morning call 200');
 r := public.reserve_context_model_call('ledger', lr, tok);
 PERFORM pg_temp.lg_assert(r ->> 'reason' = 'live_reserve_morning' AND (r ->> 'ceiling')::integer = 200, 'morning reserve: ' || r::text);
 PERFORM pg_temp.lg_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) ->> 'outcome' = 'reserved', 'after noon the morning line is gone');
 -- Stale and identity: the run must be a running ledger run holding its lease.
 PERFORM pg_temp.lg_calls(0);
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', x, pg_temp.lg_token(x)) = '{"outcome":"stale"}', 'an extraction run cannot buy a ledger call');
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, gen_random_uuid()) = '{"outcome":"stale"}', 'wrong token');
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('extraction', lr, tok) = '{"outcome":"stale"}', 'a ledger run cannot buy an extraction call');
 UPDATE public.context_extraction_runs SET lease_expires_at = now() - interval '1 second' WHERE id = lr;
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) = '{"outcome":"stale"}', 'lease lost');
 BEGIN
  PERFORM public.reserve_context_model_call('ledger', NULL, NULL);
  RAISE EXCEPTION 'ledger store contract: a ledger call without a run was accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Invalid model call identity' THEN RAISE; END IF;
 END;
 UPDATE public.context_extraction_runs SET lease_expires_at = now() + interval '10 minutes' WHERE id = lr;
 PERFORM pg_temp.lg_lanes(true, true, false);
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) = '{"outcome":"paused"}', 'the extraction lane switch stops the ledger');
 PERFORM pg_temp.lg_lanes(true, true, true);
 PERFORM pg_temp.lg_calls(400);
 PERFORM pg_temp.lg_assert(public.reserve_context_model_call('ledger', lr, tok) = '{"outcome":"cap"}', 'the 400 cap applies to the ledger');
END $c$;
ROLLBACK;

-- 4. The fact pass cannot see a ledger run. Every reader of
-- context_extraction_runs filters phase 'extraction'; this proves it on the
-- live judgement and every status block that composes it.
BEGIN;
DO $c$
DECLARE j uuid := pg_temp.lg_job('SWF-91003'); c uuid := pg_temp.lg_job('SWF-91004'); e uuid; xr uuid; lr uuid; r jsonb;
 cad0 jsonb; fr0 jsonb; st0 jsonb; core0 jsonb; pipe0 jsonb; fl0 jsonb; cand0 boolean; ready0 integer;
 cad1 jsonb; fr1 jsonb; st1 jsonb; core1 jsonb; pipe1 jsonb; fl1 jsonb; cand1 boolean; ready1 integer;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true); PERFORM pg_temp.lg_calls(0); PERFORM pg_temp.lg_mode('shadow', 50);
 -- live_since is the first apply time; move it back so a row captured 30
 -- minutes ago is live waking evidence whenever this runs.
 PERFORM pg_temp.lg_policy(jsonb_build_object('live_since', now() - interval '10 days'));
 -- A customer text 30 minutes ago wakes j for a fact read.
 e := pg_temp.lg_ev(j, 'client.reply', 'sms', 'inbound', 'Can you call me back about the gate?', '30 minutes', 'customer');
 -- An earlier finished extraction read, so last-read and flags have a value.
 PERFORM pg_temp.lg_run(j, 'extraction', 'done', '0');
 -- c is on the catch-up list with nothing left to read.
 INSERT INTO public.context_catchup_jobs (job_id, job_number, priority, mode, scope) VALUES (c, 'SWF-91004', 2, 'full', 'backlog');
 SELECT x.cadence INTO cad0 FROM public.context_jobs_cadence(ARRAY[j]) x;
 fr0 := public.context_job_freshness(j); st0 := public.context_cadence_status(); core0 := public.context_core_status();
 pipe0 := public.context_pipeline_status(); ready0 := public.context_ready_jobs_count(400);
 SELECT jsonb_agg(to_jsonb(f) ORDER BY f.event_id) INTO fl0 FROM public.context_extraction_event_flags(j, ARRAY[e]) f;
 cand0 := EXISTS (SELECT 1 FROM public.context_extraction_candidates(400) x WHERE x.job_id = j);
 PERFORM pg_temp.lg_assert((cad0 ->> 'due')::boolean AND cand0, 'fixture: j must be due a fact read');
 -- Ledger runs of every state on both jobs, through the store and directly.
 r := public.context_ledger_claim(j, 'backfill', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'claimed', 'fixture: ledger claim ' || r::text);
 lr := (r ->> 'run_id')::uuid;
 PERFORM pg_temp.lg_run(j, 'ledger', 'done', '0'); PERFORM pg_temp.lg_run(j, 'ledger', 'failed', '0');
 PERFORM pg_temp.lg_run(c, 'ledger', 'done', '0'); PERFORM pg_temp.lg_run(c, 'ledger', 'running', '30 minutes');
 UPDATE public.context_extraction_runs SET status = 'done', finished_at = now() WHERE job_id = c AND phase = 'ledger' AND status = 'running';
 SELECT x.cadence INTO cad1 FROM public.context_jobs_cadence(ARRAY[j]) x;
 fr1 := public.context_job_freshness(j); st1 := public.context_cadence_status(); core1 := public.context_core_status();
 pipe1 := public.context_pipeline_status(); ready1 := public.context_ready_jobs_count(400);
 SELECT jsonb_agg(to_jsonb(f) ORDER BY f.event_id) INTO fl1 FROM public.context_extraction_event_flags(j, ARRAY[e]) f;
 cand1 := EXISTS (SELECT 1 FROM public.context_extraction_candidates(400) x WHERE x.job_id = j);
 PERFORM pg_temp.lg_assert(cad0 = cad1, format('cadence moved: %s -> %s', cad0, cad1));
 PERFORM pg_temp.lg_assert((cad1 ->> 'runs_today')::integer = 1 AND NOT (cad1 ->> 'run_live')::boolean, 'runs_today and run_live must count extraction only');
 PERFORM pg_temp.lg_assert(fr0 = fr1, format('freshness moved: %s -> %s', fr0, fr1));
 PERFORM pg_temp.lg_assert(st0 = st1, 'cadence status block moved');
 PERFORM pg_temp.lg_assert(core0 = core1, 'core status moved');
 PERFORM pg_temp.lg_assert(pipe0 = pipe1, 'pipeline status moved');
 PERFORM pg_temp.lg_assert(fl0 = fl1, 'extraction read flags moved');
 PERFORM pg_temp.lg_assert(cand0 = cand1 AND ready0 = ready1, 'extraction candidates moved');
 -- A done ledger run never completes catch-up; a done extraction run does (control).
 PERFORM pg_temp.lg_assert((SELECT done_at IS NULL FROM public.context_catchup_jobs WHERE job_id = c), 'a ledger run completed catch-up');
 PERFORM pg_temp.lg_run(c, 'extraction', 'done', '0');
 PERFORM pg_temp.lg_assert((SELECT done_at IS NOT NULL FROM public.context_catchup_jobs WHERE job_id = c), 'control: an extraction run must complete catch-up');
 -- The extraction claim is not busy while a ledger run holds a lease.
 r := public.claim_context_extraction_run(j, pg_temp.lg_today(), 'extraction');
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'claimed' AND r #>> '{run,phase}' = 'extraction', 'extraction claim with a ledger run live: ' || r::text);
 -- The ledger run renews through the shared renewal (the worker's reserved runner).
 PERFORM pg_temp.lg_assert(public.renew_context_extraction_run(lr, (SELECT lease_token FROM public.context_extraction_runs WHERE id = lr)),
  'renew_context_extraction_run must renew a ledger lease');
 -- Ledger calls do count in the shared daily total (intended).
 PERFORM public.reserve_context_model_call('ledger', lr, (SELECT lease_token FROM public.context_extraction_runs WHERE id = lr));
 SELECT x.cadence INTO cad1 FROM public.context_jobs_cadence(ARRAY[c]) x;
 PERFORM pg_temp.lg_assert((cad1 ->> 'model_calls_today')::integer = 1, 'a ledger call must count in model_calls_today');
END $c$;
ROLLBACK;

-- 5. The due judgement.
BEGIN;
DO $c$
DECLARE a uuid; b uuid; b2 uuid; c uuid; d uuid; e uuid; f uuid; g uuid; h uuid; i uuid; s uuid; o uuid; m uuid; gid uuid;
 ev uuid; got text[]; r record; cl jsonb;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true); PERFORM pg_temp.lg_mode('shadow', 50);
 -- Leave only this section's jobs in view: earlier fixtures were rolled back.
 a := pg_temp.lg_job('SWF-92001'); PERFORM pg_temp.lg_ev(a, 'client.reply', 'sms', 'inbound', 'Is the fence still going ahead?', '5 days', 'customer');
 b := pg_temp.lg_job('SWF-92002'); PERFORM pg_temp.lg_ev(b, 'client.reply', 'sms', 'inbound', 'First message', '9 days', 'customer');
 PERFORM pg_temp.lg_ev(b, 'client.reply', 'sms', 'inbound', 'A new message since the last read', '1 hour', 'customer');
 PERFORM pg_temp.lg_gen(b, 'live', now() - interval '2 days');
 b2 := pg_temp.lg_job('SWF-92003'); PERFORM pg_temp.lg_ev(b2, 'client.reply', 'sms', 'inbound', 'Old message', '9 days', 'customer');
 PERFORM pg_temp.lg_gen(b2, 'live', now());
 c := pg_temp.lg_job('SWF-92004'); o := pg_temp.lg_job('SWF-92005');
 ev := pg_temp.lg_ev(c, 'client.reply', 'sms', 'inbound', 'This message will move to another job', '6 days', 'customer');
 PERFORM pg_temp.lg_ev(c, 'client.reply', 'sms', 'inbound', 'This one stays', '6 days', 'customer');
 gid := pg_temp.lg_gen(c, 'live', now()); PERFORM pg_temp.lg_item(gid, 'request:none:aaaaaaaaaaaa', 'open', ev);
 PERFORM pg_temp.lg_move(ev, o);
 d := pg_temp.lg_job('SWF-92006'); PERFORM pg_temp.lg_ev(d, 'client.reply', 'sms', 'inbound', 'Read by an old reader', '4 days', 'customer');
 PERFORM pg_temp.lg_gen(d, 'live', now(), 'luna-ledger:v0');
 e := pg_temp.lg_job('SWF-92007'); PERFORM pg_temp.lg_ev(e, 'client.reply', 'sms', 'inbound', 'Being read now', '4 days', 'customer');
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, run_id)
 VALUES (e, 'backfill', 'building', 'luna-ledger:v1', pg_temp.lg_run(e, 'ledger', 'running', '20 minutes'));
 f := pg_temp.lg_job('SWF-92008'); PERFORM pg_temp.lg_ev(f, 'client.reply', 'sms', 'inbound', 'A read failed an hour ago', '4 days', 'customer');
 PERFORM pg_temp.lg_gen(f, 'failed', NULL, 'luna-ledger:v1', '1 hour');
 g := pg_temp.lg_job('SWF-92009', NULL, 'scheduled', '{"do_not_schedule": true}');
 PERFORM pg_temp.lg_ev(g, 'client.reply', 'sms', 'inbound', 'A holding job', '4 days', 'customer');
 h := pg_temp.lg_job('SWF-92010');
 PERFORM pg_temp.lg_ev(h, 'client.sms_out', 'sms', 'outbound', 'Reminder: your booking is tomorrow', '4 days', 'staff', 'job_customer', '{"sent_by_kind":"workflow"}');
 PERFORM pg_temp.lg_ev(h, 'invoice.raised', 'invoice', 'outbound', 'Invoice INV-9 raised for 100.00', '4 days');
 i := pg_temp.lg_job('SWF-92011', NULL, 'complete'); PERFORM pg_temp.lg_ev(i, 'client.reply', 'sms', 'inbound', 'Finished job', '4 days', 'customer');
 s := pg_temp.lg_job('SWF-92012'); PERFORM pg_temp.lg_ev(s, 'client.reply', 'sms', 'inbound', 'New since the shadow read', '2 hours', 'customer');
 PERFORM pg_temp.lg_gen(s, 'shadow', now() - interval '1 day');
 m := pg_temp.lg_job('SWF-92013'); PERFORM pg_temp.lg_ev(m, 'client.reply', 'sms', 'inbound', 'A ledger run failed an hour ago', '4 days', 'customer');
 ev := pg_temp.lg_run(m, 'ledger', 'failed', '0');
 UPDATE public.context_extraction_runs SET finished_at = now() - interval '1 hour' WHERE id = ev;
 -- The judgement, job by job.
 FOR r IN SELECT * FROM public.context_ledger_judge(ARRAY[a,b,b2,c,d,e,f,g,h,i,s,m]) LOOP
  PERFORM pg_temp.lg_assert(CASE r.job_id
   WHEN a THEN r.due AND r.kind = 'backfill' AND r.reason = 'never_read' AND r.priority = 2
   WHEN b THEN r.due AND r.kind = 'update' AND r.reason = 'new_evidence' AND r.priority = 1
   WHEN b2 THEN NOT r.due AND r.kind IS NULL AND r.blocked_reason IS NULL
   WHEN c THEN r.due AND r.kind = 'rebuild' AND r.reason = 'citation_moved' AND r.priority = 1
   WHEN d THEN r.due AND r.kind = 'rebuild' AND r.reason = 'reader_changed' AND r.priority = 3
   WHEN e THEN NOT r.due AND r.blocked_reason = 'busy'
   WHEN f THEN NOT r.due AND r.blocked_reason = 'backoff'
   WHEN g THEN NOT r.due AND r.blocked_reason = 'holding_job'
   WHEN h THEN NOT r.due AND r.blocked_reason = 'no_evidence'
   WHEN i THEN NOT r.due AND r.blocked_reason = 'not_live'
   WHEN s THEN r.due AND r.kind = 'update' AND r.reason = 'new_evidence'
   WHEN m THEN NOT r.due AND r.blocked_reason = 'backoff' END,
   format('judgement for %s: %s', (SELECT job_number FROM public.jobs WHERE id = r.job_id), to_jsonb(r)));
 END LOOP;
 -- The due list: only due jobs, new evidence and moved citations first
 -- (newest evidence first), then never-read (SWF-92005 now holds the moved
 -- message and has never been read), then reader changes.
 SELECT array_agg(jb.job_number ORDER BY x.ord) INTO got
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
 JOIN public.jobs jb ON jb.id = x.job_id WHERE jb.job_number LIKE 'SWF-920%';
 PERFORM pg_temp.lg_assert(got = ARRAY['SWF-92002','SWF-92012','SWF-92004','SWF-92001','SWF-92005','SWF-92006'], 'due order ' || array_to_string(got, ','));
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM public.context_ledger_due(2)) = 2, 'limit');
 -- A staged start: with a rollout list only the listed job is due; an unlisted job that
 -- would be due is blocked not_in_rollout, so the due list skips it and a claim is not_due.
 UPDATE public.context_ledger_settings SET job_ids = ARRAY[a];
 PERFORM pg_temp.lg_assert((SELECT r2.due AND r2.kind = 'backfill' AND r2.blocked_reason IS NULL FROM public.context_ledger_judge(ARRAY[a]) r2),
  'a job on the rollout list stays due');
 PERFORM pg_temp.lg_assert((SELECT NOT r2.due AND r2.kind = 'update' AND r2.blocked_reason = 'not_in_rollout' FROM public.context_ledger_judge(ARRAY[b]) r2),
  'a job off the rollout list is blocked not_in_rollout');
 SELECT array_agg(jb.job_number ORDER BY x.ord) INTO got
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
 JOIN public.jobs jb ON jb.id = x.job_id;
 PERFORM pg_temp.lg_assert(got = ARRAY['SWF-92001'], 'due with a rollout list ' || coalesce(array_to_string(got, ','), '<none>'));
 cl := public.context_ledger_claim(b, 'update', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(cl ->> 'outcome' = 'not_due' AND cl ->> 'reason' = 'not_in_rollout', 'claim off the rollout list: ' || cl::text);
 PERFORM pg_temp.lg_assert(NOT EXISTS (SELECT 1 FROM public.context_extraction_runs WHERE job_id = b AND phase = 'ledger'), 'a refused claim made a run');
 UPDATE public.context_ledger_settings SET job_ids = '{}';
 PERFORM pg_temp.lg_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200)), 'an empty rollout list: nothing is due');
 UPDATE public.context_ledger_settings SET job_ids = NULL;
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM public.context_ledger_due(200) x JOIN public.jobs jb ON jb.id = x.job_id
  WHERE jb.job_number LIKE 'SWF-920%') = 6, 'no rollout list: every live job again');
 PERFORM pg_temp.lg_mode('off', 0);
 PERFORM pg_temp.lg_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200)), 'mode off: the due list must be empty');
 PERFORM pg_temp.lg_mode('shadow', 50); PERFORM pg_temp.lg_lanes(true, true, false);
 PERFORM pg_temp.lg_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200)), 'extraction lane off: the due list must be empty');
END $c$;
ROLLBACK;

-- 6. The claim.
BEGIN;
DO $c$
DECLARE a uuid; b uuid; k uuid; r jsonb; r2 jsonb; gl uuid; run public.context_extraction_runs;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true);
 a := pg_temp.lg_job('SWF-93001'); PERFORM pg_temp.lg_ev(a, 'client.reply', 'sms', 'inbound', 'When can you start?', '5 days', 'customer');
 PERFORM pg_temp.lg_mode('off', 0);
 PERFORM pg_temp.lg_assert(public.context_ledger_claim(a, 'backfill', pg_temp.lg_today()) = '{"outcome":"off"}', 'mode off');
 PERFORM pg_temp.lg_mode('shadow', 50); PERFORM pg_temp.lg_lanes(true, true, false);
 PERFORM pg_temp.lg_assert(public.context_ledger_claim(a, 'backfill', pg_temp.lg_today()) = '{"outcome":"off"}', 'lane off');
 PERFORM pg_temp.lg_lanes(true, true, true);
 BEGIN
  PERFORM public.context_ledger_claim(a, 'backfill', pg_temp.lg_today() - 1);
  RAISE EXCEPTION 'ledger store contract: a claim for another day was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'context_ledger_claim_invalid' THEN RAISE; END IF; END;
 r := public.context_ledger_claim(a, 'update', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'not_due' AND r ->> 'kind' = 'backfill', 'asking the wrong kind is not_due: ' || r::text);
 r := public.context_ledger_claim(a, 'backfill', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'claimed' AND r ->> 'mode' = 'shadow' AND r -> 'since' = 'null'::jsonb
  AND r ->> 'generation_status' = 'building' AND r ->> 'reader' = 'luna-ledger:v1', 'backfill claim: ' || r::text);
 SELECT * INTO run FROM public.context_extraction_runs WHERE id = (r ->> 'run_id')::uuid;
 PERFORM pg_temp.lg_assert(run.phase = 'ledger' AND run.status = 'running' AND run.run_seq = 1 AND run.lease_token = (r ->> 'lease_token')::uuid
  AND run.lease_expires_at BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes', 'the ledger run row');
 PERFORM pg_temp.lg_assert((SELECT run_id = run.id AND kind = 'backfill' FROM public.context_ledger_generations WHERE id = (r ->> 'generation_id')::uuid),
  'the building generation names its run');
 PERFORM pg_temp.lg_assert(public.context_ledger_claim(a, 'backfill', pg_temp.lg_today()) = '{"outcome":"busy"}', 'second claim is busy');
 -- A building generation whose run lost its lease is failed, and the job backs off.
 UPDATE public.context_extraction_runs SET lease_expires_at = now() - interval '1 minute' WHERE id = run.id;
 r2 := public.context_ledger_claim(a, 'backfill', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(r2 ->> 'outcome' = 'not_due' AND r2 ->> 'reason' = 'backoff', 'lapsed build backs off: ' || r2::text);
 PERFORM pg_temp.lg_assert((SELECT status = 'failed' AND failure = 'lease_expired' FROM public.context_ledger_generations WHERE id = (r ->> 'generation_id')::uuid)
  AND (SELECT status = 'failed' FROM public.context_extraction_runs WHERE id = run.id), 'lapsed build is failed with its run');
 -- After the backoff a second read the same day takes run_seq 2.
 UPDATE public.context_ledger_generations SET finished_at = now() - interval '3 hours', updated_at = now() - interval '3 hours' WHERE id = (r ->> 'generation_id')::uuid;
 UPDATE public.context_extraction_runs SET finished_at = now() - interval '3 hours' WHERE id = run.id;
 r := public.context_ledger_claim(a, 'backfill', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'claimed' AND (SELECT run_seq FROM public.context_extraction_runs WHERE id = (r ->> 'run_id')::uuid) = 2, 'run_seq 2: ' || r::text);
 -- Update: no new generation; since is the current generation's evidence_until.
 b := pg_temp.lg_job('SWF-93002'); PERFORM pg_temp.lg_ev(b, 'client.reply', 'sms', 'inbound', 'Old', '9 days', 'customer');
 PERFORM pg_temp.lg_ev(b, 'client.reply', 'sms', 'inbound', 'New', '1 hour', 'customer');
 gl := pg_temp.lg_gen(b, 'live', now() - interval '2 days');
 r := public.context_ledger_claim(b, 'update', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(r ->> 'outcome' = 'claimed' AND (r ->> 'generation_id')::uuid = gl AND r ->> 'generation_status' = 'live'
  AND (r ->> 'since')::timestamptz = (SELECT evidence_until FROM public.context_ledger_generations WHERE id = gl), 'update claim: ' || r::text);
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM public.context_ledger_generations WHERE job_id = b) = 1, 'update made a generation');
 PERFORM pg_temp.lg_assert(public.context_ledger_claim(b, 'update', pg_temp.lg_today()) = '{"outcome":"busy"}', 'a running update run is busy');
END $c$;
ROLLBACK;

-- 7. The packet: admission, copies, caps, roles, update window, open items.
BEGIN;
DO $c$
DECLARE p uuid; other uuid; q uuid; pk jsonb; ev jsonb; ids uuid[]; want uuid[]; gl uuid; t timestamptz; k integer;
 p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; p7 uuid; p8 uuid; p8b uuid; p8c uuid; p9 uuid; p10 uuid; p11 uuid; p12 uuid; p13 uuid;
 p14 uuid; i1 uuid; i1b uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid; i6 uuid; i7 uuid; i8 uuid; be5 uuid;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true); PERFORM pg_temp.lg_mode('shadow', 50);
 p := pg_temp.lg_job('SWF-94001', 'pat@example.test'); other := pg_temp.lg_job('SWF-94002');
 p1 := pg_temp.lg_ev(p, 'client.reply', 'sms', 'inbound', 'Can you quote the side gate as well?', '10 days', 'customer');
 p2 := pg_temp.lg_ev(p, 'client.sms_out', 'sms', 'outbound', 'Yes, we will add it to the quote.', '9 days 23 hours', 'staff');
 p3 := pg_temp.lg_ev(p, 'client.sms_out', 'sms', 'outbound', 'Reminder: your booking is tomorrow', '9 days', 'staff', 'job_customer', '{"sent_by_kind":"workflow"}');
 p4 := pg_temp.lg_ev(p, 'invoice.raised', 'invoice', 'outbound', 'Invoice raised for 2,000.00', '8 days');
 p5 := pg_temp.lg_ev(p, 'note.added', 'note', 'internal', 'Customer prefers mornings.', '8 days');
 p6 := pg_temp.lg_ev(p, 'call.transcript_completed', 'call', 'inbound', repeat('t', 7000), '7 days', 'customer', 'job_customer', '{"body":null}'::jsonb || jsonb_build_object('transcript', repeat('t', 7000)));
 p7 := pg_temp.lg_ev(p, 'client.email_in', 'email', 'inbound', repeat('e', 4000), '6 days 12 hours', 'customer', 'job_customer', '{"from":"pat@example.test","subject":"Long mail"}');
 p8 := pg_temp.lg_ev(p, 'client.email_in', 'email', 'inbound', 'Same email delivered to two mailboxes', '6 days', 'customer', 'job_customer', '{"from":"pat@example.test"}');
 p8b := pg_temp.lg_ev(p, 'client.email_in', 'email', 'inbound', E'Same  email delivered to\ntwo mailboxes', '5 days 23 hours 59 minutes', 'customer', 'job_customer', '{"from":"pat@example.test"}');
 p8c := pg_temp.lg_ev(p, 'client.email_in', 'email', 'inbound', 'Same email delivered to two mailboxes', '5 days 23 hours', 'customer', 'job_customer', '{"from":"pat@example.test"}');
 p9 := pg_temp.lg_ev(p, 'client.reply', 'sms', 'inbound', 'Unplaced bucket row', '5 days', 'customer', 'job_customer', '{}', '{}', 'admin_bucket');
 p10 := pg_temp.lg_ev(p, 'client.reply', 'sms', 'inbound', 'A retracted row', '5 days', 'customer', 'job_customer', '{}', jsonb_build_object('retracted_at', now()));
 p11 := pg_temp.lg_ev(p, 'client.reply', 'sms', 'inbound', 'Written by a browser session', '5 days', 'customer', 'job_customer', '{}', '{"written_as":"authenticated"}');
 p12 := pg_temp.lg_ev(p, 'client.sms_out', 'sms', 'outbound', 'New job assigned: SWF-94001 Testville', '4 days', 'crew', 'ladder_internal', '{}', '{"audience":"internal"}');
 p13 := pg_temp.lg_ev(other, 'client.reply', 'sms', 'inbound', 'On another job', '4 days', 'customer');
 p14 := pg_temp.lg_ev(p, 'client.reply', 'sms', 'inbound', 'A row the job has not read yet', '3 days', 'customer', 'any_job_customer');
 -- Legacy mail.
 i1 := pg_temp.lg_inbox(NULL, 'Pat@Example.test ', 'Gate', 'Legacy mail from the client address', '12 days');
 i1b := pg_temp.lg_inbox(NULL, 'pat@example.test', 'Gate', 'Legacy mail from the client address', '11 days 23 hours 59 minutes 30 seconds', 'client_reply', 'admin@secureworkswa.com.au');
 i2 := pg_temp.lg_inbox(p, 'pat@example.test', 'Copied', 'Has an evidence copy', '11 days');
 PERFORM set_config('session_replication_role', 'replica', true);
 INSERT INTO public.business_events (job_id, event_type, source, channel, direction, payload, metadata, occurred_at, event_at, attribution_status,
  attribution_confidence, source_table, source_id)
 VALUES (other, 'client.email_in', 'monitor-inbox', 'email', 'inbound', '{"body":"Has an evidence copy"}', '{"written_as":"service_role"}',
  now() - interval '11 days', now() - interval '11 days', 'direct', 1, 'inbox_events', i2::text);
 PERFORM set_config('session_replication_role', 'origin', true);
 i3 := pg_temp.lg_inbox(p, 'pat@example.test', 'Win now', 'Spam text', '10 days', 'spam');
 i4 := pg_temp.lg_inbox(p, 'neighbour@example.test', 'Fence line', 'Mail on the job from someone else', '9 days', 'other');
 i5 := pg_temp.lg_inbox(p, 'pat@example.test', 'Same instant', 'Same mail the reader also saved', '2 days', 'other');
 be5 := pg_temp.lg_ev(other, 'client.email_in', 'email', 'inbound', 'Same mail the reader also saved, full body', '2 days', 'customer', 'job_customer', '{"from":"pat@example.test"}');
 UPDATE public.business_events SET event_at = (SELECT received_at FROM public.inbox_events WHERE id = i5) WHERE id = be5;
 i6 := pg_temp.lg_inbox(p, 'pat@example.test', 'Automatic reply: away', 'I am away', '2 days');
 -- An old-path copy names its inbox row only in its payload (no source pointer, another instant).
 i8 := pg_temp.lg_inbox(p, 'pat@example.test', 'Old path', 'Named by an old-path copy', '10 days 12 hours', 'other');
 PERFORM set_config('session_replication_role', 'replica', true);
 INSERT INTO public.business_events (job_id, event_type, source, channel, direction, payload, metadata, occurred_at, event_at, attribution_status,
  attribution_confidence)
 VALUES (other, 'client.email_in', 'ghl-proxy', 'email', 'inbound', jsonb_build_object('body', 'Named by an old-path copy', 'inbox_events_id', i8::text),
  '{"written_as":"service_role"}', now() - interval '10 days 11 hours', now() - interval '10 days 11 hours', 'direct', 1);
 PERFORM set_config('session_replication_role', 'origin', true);
 i7 := pg_temp.lg_inbox(p, 'office@secureworkswa.com.au', 'Internal', 'Mail from our own office', '1 day', 'other');
 pk := public.context_ledger_packet(p);
 ev := pk -> 'evidence';
 SELECT array_agg((x ->> 'id')::uuid ORDER BY o) INTO ids FROM jsonb_array_elements(ev) WITH ORDINALITY y(x, o);
 want := ARRAY[i1, p1, p2, i4, p5, p6, p7, p8, p8c, p12, p14, i7];
 PERFORM pg_temp.lg_assert(ids = want, format('evidence ids/order: got %s want %s', ids, want));
 PERFORM pg_temp.lg_assert(pk ->> 'version' = 'ledger-packet-v1' AND (pk ->> 'evidence_rows')::integer = 12
  AND (pk ->> 'truncated_rows')::integer = 2 AND (pk ->> 'duplicates_collapsed')::integer = 2, 'packet counts: ' || (pk - 'evidence')::text);
 PERFORM pg_temp.lg_assert((pk ->> 'evidence_until')::timestamptz = (SELECT processed_at FROM public.inbox_events WHERE id = i7), 'evidence_until');
 PERFORM pg_temp.lg_assert(public.context_ledger_cite(p, jsonb_build_object('table', 'inbox_events', 'id', i8::text, 'excerpt', 'Named by'))
  ->> 'code' = 'citation_not_admissible', 'a mail with an old-path copy is cited by its copy, never itself');
 -- Caps: 6,000 for transcripts and document text, 3,000 otherwise.
 PERFORM pg_temp.lg_assert(length(ev -> 5 ->> 'text') = 6000 AND length(ev -> 6 ->> 'text') = 3000, 'text caps');
 -- Roles come from the stored stamp, never invented.
 PERFORM pg_temp.lg_assert(ev -> 1 ->> 'sender_role' = 'customer' AND ev -> 1 ->> 'role_basis' = 'job_customer' AND ev -> 1 ->> 'sender' = 'Pat Example'
  AND ev -> 1 ->> 'ours' = 'false', 'customer text roles');
 PERFORM pg_temp.lg_assert(ev -> 2 ->> 'ours' = 'true' AND ev -> 2 ->> 'recipient_role' = 'customer' AND ev -> 2 ->> 'automated' = 'false', 'our text');
 PERFORM pg_temp.lg_assert(ev -> 4 -> 'sender_role' = 'null'::jsonb AND ev -> 4 ->> 'channel' = 'note', 'an unstamped note has no role');
 PERFORM pg_temp.lg_assert(ev -> 9 ->> 'automated' = 'true' AND ev -> 9 ->> 'sender_role' = 'crew', 'a crew alert text is automated');
 PERFORM pg_temp.lg_assert(ev -> 10 ->> 'role_basis' = 'any_job_customer', 'basis carried so the reader can tell this job''s customer');
 PERFORM pg_temp.lg_assert(ev -> 0 ->> 'table' = 'inbox_events' AND ev -> 0 ->> 'sender_role' = 'customer' AND ev -> 0 ->> 'role_basis' = 'client_email'
  AND ev -> 0 ->> 'subject' = 'Gate', 'legacy client mail');
 PERFORM pg_temp.lg_assert(ev -> 3 -> 'sender_role' = 'null'::jsonb AND ev -> 11 ->> 'ours' = 'true' AND ev -> 11 ->> 'sender_role' = 'staff', 'other legacy mail');
 PERFORM pg_temp.lg_assert(pk -> 'job' ->> 'customer_contact_ref' = 'ghl-SWF-94001' AND pk -> 'parties' -> 0 ->> 'role' = 'customer'
  AND jsonb_array_length(pk -> 'open_items') = 0, 'job and parties');
 -- as_of replays: nothing recorded after it.
 pk := public.context_ledger_packet(p, NULL, now() - interval '7 days 12 hours');
 PERFORM pg_temp.lg_assert((pk ->> 'evidence_rows')::integer = 5, 'as_of replay rows: ' || (pk ->> 'evidence_rows'));
 -- Update window: rows recorded after since, plus the six before the first.
 q := pg_temp.lg_job('SWF-94003');
 FOR k IN 1 .. 10 LOOP
  PERFORM pg_temp.lg_ev(q, 'client.reply', 'sms', 'inbound', 'Old message ' || k, make_interval(days => 20 - k), 'customer');
 END LOOP;
 PERFORM pg_temp.lg_ev(q, 'client.reply', 'sms', 'inbound', 'New after the read', '2 hours', 'customer');
 -- an old message placed on the job only today counts as new
 PERFORM pg_temp.lg_ev(q, 'client.reply', 'sms', 'inbound', 'Old message placed today', '12 days 12 hours', 'customer', 'job_customer', '{}', '{}', 'direct', '1 hour');
 gl := pg_temp.lg_gen(q, 'live', now() - interval '1 day');
 PERFORM pg_temp.lg_item(gl, 'request:none:000000000001', 'open', p1);
 PERFORM pg_temp.lg_item(gl, 'request:none:000000000002', 'closed', p1);
 PERFORM pg_temp.lg_item(gl, 'event:none:000000000003', 'info', p1, false, 'event');
 PERFORM pg_temp.lg_item(gl, 'request:none:000000000004', 'disputed', p1, true);
 pk := public.context_ledger_packet(q, now() - interval '1 day');
 PERFORM pg_temp.lg_assert((pk ->> 'evidence_rows')::integer = 8, 'update window rows: ' || (pk ->> 'evidence_rows'));
 PERFORM pg_temp.lg_assert(pk -> 'evidence' -> 0 ->> 'text' = 'Old message 2' AND pk -> 'evidence' -> 6 ->> 'text' = 'Old message placed today'
  AND pk -> 'evidence' -> 7 ->> 'text' = 'New after the read', 'window starts six rows before the first new row');
 PERFORM pg_temp.lg_assert((SELECT array_agg(x ->> 'item_key' ORDER BY x ->> 'item_key') FROM jsonb_array_elements(pk -> 'open_items') x)
  = ARRAY['event:none:000000000003','request:none:000000000001','request:none:000000000004'], 'update open_items: open, disputed, in force');
 pk := public.context_ledger_packet(q);
 PERFORM pg_temp.lg_assert((pk ->> 'evidence_rows')::integer = 12 AND jsonb_array_length(pk -> 'open_items') = 1
  AND pk -> 'open_items' -> 0 ->> 'item_key' = 'request:none:000000000004', 'a rebuild packet lists only person-locked items');
 BEGIN
  PERFORM public.context_ledger_packet(gen_random_uuid());
  RAISE EXCEPTION 'ledger store contract: a packet for a missing job';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'context_ledger_packet_job_not_found' THEN RAISE; END IF; END;
END $c$;
ROLLBACK;

-- 8. Write custody: every refusal, the accepted path, replay and lease.
CREATE FUNCTION pg_temp.lg_key(p_result jsonb, p_ref text) RETURNS text LANGUAGE sql AS $$
 SELECT x ->> 'item_key' FROM jsonb_array_elements(p_result -> 'accepted') x WHERE x ->> 'ref' = p_ref LIMIT 1 $$;
CREATE FUNCTION pg_temp.lg_it(p_ref text, p_type text, p_status text, p_from text, p_to text, p_what text, p_open jsonb,
 p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('ref', p_ref, 'item_type', p_type, 'status', p_status, 'from_role', p_from, 'to_role', p_to,
  'what', p_what, 'opened_by', p_open) || p_extra $$;
BEGIN;
DO $c$
DECLARE w uuid; other uuid; w0 uuid; w1 uuid; w2 uuid; w3 uuid; w4 uuid; w5 uuid; w6 uuid; iw uuid; xi uuid := gen_random_uuid();
 jd uuid := gen_random_uuid(); cl jsonb; run uuid; tok uuid; gen uuid; items jsonb; res jsonb; res2 jsonb; d date; dtext text;
 code text; exp record; it public.context_ledger_items; n integer; ogen uuid; k_inbox text; k_due text; k_quote text;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true); PERFORM pg_temp.lg_mode('shadow', 50);
 w := pg_temp.lg_job('SWF-95001', 'pat@example.test'); other := pg_temp.lg_job('SWF-95002');
 -- A stated date four days after the customer's message, written the way people write it.
 d := ((now() - interval '3 days') AT TIME ZONE 'Australia/Perth')::date + 4;
 dtext := to_char(d, 'FMDay FMDD FMMonth');
 w0 := pg_temp.lg_ev(w, 'client.reply', 'sms', 'inbound', 'Hello, just checking in.', '12 days', 'customer');
 w1 := pg_temp.lg_ev(w, 'client.reply', 'sms', 'inbound', 'Could you please send the quote for the rest of the fence by ' || dtext || E'? It’s urgent.', '3 days', 'customer');
 w2 := pg_temp.lg_ev(w, 'client.sms_out', 'sms', 'outbound', 'Yes, we will send it by ' || dtext || '.', '2 days', 'staff');
 w3 := pg_temp.lg_ev(w, 'client.sms_out', 'sms', 'outbound', 'New job assigned: SWF-95001 Testville', '2 days', 'crew', 'ladder_internal', '{}', '{"audience":"internal"}');
 w4 := pg_temp.lg_ev(other, 'client.reply', 'sms', 'inbound', 'Please send the quote', '3 days', 'customer');
 w5 := pg_temp.lg_ev(w, 'client.reply', 'sms', 'inbound', 'Please send the quote', '3 days', 'customer', 'job_customer', '{}', '{}', 'admin_bucket');
 w6 := pg_temp.lg_ev(w, 'client.reply', 'sms', 'inbound', 'Thanks, got the quote.', '1 day', 'customer');
 iw := pg_temp.lg_inbox(NULL, 'pat@example.test', 'Gate', 'Please also price a gate on the side.', '5 days');
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_type, job_id, invoice_number, status, created_at, updated_at)
 VALUES (xi, '00000000-0000-0000-0000-000000000001', 'xi-' || xi, 'ACCREC', w, 'INV-9001', 'AUTHORISED', now() - interval '4 days', now());
 INSERT INTO public.job_documents (id, job_id, type, version, created_at) VALUES (jd, other, 'quote', 1, now() - interval '4 days');
 cl := public.context_ledger_claim(w, 'backfill', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(cl ->> 'outcome' = 'claimed', 'fixture claim ' || cl::text);
 run := (cl ->> 'run_id')::uuid; tok := (cl ->> 'lease_token')::uuid; gen := (cl ->> 'generation_id')::uuid;
 items := jsonb_build_array(
  pg_temp.lg_it('ok_req', 'request', 'closed', 'customer', 'us', 'Asked for the quote for the rest of the fence',
   pg_temp.lg_cite(w1, 'Could you please send the quote for the rest of the fence'),
   jsonb_build_object('about_key', 'quote:rest-of-fence', 'closed_by', pg_temp.lg_cite(w6, 'got the quote'), 'closes_on', 'quote_sent',
    'blocks', 'quote', 'needs_reply', true, 'phase', 'quote')),
  pg_temp.lg_it('ok_quote', 'claim', 'open', 'customer', 'us', 'Says the quote is urgent', pg_temp.lg_cite(w1, 'It''s urgent')),
  pg_temp.lg_it('ok_due', 'commitment', 'open', 'us', 'customer', 'Promised the quote by the stated day',
   pg_temp.lg_cite(w2, 'we will send it by ' || dtext), jsonb_build_object('due_date', d, 'due_basis', 'stated', 'about_key', 'quote:rest-of-fence')),
  pg_temp.lg_it('ok_inbox', 'request', 'open', 'customer', 'us', 'Asked for a gate price', pg_temp.lg_cite(iw, 'price a gate', 'inbox_events')),
  pg_temp.lg_it('ok_record', 'event', 'info', 'us', 'customer', 'Invoice issued', pg_temp.lg_cite(xi, 'INV-9001', 'xero_invoices'),
   '{"about_key":"invoice:inv-9001"}'),
  pg_temp.lg_it('wrong_job', 'request', 'open', 'customer', 'us', 'x1', pg_temp.lg_cite(w4, 'Please send the quote')),
  pg_temp.lg_it('not_adm', 'request', 'open', 'customer', 'us', 'x2', pg_temp.lg_cite(w5, 'Please send the quote')),
  pg_temp.lg_it('missing', 'request', 'open', 'customer', 'us', 'x3', pg_temp.lg_cite(gen_random_uuid(), 'anything')),
  pg_temp.lg_it('bad_table', 'request', 'open', 'customer', 'us', 'x4', pg_temp.lg_cite(w1, 'quote', 'users')),
  pg_temp.lg_it('person_tab', 'request', 'open', 'customer', 'us', 'x5', pg_temp.lg_cite(w1, 'quote', 'person')),
  pg_temp.lg_it('rec_off_job', 'event', 'info', 'us', NULL, 'x6', pg_temp.lg_cite(jd, 'quote', 'job_documents')),
  pg_temp.lg_it('not_verbatim', 'request', 'open', 'customer', 'us', 'x7', pg_temp.lg_cite(w1, 'send the full quote')),
  pg_temp.lg_it('no_excerpt', 'request', 'open', 'customer', 'us', 'x8', pg_temp.lg_cite(w1, NULL)),
  pg_temp.lg_it('too_long', 'request', 'open', 'customer', 'us', 'x9', pg_temp.lg_cite(w1, repeat('q', 401))),
  pg_temp.lg_it('spk_cust', 'request', 'open', 'customer', 'us', 'x10', pg_temp.lg_cite(w2, 'we will send it')),
  pg_temp.lg_it('spk_us', 'commitment', 'open', 'us', 'customer', 'x11', pg_temp.lg_cite(w1, 'Could you please')),
  pg_temp.lg_it('internal', 'commitment', 'open', 'us', 'customer', 'x12', pg_temp.lg_cite(w3, 'New job assigned')),
  pg_temp.lg_it('close_early', 'request', 'closed', 'customer', 'us', 'x13', pg_temp.lg_cite(w1, 'Could you please'),
   jsonb_build_object('closed_by', pg_temp.lg_cite(w0, 'just checking in'))),
  pg_temp.lg_it('due_unstated', 'commitment', 'open', 'us', 'customer', 'x14', pg_temp.lg_cite(w2, 'we will send it'),
   jsonb_build_object('due_date', d + 10, 'due_basis', 'stated')),
  pg_temp.lg_it('due_nobasis', 'commitment', 'open', 'us', 'customer', 'x15', pg_temp.lg_cite(w2, 'we will send it by ' || dtext),
   jsonb_build_object('due_date', d, 'due_basis', 'none')),
  pg_temp.lg_it('closed_noev', 'request', 'closed', 'customer', 'us', 'x16', pg_temp.lg_cite(w1, 'Could you please')),
  pg_temp.lg_it('open_closedby', 'request', 'open', 'customer', 'us', 'x17', pg_temp.lg_cite(w1, 'Could you please'),
   jsonb_build_object('closed_by', pg_temp.lg_cite(w6, 'got the quote'))),
  pg_temp.lg_it('dup_a', 'issue', 'open', 'customer', 'us', 'Same matter', pg_temp.lg_cite(w1, 'urgent')),
  pg_temp.lg_it('dup_b', 'issue', 'open', 'customer', 'us', 'SAME MATTER', pg_temp.lg_cite(w1, 'quote')),
  pg_temp.lg_it('twice', 'issue', 'open', 'customer', 'us', 'First use of the ref', pg_temp.lg_cite(w1, 'fence')),
  pg_temp.lg_it('twice', 'issue', 'open', 'customer', 'us', 'Second use of the ref', pg_temp.lg_cite(w1, 'fence')),
  pg_temp.lg_it('bad_field', 'request', 'open', 'customer', 'us', 'x18', pg_temp.lg_cite(w1, 'quote'), jsonb_build_object('opened_at', now() - interval '30 days')),
  pg_temp.lg_it('bad_about', 'request', 'open', 'customer', 'us', 'x19', pg_temp.lg_cite(w1, 'quote'), '{"about_key":"invoice:INV 1619"}'),
  pg_temp.lg_it('bad_status', 'event', 'open', 'customer', 'us', 'x20', pg_temp.lg_cite(w1, 'quote')),
  pg_temp.lg_it('agree_old', 'agreement', 'superseded', 'customer', 'us', 'Offered to wait for the quote', pg_temp.lg_cite(w1, 'quote'),
   '{"modality":"requested"}'),
  pg_temp.lg_it('agree_new', 'agreement', 'info', 'us', 'customer', 'Agreed to send the quote by the stated day', pg_temp.lg_cite(w2, 'Yes, we will send it'),
   '{"modality":"agreed","supersedes_ref":"agree_old"}'),
  pg_temp.lg_it('orphan_sup', 'agreement', 'superseded', 'customer', 'us', 'x21', pg_temp.lg_cite(w1, 'fence'), '{"modality":"offered"}'),
  pg_temp.lg_it('bad_ref', 'agreement', 'info', 'customer', 'us', 'x22', pg_temp.lg_cite(w1, 'fence'), '{"modality":"offered","supersedes_ref":"nobody"}'),
  pg_temp.lg_it('chain', 'agreement', 'info', 'customer', 'us', 'x23', pg_temp.lg_cite(w1, 'fence'), '{"modality":"offered","supersedes_ref":"wrong_job"}'));
 res := public.context_ledger_write(run, tok, gen, items, '[]', 'luna-ledger:v1');
 PERFORM pg_temp.lg_assert(res ->> 'outcome' = 'written', 'write outcome ' || res::text);
 FOR exp IN SELECT * FROM (VALUES ('ok_req', NULL), ('ok_quote', NULL), ('ok_due', NULL), ('ok_inbox', NULL), ('ok_record', NULL),
  ('wrong_job', 'citation_off_job'), ('not_adm', 'citation_not_admissible'), ('missing', 'citation_missing'),
  ('bad_table', 'citation_table_not_allowed'), ('person_tab', 'citation_table_not_allowed'), ('rec_off_job', 'citation_off_job'),
  ('not_verbatim', 'excerpt_not_verbatim'), ('no_excerpt', 'excerpt_required'), ('too_long', 'excerpt_too_long'),
  ('spk_cust', 'speaker_not_customer'), ('spk_us', 'speaker_not_us'), ('internal', 'internal_to_customer'),
  ('close_early', 'closing_before_opening'), ('due_unstated', 'due_date_unsupported'), ('due_nobasis', 'due_date_unsupported'),
  ('closed_noev', 'closed_without_evidence'), ('open_closedby', 'closed_by_on_open'), ('dup_a', NULL), ('dup_b', 'duplicate_item'),
  ('bad_field', 'invalid_shape'), ('bad_about', 'invalid_shape'), ('bad_status', 'invalid_shape'), ('agree_old', NULL),
  ('agree_new', NULL), ('orphan_sup', 'superseded_without_replacement'), ('bad_ref', 'supersedes_unresolved'),
  ('chain', 'supersedes_unresolved')) v(ref, code) LOOP
  IF exp.code IS NULL THEN
   PERFORM pg_temp.lg_assert(pg_temp.lg_accepted(res, exp.ref), exp.ref || ' must be accepted: ' || coalesce(pg_temp.lg_code(res, exp.ref), '?'));
  ELSE
   PERFORM pg_temp.lg_assert(pg_temp.lg_code(res, exp.ref) = exp.code AND NOT pg_temp.lg_accepted(res, exp.ref),
    format('%s must be refused %s, got %s', exp.ref, exp.code, coalesce(pg_temp.lg_code(res, exp.ref), 'accepted')));
  END IF;
 END LOOP;
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM jsonb_array_elements(res -> 'refused') x WHERE x ->> 'ref' = 'twice' AND x ->> 'code' = 'duplicate_ref') = 1
  AND (SELECT count(*) FROM jsonb_array_elements(res -> 'accepted') x WHERE x ->> 'ref' = 'twice') = 1, 'a ref used twice: first kept, second refused');
 -- What was stored: times from the cited rows, the key formula, the writer.
 SELECT * INTO it FROM public.context_ledger_items WHERE generation_id = gen AND item_key = pg_temp.lg_key(res, 'ok_req');
 PERFORM pg_temp.lg_assert(it.opened_at = (SELECT event_at FROM public.business_events WHERE id = w1)
  AND it.closed_at = (SELECT event_at FROM public.business_events WHERE id = w6) AND it.status = 'closed'
  AND it.written_by = 'model:luna-ledger:v1' AND NOT it.person_locked AND it.about_key = 'quote:rest-of-fence'
  AND it.item_key = 'request:quote:rest-of-fence:' || left(md5(w1::text || lower('Asked for the quote for the rest of the fence')), 12),
  'stored request row');
 PERFORM pg_temp.lg_assert((SELECT due_date = d AND due_basis = 'stated' FROM public.context_ledger_items WHERE generation_id = gen
  AND item_key = pg_temp.lg_key(res, 'ok_due')), 'stated due date stored');
 PERFORM pg_temp.lg_assert((SELECT status = 'superseded' AND closed_at = (SELECT event_at FROM public.business_events WHERE id = w2)
  FROM public.context_ledger_items WHERE generation_id = gen AND item_key = pg_temp.lg_key(res, 'agree_old')), 'superseded closes when replaced');
 PERFORM pg_temp.lg_assert((SELECT supersedes_key = pg_temp.lg_key(res, 'agree_old') FROM public.context_ledger_items
  WHERE generation_id = gen AND item_key = pg_temp.lg_key(res, 'agree_new')), 'supersedes_ref resolved to the key');
 SELECT count(*) INTO n FROM public.context_ledger_items WHERE generation_id = gen;
 PERFORM pg_temp.lg_assert(n = jsonb_array_length(res -> 'accepted') AND n = 9, 'accepted items stored whole, refused not at all: ' || n);
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM public.context_ledger_transitions WHERE generation_id = gen AND from_status IS NULL) = n, 'one transition per item');
 -- The same request again returns its first answer and writes nothing.
 res2 := public.context_ledger_write(run, tok, gen, items, '[]', 'luna-ledger:v1');
 PERFORM pg_temp.lg_assert((res2 ->> 'replayed')::boolean AND (res2 - 'replayed') = res, 'replay');
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM public.context_ledger_items WHERE generation_id = gen) = n
  AND (SELECT count(*) FROM public.context_ledger_writes WHERE run_id = run) = 1, 'replay wrote nothing');
 -- A different request repeating an item: duplicate.
 res2 := public.context_ledger_write(run, tok, gen, jsonb_build_array(items -> 0), '[]', 'luna-ledger:v1');
 PERFORM pg_temp.lg_assert(pg_temp.lg_code(res2, 'ok_req') = 'duplicate_item', 'an item already in the generation');
 -- Wrong reader, wrong generation.
 PERFORM pg_temp.lg_assert(public.context_ledger_write(run, tok, gen, '[]', '[]', 'other-reader:v9') = '{"outcome":"refused","reason":"reader_mismatch"}', 'reader');
 ogen := pg_temp.lg_gen(other, 'live', now());
 PERFORM pg_temp.lg_assert(public.context_ledger_write(run, tok, ogen, '[]', '[]', 'luna-ledger:v1') = '{"outcome":"refused","reason":"generation_mismatch"}', 'other job''s generation');
 -- Transitions.
 k_inbox := pg_temp.lg_key(res, 'ok_inbox'); k_due := pg_temp.lg_key(res, 'ok_due'); k_quote := pg_temp.lg_key(res, 'ok_quote');
 UPDATE public.context_ledger_items SET person_locked = true WHERE generation_id = gen AND item_key = k_quote;
 res2 := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(
  jsonb_build_object('item_key', pg_temp.lg_key(res, 'ok_req'), 'to_status', 'closed', 'evidence', pg_temp.lg_cite(w6, 'got the quote')),
  jsonb_build_object('item_key', k_inbox, 'to_status', 'closed'),
  jsonb_build_object('item_key', k_inbox, 'to_status', 'closed', 'evidence', pg_temp.lg_cite(w0, 'just checking in')),
  jsonb_build_object('item_key', 'request:none:ffffffffffff', 'to_status', 'closed', 'evidence', pg_temp.lg_cite(w6, 'got the quote')),
  jsonb_build_object('item_key', k_quote, 'to_status', 'closed', 'evidence', pg_temp.lg_cite(w6, 'got the quote')),
  jsonb_build_object('item_key', k_due, 'to_status', 'info', 'evidence', pg_temp.lg_cite(w6, 'got the quote')),
  jsonb_build_object('item_key', k_due, 'to_status', 'superseded'),
  jsonb_build_object('item_key', k_due, 'to_status', 'closed', 'evidence', pg_temp.lg_cite(w6, 'got the quotes')),
  jsonb_build_object('item_key', k_inbox, 'to_status', 'closed', 'evidence', pg_temp.lg_cite(w6, 'got the quote'), 'reason', 'Customer confirmed')),
  'luna-ledger:v1');
 PERFORM pg_temp.lg_assert((res2 ->> 'transitions_accepted')::integer = 1, 'one transition accepted: ' || res2::text);
 PERFORM pg_temp.lg_assert((SELECT array_agg(x ->> 'code' ORDER BY o) FROM jsonb_array_elements(res2 -> 'transitions_refused') WITH ORDINALITY y(x, o))
  = ARRAY['no_change','evidence_missing','evidence_older_than_item','unknown_item','person_locked','invalid_shape',
          'superseded_without_replacement','excerpt_not_verbatim'], 'transition refusals ' || (res2 -> 'transitions_refused')::text);
 PERFORM pg_temp.lg_assert((SELECT status = 'closed' AND closed_at = (SELECT event_at FROM public.business_events WHERE id = w6)
  AND closed_by -> 0 ->> 'id' = w6::text FROM public.context_ledger_items WHERE generation_id = gen AND item_key = k_inbox), 'transition applied');
 PERFORM pg_temp.lg_assert((SELECT by = 'model:luna-ledger:v1' AND from_status = 'open' AND reason = 'Customer confirmed'
  FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id = t.item_id
  WHERE i.generation_id = gen AND i.item_key = k_inbox AND t.to_status = 'closed'), 'transition recorded');
 PERFORM pg_temp.lg_assert((SELECT status = 'open' FROM public.context_ledger_items WHERE generation_id = gen AND item_key = k_quote), 'a person-locked item never moves');
 -- Off, lease lost.
 PERFORM pg_temp.lg_mode('off', 0);
 PERFORM pg_temp.lg_assert(public.context_ledger_write(run, tok, gen, '[]', '[]', 'luna-ledger:v1') = '{"outcome":"off"}', 'mode off');
 PERFORM pg_temp.lg_mode('shadow', 50);
 PERFORM pg_temp.lg_assert(public.context_ledger_write(run, gen_random_uuid(), gen, '[]', '[]', 'luna-ledger:v1') = '{"outcome":"lease_lost"}', 'wrong token');
 UPDATE public.context_extraction_runs SET lease_expires_at = now() - interval '1 second' WHERE id = run;
 PERFORM pg_temp.lg_assert(public.context_ledger_write(run, tok, gen, jsonb_build_array(items -> 1), '[]', 'luna-ledger:v1') = '{"outcome":"lease_lost"}', 'lease lost');
 -- ...but a replay of a request already answered still gets its answer.
 PERFORM pg_temp.lg_assert((public.context_ledger_write(run, tok, gen, items, '[]', 'luna-ledger:v1') ->> 'replayed')::boolean, 'replay after the lease');
 BEGIN
  PERFORM public.context_ledger_write(run, tok, gen, '{}', '[]', 'luna-ledger:v1');
  RAISE EXCEPTION 'ledger store contract: a non-array items list was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'context_ledger_write_invalid' THEN RAISE; END IF; END;
END $c$;
ROLLBACK;

-- 9. Finish, promote and people's corrections carried forward.
CREATE FUNCTION pg_temp.lg_staff(p_role text DEFAULT 'owner') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.users (id, org_id, name, role, trade_sees_all_jobs) VALUES (v, '00000000-0000-0000-0000-000000000001', 'Staff ' || p_role, p_role, false);
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.lg_meta(p_rows integer DEFAULT 2) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('model', 'gpt-6-luna', 'prompt_sha256', repeat('a', 64), 'evidence_until', now() - interval '1 minute',
  'evidence_rows', p_rows, 'chunks', 1, 'calls', 1, 'tokens_in', 1234, 'checks', jsonb_build_object('validator', 'ok')) $$;
BEGIN;
DO $c$
DECLARE f uuid; e1 uuid; e2 uuid; cl jsonb; run uuid; tok uuid; gen uuid; res jsonb; fin jsonb; staff uuid; gen2 uuid; k1 text; k2 text;
 it public.context_ledger_items; r2 jsonb; b uuid; u uuid; gu uuid; until0 timestamptz; v jsonb; sj uuid; gs uuid; ok boolean;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true); PERFORM pg_temp.lg_mode('live', 50);
 staff := pg_temp.lg_staff('ops_manager');
 f := pg_temp.lg_job('SWF-96001');
 e1 := pg_temp.lg_ev(f, 'client.reply', 'sms', 'inbound', 'Please leave the side gate unlocked on install day.', '4 days', 'customer');
 e2 := pg_temp.lg_ev(f, 'client.sms_out', 'sms', 'outbound', 'No problem, we will lock it when we leave.', '3 days', 'staff');
 cl := public.context_ledger_claim(f, 'backfill', pg_temp.lg_today());
 run := (cl ->> 'run_id')::uuid; tok := (cl ->> 'lease_token')::uuid; gen := (cl ->> 'generation_id')::uuid;
 res := public.context_ledger_write(run, tok, gen, jsonb_build_array(
  pg_temp.lg_it('a', 'constraint', 'open', 'customer', 'us', 'Side gate to be left unlocked on install day', pg_temp.lg_cite(e1, 'leave the side gate unlocked'),
   '{"about_key":"access:side-gate"}'),
  pg_temp.lg_it('b', 'commitment', 'open', 'us', 'customer', 'Will lock the gate when leaving', pg_temp.lg_cite(e2, 'we will lock it when we leave'))),
  '[]', 'luna-ledger:v1');
 k1 := pg_temp.lg_key(res, 'a'); k2 := pg_temp.lg_key(res, 'b');
 PERFORM pg_temp.lg_assert(k1 IS NOT NULL AND k2 IS NOT NULL, 'fixture write ' || res::text);
 -- Invalid meta and lease are refused without closing anything.
 PERFORM pg_temp.lg_assert(public.context_ledger_finish(run, tok, gen, 'built', '{"evidence_rows":2}') ->> 'reason' = 'invalid_meta', 'evidence_until required');
 PERFORM pg_temp.lg_assert(public.context_ledger_finish(run, tok, gen, 'built', jsonb_build_object('evidence_until', now() + interval '1 hour')) ->> 'reason' = 'invalid_meta', 'future evidence_until');
 PERFORM pg_temp.lg_assert(public.context_ledger_finish(run, gen_random_uuid(), gen, 'built', pg_temp.lg_meta()) = '{"outcome":"lease_lost"}', 'wrong token');
 PERFORM pg_temp.lg_assert(public.context_ledger_finish(run, tok, gen, 'updated', pg_temp.lg_meta()) ->> 'reason' = 'generation_mismatch', 'a build cannot finish as an update');
 fin := public.context_ledger_finish(run, tok, gen, 'built', pg_temp.lg_meta());
 PERFORM pg_temp.lg_assert(fin ->> 'outcome' = 'built' AND (fin ->> 'promoted')::boolean AND fin ->> 'generation_status' = 'live'
  AND (fin #>> '{checks,pass}')::boolean, 'built and promoted: ' || fin::text);
 PERFORM pg_temp.lg_assert((SELECT status = 'live' AND promoted_at IS NOT NULL AND model = 'gpt-6-luna' AND evidence_rows = 2 AND calls = 1
  AND checks #>> '{store,refused_rate}' = '0' AND checks #>> '{reader,validator}' = 'ok' AND checks ->> 'promoted_by' = 'rule:auto'
  FROM public.context_ledger_generations WHERE id = gen), 'generation after build');
 PERFORM pg_temp.lg_assert((SELECT status = 'done' AND lease_expires_at IS NULL AND events_in = 2 AND tokens_in = 1234 AND finished_at IS NOT NULL
  FROM public.context_extraction_runs WHERE id = run), 'run closed done');
 v := public.context_ledger_finish(run, tok, gen, 'built', pg_temp.lg_meta());
 PERFORM pg_temp.lg_assert((v ->> 'replayed')::boolean AND v ->> 'generation_status' = 'live', 'a repeated finish reports and changes nothing: ' || v::text);
 -- A person corrects the live ledger; the item is locked against the model.
 v := public.context_ledger_person_edit(f, staff, 'close', k1, 'Gate was left unlocked; confirmed with the customer.');
 PERFORM pg_temp.lg_assert(v ->> 'outcome' = 'edited' AND v ->> 'status' = 'closed', 'person close ' || v::text);
 -- The reader changes: a rebuild into a new generation.
 PERFORM pg_temp.lg_mode('shadow', 50, 'luna-ledger:v2');
 cl := public.context_ledger_claim(f, 'rebuild', pg_temp.lg_today());
 PERFORM pg_temp.lg_assert(cl ->> 'outcome' = 'claimed' AND cl ->> 'reason' = 'reader_changed' AND cl ->> 'reader' = 'luna-ledger:v2', 'rebuild claim ' || cl::text);
 run := (cl ->> 'run_id')::uuid; tok := (cl ->> 'lease_token')::uuid; gen2 := (cl ->> 'generation_id')::uuid;
 -- The packet tells the rebuild about the person's item.
 PERFORM pg_temp.lg_assert((SELECT array_agg(x ->> 'item_key') FROM jsonb_array_elements(public.context_ledger_packet(f) -> 'open_items') x) = ARRAY[k1],
  'rebuild packet lists the person-locked item');
 -- The model writes the same matter again (still open in its reading).
 res := public.context_ledger_write(run, tok, gen2, jsonb_build_array(
  pg_temp.lg_it('a', 'constraint', 'open', 'customer', 'us', 'Side gate to be left unlocked on install day', pg_temp.lg_cite(e1, 'leave the side gate unlocked'),
   '{"about_key":"access:side-gate"}')), '[]', 'luna-ledger:v2');
 PERFORM pg_temp.lg_assert(pg_temp.lg_key(res, 'a') = k1, 'same key in the rebuild');
 fin := public.context_ledger_finish(run, tok, gen2, 'built', pg_temp.lg_meta());
 PERFORM pg_temp.lg_assert(fin ->> 'generation_status' = 'shadow' AND NOT (fin ->> 'promoted')::boolean AND (fin ->> 'carried')::integer = 1,
  'shadow mode builds without promoting, carrying the person''s item: ' || fin::text);
 SELECT * INTO it FROM public.context_ledger_items WHERE generation_id = gen2 AND item_key = k1;
 PERFORM pg_temp.lg_assert(it.status = 'closed' AND it.person_locked AND it.written_by = 'model:luna-ledger:v1'
  AND it.closed_by -> 0 ->> 'table' = 'person', 'the person''s correction wins over the model''s re-reading');
 PERFORM pg_temp.lg_assert(EXISTS (SELECT 1 FROM public.context_ledger_transitions WHERE item_id = it.id AND by = 'rule:carry_forward'), 'carry transition');
 -- A correction made after the build is carried at promotion.
 v := public.context_ledger_person_edit(f, staff, 'add', NULL, 'Customer asked us to call before arriving.',
  '{"item_type":"request","status":"open","from_role":"customer","to_role":"us","what":"Call before arriving","about_key":"access:call-ahead"}');
 PERFORM pg_temp.lg_assert(v ->> 'outcome' = 'edited', 'person add ' || v::text);
 PERFORM pg_temp.lg_assert(public.context_ledger_promote(gen2, 'person:' || pg_temp.lg_staff('trade')) ->> 'reason' = 'not_staff', 'a trade cannot promote');
 PERFORM pg_temp.lg_assert(public.context_ledger_promote(gen, 'rule:auto') ->> 'already' = 'true', 'promoting a live generation is idempotent');
 v := public.context_ledger_promote(gen2, 'person:' || staff);
 PERFORM pg_temp.lg_assert(v ->> 'outcome' = 'promoted' AND (v ->> 'retired_generation_id')::uuid = gen AND (v ->> 'carried')::integer = 1, 'promote ' || v::text);
 PERFORM pg_temp.lg_assert((SELECT status FROM public.context_ledger_generations WHERE id = gen) = 'retired'
  AND (SELECT status FROM public.context_ledger_generations WHERE id = gen2) = 'live', 'previous live retired');
 PERFORM pg_temp.lg_assert(EXISTS (SELECT 1 FROM public.context_ledger_items WHERE generation_id = gen2 AND what = 'Call before arriving' AND person_locked
  AND written_by = 'person:' || staff), 'the late correction carried');
 PERFORM pg_temp.lg_assert(public.context_ledger_promote(gen, 'rule:auto') ->> 'reason' = 'not_shadow', 'a retired generation cannot be promoted');
 -- Checks fail when too many items were refused: built but not promoted.
 PERFORM pg_temp.lg_mode('live', 50);
 b := pg_temp.lg_job('SWF-96002'); e1 := pg_temp.lg_ev(b, 'client.reply', 'sms', 'inbound', 'Can you send the invoice again?', '2 days', 'customer');
 cl := public.context_ledger_claim(b, 'backfill', pg_temp.lg_today());
 run := (cl ->> 'run_id')::uuid; tok := (cl ->> 'lease_token')::uuid; gen := (cl ->> 'generation_id')::uuid;
 PERFORM public.context_ledger_write(run, tok, gen, jsonb_build_array(
  pg_temp.lg_it('ok', 'request', 'open', 'customer', 'us', 'Asked for the invoice again', pg_temp.lg_cite(e1, 'send the invoice again')),
  pg_temp.lg_it('bad', 'request', 'open', 'customer', 'us', 'Made up', pg_temp.lg_cite(e1, 'send the quote again'))), '[]', 'luna-ledger:v1');
 fin := public.context_ledger_finish(run, tok, gen, 'built', pg_temp.lg_meta(1));
 PERFORM pg_temp.lg_assert(fin ->> 'generation_status' = 'shadow' AND NOT (fin ->> 'promoted')::boolean AND NOT (fin #>> '{checks,pass}')::boolean
  AND (fin #>> '{checks,refused_rate}')::numeric = 0.5, 'half refused: not promoted: ' || fin::text);
 -- An update moves evidence_until forward on the current generation, never back.
 u := pg_temp.lg_job('SWF-96003');
 PERFORM pg_temp.lg_ev(u, 'client.reply', 'sms', 'inbound', 'Old', '9 days', 'customer');
 PERFORM pg_temp.lg_ev(u, 'client.reply', 'sms', 'inbound', 'New', '1 hour', 'customer');
 gu := pg_temp.lg_gen(u, 'live', now() - interval '2 days'); until0 := now() - interval '2 days';
 cl := public.context_ledger_claim(u, 'update', pg_temp.lg_today());
 run := (cl ->> 'run_id')::uuid; tok := (cl ->> 'lease_token')::uuid;
 PERFORM pg_temp.lg_assert(public.context_ledger_finish(run, tok, gu, 'built', pg_temp.lg_meta()) ->> 'reason' = 'generation_mismatch', 'an update cannot finish as a build');
 PERFORM pg_temp.lg_assert(public.context_ledger_finish(run, tok, gu, 'updated', jsonb_build_object('evidence_until', until0 - interval '1 day')) ->> 'reason'
  = 'evidence_until_backwards', 'evidence_until never moves back');
 fin := public.context_ledger_finish(run, tok, gu, 'updated', pg_temp.lg_meta(3));
 PERFORM pg_temp.lg_assert(fin ->> 'outcome' = 'updated' AND fin ->> 'generation_status' = 'live', 'update finish ' || fin::text);
 PERFORM pg_temp.lg_assert((SELECT evidence_until > until0 AND calls = 1 AND status = 'live' AND checks ? 'last_update' FROM public.context_ledger_generations WHERE id = gu),
  'update moved evidence_until');
 PERFORM pg_temp.lg_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_judge(ARRAY[u]) j WHERE j.due), 'up to date after the update');
 -- A failed build: generation failed, run failed, the job backs off; a failed update leaves the generation alone.
 b := pg_temp.lg_job('SWF-96004'); PERFORM pg_temp.lg_ev(b, 'client.reply', 'sms', 'inbound', 'Hello', '2 days', 'customer');
 cl := public.context_ledger_claim(b, 'backfill', pg_temp.lg_today());
 fin := public.context_ledger_finish((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, (cl ->> 'generation_id')::uuid, 'failed', '{"failure":"model_timeout"}');
 PERFORM pg_temp.lg_assert(fin ->> 'generation_status' = 'failed' AND (SELECT failure = 'model_timeout' FROM public.context_ledger_generations
  WHERE id = (cl ->> 'generation_id')::uuid) AND (SELECT status = 'failed' AND error = 'model_timeout' FROM public.context_extraction_runs
  WHERE id = (cl ->> 'run_id')::uuid), 'failed build ' || fin::text);
 PERFORM pg_temp.lg_assert((SELECT blocked_reason FROM public.context_ledger_judge(ARRAY[b])) = 'backoff', 'failed build backs off');
 PERFORM pg_temp.lg_ev(u, 'client.reply', 'sms', 'inbound', 'Newer still', '30 seconds', 'customer');
 UPDATE public.context_extraction_runs SET finished_at = now() - interval '3 hours' WHERE job_id = u AND phase = 'ledger';
 cl := public.context_ledger_claim(u, 'update', pg_temp.lg_today());
 fin := public.context_ledger_finish((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, gu, 'failed', '{"failure":"validator_refused"}');
 PERFORM pg_temp.lg_assert(fin ->> 'generation_status' = 'live' AND (SELECT status FROM public.context_ledger_generations WHERE id = gu) = 'live',
  'a failed update leaves the live generation live: ' || coalesce(fin::text, cl::text));
 -- A shadow kept current in shadow mode goes live on its first clean update
 -- once the lane is live, only if its build passed.
 PERFORM pg_temp.lg_mode('live', 50);
 FOREACH ok IN ARRAY ARRAY[true, false] LOOP
  sj := pg_temp.lg_job(CASE WHEN ok THEN 'SWF-96005' ELSE 'SWF-96006' END);
  PERFORM pg_temp.lg_ev(sj, 'client.reply', 'sms', 'inbound', 'Old', '9 days', 'customer');
  PERFORM pg_temp.lg_ev(sj, 'client.reply', 'sms', 'inbound', 'New', '1 hour', 'customer');
  gs := pg_temp.lg_gen(sj, 'shadow', now() - interval '2 days');
  UPDATE public.context_ledger_generations SET checks = jsonb_build_object('store', jsonb_build_object('pass', ok)) WHERE id = gs;
  cl := public.context_ledger_claim(sj, 'update', pg_temp.lg_today());
  PERFORM pg_temp.lg_assert((cl ->> 'generation_id')::uuid = gs, 'update claims the current shadow: ' || cl::text);
  fin := public.context_ledger_finish((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, gs, 'updated', pg_temp.lg_meta(2));
  PERFORM pg_temp.lg_assert((fin ->> 'promoted')::boolean = ok AND (SELECT status FROM public.context_ledger_generations WHERE id = gs)
   = CASE WHEN ok THEN 'live' ELSE 'shadow' END, 'shadow promotion on update (build passed ' || ok || '): ' || fin::text);
 END LOOP;
-- Corrections never cross jobs.
 BEGIN
  PERFORM public.context_ledger_carry_forward(gen2, gs);
  RAISE EXCEPTION 'ledger store contract: carry forward crossed jobs';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'context_ledger_carry_forward_invalid' THEN RAISE; END IF; END;
END $c$;
ROLLBACK;

-- 10. People's corrections.
BEGIN;
DO $c$
DECLARE j uuid; nolive uuid; e1 uuid; gl uuid; staff uuid; trade uuid; v jsonb; k text := 'request:none:abcdefabcdef'; it public.context_ledger_items;
 res jsonb; run uuid; tok uuid;
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true); PERFORM pg_temp.lg_mode('shadow', 50);
 staff := pg_temp.lg_staff('admin'); trade := pg_temp.lg_staff('lead_installer');
 j := pg_temp.lg_job('SWF-97001'); nolive := pg_temp.lg_job('SWF-97002');
 e1 := pg_temp.lg_ev(j, 'client.reply', 'sms', 'inbound', 'Please do not start before 8am.', '3 days', 'customer');
 gl := pg_temp.lg_gen(j, 'live', now() - interval '2 days');
 PERFORM pg_temp.lg_item(gl, k, 'open', e1);
 PERFORM pg_temp.lg_assert(public.context_ledger_person_edit(j, trade, 'close', k, 'done') = '{"outcome":"refused","code":"not_staff"}', 'a trade cannot edit');
 PERFORM pg_temp.lg_assert(public.context_ledger_person_edit(j, gen_random_uuid(), 'close', k, 'done') ->> 'code' = 'not_staff', 'an unknown user cannot edit');
 PERFORM pg_temp.lg_assert(public.context_ledger_person_edit(j, staff, 'close', k, '  ') ->> 'code' = 'note_required', 'a note is required');
 PERFORM pg_temp.lg_assert(public.context_ledger_person_edit(nolive, staff, 'close', k, 'done') ->> 'code' = 'no_live_ledger', 'no live ledger');
 PERFORM pg_temp.lg_assert(public.context_ledger_person_edit(j, staff, 'close', 'request:none:000000000000', 'done') ->> 'code' = 'unknown_item', 'unknown key');
 BEGIN
  PERFORM public.context_ledger_person_edit(j, staff, 'delete', k, 'done');
  RAISE EXCEPTION 'ledger store contract: an unknown action was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'context_ledger_person_edit_invalid' THEN RAISE; END IF; END;
 -- dispute, reopen, close: each locks the item and records the person and note.
 v := public.context_ledger_person_edit(j, staff, 'dispute', k, 'The customer never said this.');
 SELECT * INTO it FROM public.context_ledger_items WHERE generation_id = gl AND item_key = k;
 PERFORM pg_temp.lg_assert(v ->> 'status' = 'disputed' AND it.status = 'disputed' AND it.person_locked AND it.closed_at IS NULL, 'dispute');
 v := public.context_ledger_person_edit(j, staff, 'reopen', k, 'Checked the message again; it stands.');
 PERFORM pg_temp.lg_assert(v ->> 'status' = 'open', 'reopen');
 v := public.context_ledger_person_edit(j, staff, 'close', k, 'Crew started at 8.');
 SELECT * INTO it FROM public.context_ledger_items WHERE generation_id = gl AND item_key = k;
 PERFORM pg_temp.lg_assert(it.status = 'closed' AND it.closed_at IS NOT NULL AND it.closed_by = jsonb_build_array(jsonb_build_object('table', 'person',
  'id', staff::text, 'excerpt', 'Crew started at 8.')), 'person close cites the person and note');
 PERFORM pg_temp.lg_assert((SELECT array_agg(to_status ORDER BY t.id) FROM public.context_ledger_transitions t WHERE t.item_id = it.id AND t.by = 'person:' || staff)
  = ARRAY['disputed','open','closed'], 'person transitions recorded');
 PERFORM pg_temp.lg_assert(public.context_ledger_person_edit(j, staff, 'close', k, 'Again.') ->> 'outcome' = 'no_change', 'repeat is no_change');
 -- The model can never move a person-locked item, even in an update run.
 PERFORM pg_temp.lg_ev(j, 'client.reply', 'sms', 'inbound', 'Actually 7am is fine.', '1 hour', 'customer');
 res := public.context_ledger_claim(j, 'update', pg_temp.lg_today());
 run := (res ->> 'run_id')::uuid; tok := (res ->> 'lease_token')::uuid;
 res := public.context_ledger_write(run, tok, gl, '[]', jsonb_build_array(jsonb_build_object('item_key', k, 'to_status', 'open',
  'evidence', pg_temp.lg_cite(e1, 'Please do not start before 8am'))), 'luna-ledger:v1');
 PERFORM pg_temp.lg_assert(pg_temp.lg_tcode(res, k) = 'person_locked', 'model transition on a person item: ' || res::text);
 -- add: citation-free cites the person; a cited one is checked like the model's.
 v := public.context_ledger_person_edit(j, staff, 'add', NULL, 'Customer told me by phone.',
  '{"item_type":"constraint","status":"open","from_role":"customer","to_role":"us","what":"No noise before 8am","about_key":"access:start-time"}');
 SELECT * INTO it FROM public.context_ledger_items WHERE generation_id = gl AND item_key = v ->> 'item_key';
 PERFORM pg_temp.lg_assert(it.person_locked AND it.written_by = 'person:' || staff AND it.opened_by -> 0 ->> 'table' = 'person'
  AND it.opened_by -> 0 ->> 'id' = staff::text AND it.item_key = 'constraint:access:start-time:' || left(md5(staff::text || lower('No noise before 8am')), 12),
  'citation-free person item');
 PERFORM pg_temp.lg_assert(public.context_ledger_person_edit(j, staff, 'add', NULL, 'Customer told me by phone.',
  '{"item_type":"constraint","status":"open","from_role":"customer","to_role":"us","what":"No noise before 8am","about_key":"access:start-time"}') ->> 'code'
  = 'duplicate_item', 'the same person item twice');
 v := public.context_ledger_person_edit(j, staff, 'add', NULL, 'From the text.',
  jsonb_build_object('item_type', 'request', 'status', 'open', 'from_role', 'customer', 'what', 'Start time', 'opened_by', pg_temp.lg_cite(e1, 'start before 9am')));
 PERFORM pg_temp.lg_assert(v ->> 'code' = 'excerpt_not_verbatim', 'a person''s citation is still checked: ' || v::text);
 v := public.context_ledger_person_edit(j, staff, 'add', NULL, 'From the text.',
  jsonb_build_object('item_type', 'request', 'status', 'closed', 'from_role', 'customer', 'what', 'Start time', 'opened_by', pg_temp.lg_cite(e1, 'start before 8am')));
 PERFORM pg_temp.lg_assert(v ->> 'code' = 'invalid_shape', 'a person adds open or in-force items only');
END $c$;
ROLLBACK;

-- 11. Bulk go-live: once the lane is live, each job's newest shadow is promoted
-- under the rule finish uses, people's corrections carried as promote carries
-- them; never while the lane is not live, never an older reading over a newer
-- live one, never off the rollout list, never by a trade.
BEGIN;
DO $c$
DECLARE staff uuid; trade uuid; p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; nx uuid; q1 uuid; q2 uuid;
 g1 uuid; g2 uuid; g3 uuid; g4old uuid; g4 uuid; g5 uuid; g5live uuid; g6 uuid; gq1 uuid; gq2 uuid; e4 uuid; v jsonb; bad text;
 k text := 'request:none:bbbbbbbbbbbb';
BEGIN
 PERFORM pg_temp.lg_lanes(true, true, true);
 staff := pg_temp.lg_staff('owner'); trade := pg_temp.lg_staff('lead_installer');
 -- The one rule (finish uses it too): the build passed, and the latest update, if any, refused at most 20%.
 PERFORM pg_temp.lg_assert(public.context_ledger_checks_pass('{"store":{"pass":true}}'), 'rule: a passing build');
 PERFORM pg_temp.lg_assert(NOT public.context_ledger_checks_pass('{"store":{"pass":false}}'), 'rule: a failing build');
 PERFORM pg_temp.lg_assert(NOT public.context_ledger_checks_pass('{}'), 'rule: no checks');
 PERFORM pg_temp.lg_assert(public.context_ledger_checks_pass('{"store":{"pass":true},"last_update":{"items_accepted":4,"items_refused":1}}'),
  'rule: a clean update');
 PERFORM pg_temp.lg_assert(NOT public.context_ledger_checks_pass('{"store":{"pass":true},"last_update":{"items_accepted":1,"items_refused":3}}'),
  'rule: a dirty update');
 PERFORM pg_temp.lg_assert(public.context_ledger_checks_pass('{"store":{"pass":true},"last_update":{"items_accepted":0,"items_refused":0}}'),
  'rule: an update that wrote nothing');
 -- p1 passing shadow; p2 failed build; p3 passing build, dirty latest update; p4 live reading with a
 -- person's correction and a newer passing shadow; p5 passing shadow older than its live reading;
 -- p6 passing shadow off the rollout list; nx no reading at all.
 p1 := pg_temp.lg_job('SWF-98001'); g1 := pg_temp.lg_gen(p1, 'shadow', now() - interval '1 day', 'luna-ledger:v1', '2 days');
 p2 := pg_temp.lg_job('SWF-98002'); g2 := pg_temp.lg_gen(p2, 'shadow', now() - interval '1 day', 'luna-ledger:v1', '2 days');
 p3 := pg_temp.lg_job('SWF-98003'); g3 := pg_temp.lg_gen(p3, 'shadow', now() - interval '1 day', 'luna-ledger:v1', '2 days');
 p4 := pg_temp.lg_job('SWF-98004'); g4old := pg_temp.lg_gen(p4, 'live', now() - interval '5 days', 'luna-ledger:v1', '6 days');
 e4 := pg_temp.lg_ev(p4, 'client.reply', 'sms', 'inbound', 'Please park on the street.', '7 days', 'customer');
 PERFORM pg_temp.lg_item(g4old, k, 'open', e4, true, 'request', 'person:' || staff);
 g4 := pg_temp.lg_gen(p4, 'shadow', now() - interval '1 day', 'luna-ledger:v1', '2 days');
 p5 := pg_temp.lg_job('SWF-98005'); g5 := pg_temp.lg_gen(p5, 'shadow', now() - interval '3 days', 'luna-ledger:v1', '4 days');
 g5live := pg_temp.lg_gen(p5, 'live', now() - interval '1 day', 'luna-ledger:v1', '2 days');
 p6 := pg_temp.lg_job('SWF-98006'); g6 := pg_temp.lg_gen(p6, 'shadow', now() - interval '1 day', 'luna-ledger:v1', '2 days');
 nx := pg_temp.lg_job('SWF-98007');
 UPDATE public.context_ledger_generations SET checks = '{"store":{"pass":true}}' WHERE id IN (g1, g4, g5, g6);
 UPDATE public.context_ledger_generations SET checks = '{"store":{"pass":false}}' WHERE id = g2;
 UPDATE public.context_ledger_generations SET checks = '{"store":{"pass":true},"last_update":{"items_accepted":1,"items_refused":3}}' WHERE id = g3;
 -- Refused unless the lane is live, refused for a trade, invalid for a malformed actor or limit.
 PERFORM pg_temp.lg_mode('shadow', 50);
 v := public.context_ledger_promote_shadow('rule:go-live');
 PERFORM pg_temp.lg_assert(v = '{"outcome":"refused","reason":"not_live","mode":"shadow"}', 'shadow mode refuses: ' || v::text);
 PERFORM pg_temp.lg_mode('off', 0);
 PERFORM pg_temp.lg_assert(public.context_ledger_promote_shadow('rule:go-live') = '{"outcome":"refused","reason":"not_live","mode":"off"}', 'mode off refuses');
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM public.context_ledger_generations WHERE id IN (g1, g2, g3, g4, g5, g6) AND status = 'shadow') = 6,
  'a refusal promoted a reading');
 PERFORM pg_temp.lg_mode('live', 50);
 PERFORM pg_temp.lg_assert(public.context_ledger_promote_shadow('person:' || trade) = '{"outcome":"refused","reason":"not_staff"}', 'a trade cannot go live');
 FOREACH bad IN ARRAY ARRAY['auto', 'rule:', 'person:not-a-uuid', 'model:luna-ledger:v1'] LOOP
  BEGIN
   PERFORM public.context_ledger_promote_shadow(bad);
   RAISE EXCEPTION 'ledger store contract: promote_shadow accepted the actor %', bad;
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'context_ledger_promote_shadow_invalid' THEN RAISE; END IF; END;
 END LOOP;
 BEGIN
  PERFORM public.context_ledger_promote_shadow('rule:go-live', NULL, 0);
  RAISE EXCEPTION 'ledger store contract: promote_shadow accepted a limit of 0';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'context_ledger_promote_shadow_invalid' THEN RAISE; END IF; END;
 -- Go live with a rollout list that leaves p6 out.
 UPDATE public.context_ledger_settings SET job_ids = ARRAY[p1, p2, p3, p4, p5];
 v := public.context_ledger_promote_shadow('person:' || staff);
 PERFORM pg_temp.lg_assert(v ->> 'outcome' = 'done' AND (v ->> 'promoted')::int = 2 AND (v ->> 'skipped')::int = 4 AND (v ->> 'remaining')::int = 0
  AND v -> 'skipped_reasons' = '{"checks_failed":2,"older_than_live":1,"not_in_rollout":1}', 'go-live counts: ' || v::text);
 PERFORM pg_temp.lg_assert((SELECT array_agg(x ->> 'generation_id' ORDER BY x ->> 'generation_id') FROM jsonb_array_elements(v -> 'promoted_generations') x)
  = (SELECT array_agg(i::text ORDER BY i::text) FROM unnest(ARRAY[g1, g4]) i), 'the two passing shadows were promoted: ' || v::text);
 PERFORM pg_temp.lg_assert((SELECT status = 'live' AND promoted_at IS NOT NULL AND checks ->> 'promoted_by' = 'person:' || staff
  FROM public.context_ledger_generations WHERE id = g1), 'p1 live, promoted by the person');
 PERFORM pg_temp.lg_assert((SELECT status FROM public.context_ledger_generations WHERE id = g4old) = 'retired'
  AND (SELECT status FROM public.context_ledger_generations WHERE id = g4) = 'live', 'p4: the previous live reading retired');
 PERFORM pg_temp.lg_assert(EXISTS (SELECT 1 FROM public.context_ledger_items WHERE generation_id = g4 AND item_key = k AND person_locked
  AND written_by = 'person:' || staff) AND EXISTS (SELECT 1 FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id = t.item_id
  WHERE i.generation_id = g4 AND i.item_key = k AND t.by = 'rule:carry_forward'), 'p4: the person''s correction carried forward');
 PERFORM pg_temp.lg_assert((SELECT count(*) FROM public.context_ledger_generations WHERE id IN (g2, g3, g5, g6) AND status = 'shadow') = 4
  AND (SELECT status FROM public.context_ledger_generations WHERE id = g5live) = 'live', 'skipped readings untouched');
 v := public.context_ledger_promote_shadow('person:' || staff);
 PERFORM pg_temp.lg_assert((v ->> 'promoted')::int = 0 AND (v ->> 'skipped')::int = 4, 'a repeat promotes nothing more: ' || v::text);
 -- Named jobs and no rollout list: p6 goes live under the rule actor; a job with no shadow says so.
 UPDATE public.context_ledger_settings SET job_ids = NULL;
 v := public.context_ledger_promote_shadow('rule:go-live', ARRAY[p6, nx]);
 PERFORM pg_temp.lg_assert((v ->> 'promoted')::int = 1 AND v -> 'skipped_reasons' = '{"no_shadow":1}'
  AND v -> 'promoted_generations' -> 0 ->> 'generation_id' = g6::text
  AND (SELECT checks ->> 'promoted_by' FROM public.context_ledger_generations WHERE id = g6) = 'rule:go-live', 'named jobs: ' || v::text);
 -- The limit: oldest shadow first, the rest counted as remaining for the next call.
 q1 := pg_temp.lg_job('SWF-98008'); gq1 := pg_temp.lg_gen(q1, 'shadow', now() - interval '1 day', 'luna-ledger:v1', '3 days');
 q2 := pg_temp.lg_job('SWF-98009'); gq2 := pg_temp.lg_gen(q2, 'shadow', now() - interval '1 day', 'luna-ledger:v1', '2 days');
 UPDATE public.context_ledger_generations SET checks = '{"store":{"pass":true}}' WHERE id IN (gq1, gq2);
 v := public.context_ledger_promote_shadow('rule:go-live', NULL, 1);
 PERFORM pg_temp.lg_assert((v ->> 'promoted')::int = 1 AND (v ->> 'remaining')::int = 1
  AND v -> 'promoted_generations' -> 0 ->> 'generation_id' = gq1::text, 'limit 1, oldest first: ' || v::text);
 v := public.context_ledger_promote_shadow('rule:go-live', NULL, 1);
 PERFORM pg_temp.lg_assert((v ->> 'promoted')::int = 1 AND (v ->> 'remaining')::int = 0
  AND v -> 'promoted_generations' -> 0 ->> 'generation_id' = gq2::text, 'limit 1, then the rest: ' || v::text);
END $c$;
ROLLBACK;

-- 12. Last, so a behaviour break above is reported by its behaviour: the
-- admission is exactly this migration's body.
DO $c$ BEGIN
 PERFORM pg_temp.lg_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)
  = '16c53c869b8590dbc38be28abad17658', 'reserve_context_model_call is not this migration''s body');
END $c$;
