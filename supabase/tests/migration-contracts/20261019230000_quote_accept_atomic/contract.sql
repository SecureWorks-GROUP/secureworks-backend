-- Contract: 20261019230000_quote_accept_atomic (SQ-23 remedy slice 1). Both new switches are
-- seeded off. accept_quote_document_atomic writes the accepted document, the sibling
-- supersession or run acceptance, the job status, the acceptance event and the attempt row in
-- one transaction; a repeat call replays; a changed snapshot is 'stale' and writes nothing.
-- CIO R4: with the supersede switch on and the run record, the work and the review event all
-- failing, an atomic acceptance rolls back completely (no accepted document, no status, no
-- marks, no attempt row). Every other status writer keeps today's behaviour while
-- quote_option_strict_record_v1 is off, missing or unreadable, or while quote_accept_atomic_v1
-- is off, missing or unreadable; with both on (an owning-review decision) the same failure
-- refuses the status change. Concurrency (two sessions) is not
-- provable in this single-session runner.
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.qa_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'quote accept atomic contract: %', p_msg; END IF; END $$;
-- Runs one statement in its own subtransaction: 'ok' or 'err:<message>'. A caught error rolls
-- back everything the statement wrote, exactly as a refused RPC call does.
CREATE FUNCTION pg_temp.qa_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
 RETURN 'err:' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.qa_accept(p_doc uuid, p_status text, p_run text DEFAULT NULL,
  p_event jsonb DEFAULT NULL, p_fp text DEFAULT NULL, p_token text DEFAULT NULL,
  p_request uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.accept_quote_document_atomic(p_doc,
   coalesce(p_token, (SELECT share_token FROM public.job_documents WHERE id = p_doc), 'no-token'),
   coalesce(p_request, gen_random_uuid()), '2026-10-19 12:00:00+00', p_status,
   coalesce(p_fp, public.quote_acceptance_fingerprint((SELECT job_id FROM public.job_documents WHERE id = p_doc))),
   p_run,
   (public.quote_acceptance_snapshot((SELECT job_id FROM public.job_documents WHERE id = p_doc), p_run)->>'run_neighbour')::uuid,
   coalesce(p_event, '{"contract":true}'::jsonb))
$$;

-- Switches seeded off.
SELECT pg_temp.qa_assert((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'quote_accept_atomic_v1'),
 'the atomic acceptance switch must be seeded off');
SELECT pg_temp.qa_assert((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'quote_option_strict_record_v1'),
 'the strict record switch must be seeded off');
-- Service role only; owner rights with a fixed search_path.
SELECT pg_temp.qa_assert(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['public', 'anon', 'authenticated']) r(role),
       unnest(ARRAY['public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, uuid, jsonb)',
                    'public.quote_acceptance_fingerprint(uuid)',
                    'public.quote_acceptance_handler_finished(uuid, uuid, text)',
                    'public.quote_acceptance_snapshot(uuid, text)',
                    'public.quote_acceptance_gaps(interval, timestamptz)']) f(fn)
   WHERE has_function_privilege(r.role, f.fn, 'EXECUTE'))
 AND (SELECT bool_and(has_function_privilege('service_role', f.fn, 'EXECUTE'))
   FROM unnest(ARRAY['public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, uuid, jsonb)',
                     'public.quote_acceptance_fingerprint(uuid)',
                      'public.quote_acceptance_handler_finished(uuid, uuid, text)',
                    'public.quote_acceptance_snapshot(uuid, text)',
                     'public.quote_acceptance_gaps(interval, timestamptz)']) f(fn)),
 'the new functions must be the service role''s only');
SELECT pg_temp.qa_assert((SELECT count(*) = 5
   AND bool_and(coalesce(p.prosecdef, false))
   AND bool_and(coalesce(p.proconfig @> ARRAY['search_path=public, pg_temp'], false))
  FROM pg_proc p
  WHERE p.oid IN ('public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, uuid, jsonb)'::regprocedure,
    'public.quote_acceptance_fingerprint(uuid)'::regprocedure,
    'public.quote_acceptance_handler_finished(uuid, uuid, text)'::regprocedure,
    'public.quote_acceptance_snapshot(uuid, text)'::regprocedure,
    'public.quote_acceptance_gaps(interval, timestamptz)'::regprocedure)),
 'the new functions must run as their owner with a fixed search_path');
SELECT pg_temp.qa_assert(has_table_privilege('service_role', 'public.quote_acceptance_attempts', 'SELECT')
 AND NOT has_table_privilege('service_role', 'public.quote_acceptance_attempts', 'INSERT')
 AND NOT has_table_privilege('service_role', 'public.quote_acceptance_attempts', 'DELETE')
 AND NOT has_table_privilege('service_role', 'public.quote_acceptance_attempts', 'TRUNCATE')
 AND NOT has_column_privilege('service_role', 'public.quote_acceptance_attempts', 'handler_finished_at', 'UPDATE')
 AND NOT has_column_privilege('service_role', 'public.quote_acceptance_attempts', 'request_id', 'UPDATE')
 AND has_column_privilege('service_role', 'public.quote_acceptance_attempts', 'resolved_at', 'UPDATE')
 AND NOT has_table_privilege('authenticated', 'public.quote_acceptance_attempts', 'SELECT')
 AND NOT has_table_privilege('anon', 'public.quote_acceptance_attempts', 'SELECT'),
 'the attempt table must be read and resolved by the service role only');
SELECT pg_temp.qa_assert(has_table_privilege('service_role', 'public.quote_acceptance_gap_resolutions', 'INSERT')
 AND has_table_privilege('service_role', 'public.quote_acceptance_gap_resolutions', 'SELECT')
 AND NOT has_table_privilege('service_role', 'public.quote_acceptance_gap_resolutions', 'UPDATE')
 AND NOT has_table_privilege('service_role', 'public.quote_acceptance_gap_resolutions', 'DELETE')
 AND NOT has_table_privilege('authenticated', 'public.quote_acceptance_gap_resolutions', 'SELECT')
 AND NOT has_table_privilege('anon', 'public.quote_acceptance_gap_resolutions', 'SELECT'),
 'gap resolutions must be added and read by the service role only, never changed or removed');

BEGIN;
-- Fixed ids: jobs 9a..., documents 9d..., contacts 9c.... Every fixture document gets a share
-- token tok-<id> unless one is given.
CREATE FUNCTION public.qa_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.share_token := coalesce(NEW.share_token, 'tok-' || NEW.id::text); RETURN NEW; END $$;
CREATE TRIGGER qa_token BEFORE INSERT ON public.job_documents FOR EACH ROW EXECUTE FUNCTION public.qa_token();
-- R4 first (the break contract removes it). Group A: customer c-a, fence options A1 and A2;
-- A1's quote document DA1. The supersede switch is on; the run insert, the marking of A2 and
-- every review event are forced to fail.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_option_supersede_v1';
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9a000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-a'),
 ('9a000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-a');
SELECT public.link_fence_quote_option('9a000000-0000-4000-8000-0000000000a2', '9a000000-0000-4000-8000-0000000000a1', NULL, NULL);
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, sent_at) VALUES
 ('9d000000-0000-4000-8000-0000000000a1', '9a000000-0000-4000-8000-0000000000a1', 'quote', true, '2026-10-18 00:00:00+00');
CREATE FUNCTION public.qa_contract_fail_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'contract forced run insert failure' USING ERRCODE = '55P03'; END $$;
CREATE TRIGGER qa_contract_fail_run BEFORE INSERT ON public.quote_option_settle_runs FOR EACH ROW
 EXECUTE FUNCTION public.qa_contract_fail_run();
CREATE FUNCTION public.qa_contract_fail_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'contract forced mark failure'; END $$;
CREATE TRIGGER qa_contract_fail_mark BEFORE UPDATE OF superseded_at ON public.jobs FOR EACH ROW
 WHEN (NEW.superseded_at IS NOT NULL AND NEW.id::text LIKE '9a000000-%')
 EXECUTE FUNCTION public.qa_contract_fail_mark();
CREATE FUNCTION public.qa_contract_fail_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_type = 'quote_option_review_needed' THEN RAISE EXCEPTION 'contract forced review failure'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER qa_contract_fail_review BEFORE INSERT ON public.job_events FOR EACH ROW
 EXECUTE FUNCTION public.qa_contract_fail_review();
SELECT set_config('qa.r', pg_temp.qa_try($q$SELECT pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000a1', 'accepted', NULL,
  '{"document_id":"9d000000-0000-4000-8000-0000000000a1"}'::jsonb)$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:quote_option_unrecorded%',
 'R4: an atomic acceptance whose supersede run records nothing must be refused');
SELECT pg_temp.qa_assert((SELECT accepted_at IS NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000a1')
 AND (SELECT status = 'quoted' AND accepted_at IS NULL FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1')
 AND (SELECT superseded_at IS NULL FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a2')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_attempts WHERE document_id = '9d000000-0000-4000-8000-0000000000a1')
 AND NOT EXISTS (SELECT 1 FROM public.job_events WHERE job_id IN ('9a000000-0000-4000-8000-0000000000a1',
       '9a000000-0000-4000-8000-0000000000a2') AND event_type <> 'quote_option_linked'),
 'R4: the refused acceptance must roll back completely: no accepted document, no status, no marks, no events, no attempt');
SELECT pg_temp.qa_assert(coalesce(current_setting('sw.quote_accept_atomic', true), '') = '',
 'the atomic marker must not outlive the call');
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '0')
  WHERE job_id IN ('9a000000-0000-4000-8000-0000000000a1', '9a000000-0000-4000-8000-0000000000a2')),
 'R4: after a full rollback nothing is inconsistent, so the gap read lists nothing');

-- Parity: the same failure from any other status writer (no marker) keeps today's behaviour
-- while the strict switch is false, NULL (where the column allows it), missing or unreadable:
-- the status change stands with nothing recorded. The writer is a plain UPDATE, which is what
-- every one of the 40 writers sends. Each case is put back to quoted afterwards.
CREATE FUNCTION pg_temp.qa_today(p_case text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_res text;
BEGIN
 -- The write in one statement, its effect read in the next.
 v_res := pg_temp.qa_try($q$UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000a1'$q$);
 IF v_res <> 'ok'
    OR (SELECT status FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1') <> 'accepted' THEN
  RAISE EXCEPTION 'quote accept atomic contract: strict %: a status change outside the atomic path must stand as today', p_case;
 END IF;
 UPDATE public.jobs SET status = 'quoted' WHERE id = '9a000000-0000-4000-8000-0000000000a1';
END $$;
SELECT pg_temp.qa_today('false');
-- CIO condition 3: the strict-off plain-UPDATE triple failure keeps a status with nothing
-- recorded, and the gap read lists it (a won job with no acceptance event, and its open
-- sibling while the supersede switch reads true).
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000a1';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000a1')
 AND (SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_with_open_sibling' AND job_id = '9a000000-0000-4000-8000-0000000000a1'),
 'R4/R3: a status kept with nothing recorded must be listed by the gap read');
UPDATE public.jobs SET status = 'quoted' WHERE id = '9a000000-0000-4000-8000-0000000000a1';
DO $$
DECLARE v_nullable boolean := true;
BEGIN
 BEGIN
  UPDATE public.feature_flags SET enabled = NULL WHERE flag_name = 'quote_option_strict_record_v1';
 EXCEPTION WHEN not_null_violation THEN
  v_nullable := false;
 END;
 IF v_nullable THEN PERFORM pg_temp.qa_today('NULL'); END IF;
END $$;
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'quote_option_strict_record_v1';
CREATE FUNCTION public.qa_contract_raise() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'contract forced switch read failure' USING ERRCODE = current_setting('qa.flag_error');
END $$;
ALTER TABLE public.feature_flags RENAME TO qa_contract_feature_flags;
CREATE VIEW public.feature_flags AS
 SELECT f.* FROM public.qa_contract_feature_flags f WHERE f.flag_name <> 'quote_option_strict_record_v1';
SELECT pg_temp.qa_today('row missing');
UPDATE public.qa_contract_feature_flags SET enabled = true WHERE flag_name = 'quote_option_strict_record_v1';
CREATE OR REPLACE VIEW public.feature_flags AS
 SELECT f.* FROM public.qa_contract_feature_flags f
  WHERE CASE WHEN f.flag_name = 'quote_option_strict_record_v1' THEN public.qa_contract_raise() ELSE true END;
DO $$
DECLARE v_code text;
BEGIN
 FOREACH v_code IN ARRAY ARRAY['57014', '42501', '55P03', '42P01', 'P0001', 'P0004'] LOOP
  PERFORM set_config('qa.flag_error', v_code, true);
  PERFORM pg_temp.qa_today('unreadable ' || v_code);
 END LOOP;
END $$;
-- The atomic marker is read before, and apart from, the strict switch: with the strict
-- switch unreadable the atomic acceptance must still be refused and roll back.
DO $$
DECLARE v_code text; v_res text;
BEGIN
 FOREACH v_code IN ARRAY ARRAY['57014', 'P0001'] LOOP
  PERFORM set_config('qa.flag_error', v_code, true);
  v_res := pg_temp.qa_try($q$SELECT pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000a1', 'accepted')$q$);
  IF v_res NOT LIKE 'err:quote_option_unrecorded%'
     OR (SELECT accepted_at IS NOT NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000a1') THEN
   RAISE EXCEPTION 'quote accept atomic contract: strict unreadable %: the atomic acceptance must still roll back', v_code;
  END IF;
 END LOOP;
END $$;
DROP VIEW public.feature_flags;
ALTER TABLE public.qa_contract_feature_flags RENAME TO feature_flags;
DROP FUNCTION public.qa_contract_raise();
-- Strict after atomic, enforced in the trigger (CIO condition 4): with the strict switch on
-- and quote_accept_atomic_v1 off, missing or unreadable, strict has no effect and the plain
-- UPDATE stands as today.
SELECT pg_temp.qa_assert((SELECT enabled FROM public.feature_flags WHERE flag_name = 'quote_option_strict_record_v1')
 AND NOT (SELECT enabled FROM public.feature_flags WHERE flag_name = 'quote_accept_atomic_v1'),
 'setup: strict on, atomic off');
SELECT pg_temp.qa_today('on, atomic off');
ALTER TABLE public.feature_flags RENAME TO qa_contract_feature_flags;
CREATE VIEW public.feature_flags AS
 SELECT f.* FROM public.qa_contract_feature_flags f WHERE f.flag_name <> 'quote_accept_atomic_v1';
SELECT pg_temp.qa_today('on, atomic row missing');
UPDATE public.qa_contract_feature_flags SET enabled = true WHERE flag_name = 'quote_accept_atomic_v1';
CREATE FUNCTION public.qa_contract_raise() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'contract forced switch read failure' USING ERRCODE = current_setting('qa.flag_error');
END $$;
CREATE OR REPLACE VIEW public.feature_flags AS
 SELECT f.* FROM public.qa_contract_feature_flags f
  WHERE CASE WHEN f.flag_name = 'quote_accept_atomic_v1' THEN public.qa_contract_raise() ELSE true END;
DO $$
DECLARE v_code text;
BEGIN
 FOREACH v_code IN ARRAY ARRAY['57014', 'P0001'] LOOP
  PERFORM set_config('qa.flag_error', v_code, true);
  PERFORM pg_temp.qa_today('on, atomic unreadable ' || v_code);
 END LOOP;
END $$;
DROP VIEW public.feature_flags;
ALTER TABLE public.qa_contract_feature_flags RENAME TO feature_flags;
DROP FUNCTION public.qa_contract_raise();
-- With both readable and on (owning-review behaviour), the same plain UPDATE is refused and
-- rolls back: this is what could block a staff status change.
SELECT set_config('qa.r', pg_temp.qa_try($q$UPDATE public.jobs SET status = 'accepted'
  WHERE id = '9a000000-0000-4000-8000-0000000000a1'$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:quote_option_unrecorded%'
 AND (SELECT status = 'quoted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1'),
 'strict and atomic on: a status change whose supersede run records nothing must be refused');
-- Aggregate controls (Codex 25df33f should-fix 1), with strict and atomic both stored true.
-- Each fixture view injects its value or fault in the projected enabled column, so it can
-- only fire for a row the reader selected: the supersede read (its own row) cannot trigger
-- it. A sequence (nextval is never rolled back) counts the injected read failures, proving
-- each fault fired at the final gate's read and not elsewhere.
CREATE SEQUENCE public.qa_contract_flag_faults;
CREATE FUNCTION public.qa_contract_raise() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM nextval('public.qa_contract_flag_faults');
 RAISE EXCEPTION 'contract forced switch read failure' USING ERRCODE = current_setting('qa.flag_error');
END $$;
ALTER TABLE public.feature_flags RENAME TO qa_contract_feature_flags;
CREATE FUNCTION pg_temp.qa_flags_view(p_select text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE 'DROP VIEW IF EXISTS public.feature_flags';
 EXECUTE 'CREATE VIEW public.feature_flags AS ' || p_select;
END $$;
CREATE FUNCTION pg_temp.qa_refused(p_case text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_res text;
BEGIN
 v_res := pg_temp.qa_try($q$UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000a1'$q$);
 IF v_res NOT LIKE 'err:quote_option_unrecorded%'
    OR (SELECT status FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1') <> 'quoted' THEN
  RAISE EXCEPTION 'quote accept atomic contract: strict %: the status change must be refused', p_case;
 END IF;
END $$;
-- Control: the plain projecting view, both true, refuses (so the cases below reach the gate).
SELECT pg_temp.qa_flags_view($v$SELECT f.flag_name, f.enabled FROM public.qa_contract_feature_flags f$v$);
SELECT pg_temp.qa_refused('control, both true');
-- atomic NULL: stands.
SELECT pg_temp.qa_flags_view($v$SELECT f.flag_name,
  CASE WHEN f.flag_name = 'quote_accept_atomic_v1' THEN NULL::boolean ELSE f.enabled END AS enabled
  FROM public.qa_contract_feature_flags f$v$);
SELECT pg_temp.qa_today('on, atomic NULL');
-- Duplicate atomic rows, both true: refuses. One true and one false, or one NULL: stands.
SELECT pg_temp.qa_flags_view($v$SELECT f.flag_name, f.enabled FROM public.qa_contract_feature_flags f
  UNION ALL SELECT 'quote_accept_atomic_v1', true$v$);
SELECT pg_temp.qa_refused('duplicate atomic rows, both true');
SELECT pg_temp.qa_flags_view($v$SELECT f.flag_name, f.enabled FROM public.qa_contract_feature_flags f
  UNION ALL SELECT 'quote_accept_atomic_v1', false$v$);
SELECT pg_temp.qa_today('duplicate atomic rows, true and false');
SELECT pg_temp.qa_flags_view($v$SELECT f.flag_name, f.enabled FROM public.qa_contract_feature_flags f
  UNION ALL SELECT 'quote_option_strict_record_v1', NULL::boolean$v$);
SELECT pg_temp.qa_today('duplicate strict rows, true and NULL');
-- Either row unreadable while the other is true: stands, and the fault fired at the gate.
DO $$
DECLARE v_code text; v_flag text; v_before bigint; v_after bigint;
BEGIN
 FOREACH v_flag IN ARRAY ARRAY['quote_option_strict_record_v1', 'quote_accept_atomic_v1'] LOOP
  PERFORM pg_temp.qa_flags_view(format($v$SELECT f.flag_name,
    CASE WHEN f.flag_name = %L THEN public.qa_contract_raise() ELSE f.enabled END AS enabled
    FROM public.qa_contract_feature_flags f$v$, v_flag));
  FOREACH v_code IN ARRAY ARRAY['57014', 'P0001'] LOOP
   PERFORM set_config('qa.flag_error', v_code, true);
   SELECT last_value + CASE WHEN is_called THEN 0 ELSE -1 END INTO v_before FROM public.qa_contract_flag_faults;
   PERFORM pg_temp.qa_today(v_flag || ' unreadable ' || v_code || ', other true');
   SELECT last_value + CASE WHEN is_called THEN 0 ELSE -1 END INTO v_after FROM public.qa_contract_flag_faults;
   IF v_after <= v_before THEN
    RAISE EXCEPTION 'quote accept atomic contract: % unreadable %: the fault must fire at the final gate''s read', v_flag, v_code;
   END IF;
  END LOOP;
 END LOOP;
END $$;
DROP VIEW public.feature_flags;
ALTER TABLE public.qa_contract_feature_flags RENAME TO feature_flags;
DROP FUNCTION public.qa_contract_raise();
DROP SEQUENCE public.qa_contract_flag_faults;
-- C4 (Codex d98903c): with strict and atomic both on and the triple failure forced, an
-- unmarked status write that crosses the won boundary is refused in either direction, while
-- send-quote's legacy status write (quote_accept_legacy_set_status) always stands, as today.
-- Its marker does not outlive the call; the atomic marker still wins over it.
CREATE FUNCTION pg_temp.qa_cross(p_job uuid, p_status text, p_case text, p_refused boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_res text;
BEGIN
 v_res := pg_temp.qa_try(format('UPDATE public.jobs SET status = %L WHERE id = %L', p_status, p_job));
 IF (v_res LIKE 'err:quote_option_unrecorded%') IS DISTINCT FROM p_refused THEN
  RAISE EXCEPTION 'quote accept atomic contract: C4 %: unmarked write expected refused=% (got %)', p_case, p_refused, v_res;
 END IF;
END $$;
CREATE FUNCTION pg_temp.qa_legacy(p_job uuid, p_status text, p_at timestamptz, p_case text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_res text;
BEGIN
 v_res := pg_temp.qa_try(format('SELECT public.quote_accept_legacy_set_status(%L, %L, %L)', p_job, p_status, p_at));
 IF v_res <> 'ok' THEN
  RAISE EXCEPTION 'quote accept atomic contract: C4 %: the legacy status write must stand (got %)', p_case, v_res;
 END IF;
END $$;
-- Partially accepted to accepted (Codex finding 1; the checker's c4c at d98903c). The
-- triple failure here is reached through the review-event and run-insert injectors (the
-- mark injector only fires where a sibling is marked). A1 is
-- shaped as a shared fence run: two parties' run documents and run acceptances, both
-- accepted, then party 2's status write. A2 is shaped as c4d: a whole quote with two
-- contacts' documents, both accepted. The trigger never reads documents, so the shapes
-- only matter to the gap read.
INSERT INTO public.job_contacts (id, job_id) VALUES
 ('9c000000-0000-4000-8000-0000000000f5', '9a000000-0000-4000-8000-0000000000a1'), ('9c000000-0000-4000-8000-0000000000f6', '9a000000-0000-4000-8000-0000000000a1'),
 ('9c000000-0000-4000-8000-0000000000f7', '9a000000-0000-4000-8000-0000000000a2'), ('9c000000-0000-4000-8000-0000000000f8', '9a000000-0000-4000-8000-0000000000a2');
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, run_label, job_contact_id, accepted_at) VALUES
 ('9d000000-0000-4000-8000-0000000000f5', '9a000000-0000-4000-8000-0000000000a1', 'quote', true, 'A', '9c000000-0000-4000-8000-0000000000f5', '2026-10-20 01:00:00+00'),
 ('9d000000-0000-4000-8000-0000000000f6', '9a000000-0000-4000-8000-0000000000a1', 'quote', true, 'A', '9c000000-0000-4000-8000-0000000000f6', '2026-10-20 02:00:00+00'),
 ('9d000000-0000-4000-8000-0000000000f7', '9a000000-0000-4000-8000-0000000000a2', 'quote', true, NULL, '9c000000-0000-4000-8000-0000000000f7', '2026-10-20 01:00:00+00'),
 ('9d000000-0000-4000-8000-0000000000f8', '9a000000-0000-4000-8000-0000000000a2', 'quote', true, NULL, '9c000000-0000-4000-8000-0000000000f8', '2026-10-20 02:00:00+00');
INSERT INTO public.run_acceptances (job_id, job_contact_id, job_document_id, run_label, status, accepted_at) VALUES
 ('9a000000-0000-4000-8000-0000000000a1', '9c000000-0000-4000-8000-0000000000f5', '9d000000-0000-4000-8000-0000000000f5', 'A', 'accepted', '2026-10-20 01:00:00+00'),
 ('9a000000-0000-4000-8000-0000000000a1', '9c000000-0000-4000-8000-0000000000f6', '9d000000-0000-4000-8000-0000000000f6', 'A', 'accepted', '2026-10-20 02:00:00+00');
-- A1's original whole-job quote DA1 (live, unaccepted) is retired for these cases and put
-- back in the reset below, so A1 holds only the two run documents (Codex 1327792 finding 1).
UPDATE public.job_documents SET superseded_at = '2026-10-20 00:30:00+00' WHERE id = '9d000000-0000-4000-8000-0000000000a1';
UPDATE public.jobs SET status = 'partially_accepted' WHERE id IN ('9a000000-0000-4000-8000-0000000000a1', '9a000000-0000-4000-8000-0000000000a2');
-- Before the fix lands its status: each job is listed (visible, not silent as at d98903c).
SELECT pg_temp.qa_assert((SELECT count(*) = 2 FROM public.quote_acceptance_gaps()
   WHERE kind = 'partially_accepted_all_documents_accepted' AND job_id IN ('9a000000-0000-4000-8000-0000000000a1', '9a000000-0000-4000-8000-0000000000a2')),
 'C4: a job left partially accepted with every party accepted must be listed (c4c, c4d)');
SELECT pg_temp.qa_cross('9a000000-0000-4000-8000-0000000000a1', 'accepted', 'partial to accepted', true);
SELECT pg_temp.qa_assert((SELECT status = 'partially_accepted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1'),
 'C4: the refused unmarked write leaves the job partially accepted');
SELECT pg_temp.qa_legacy('9a000000-0000-4000-8000-0000000000a1', 'accepted', '2026-10-20 02:00:00+00', 'partial to accepted');
SELECT pg_temp.qa_assert((SELECT status = 'accepted' AND accepted_at = '2026-10-20 02:00:00+00' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind IN ('partially_accepted_all_documents_accepted', 'accepted_document_job_not_won') AND job_id = '9a000000-0000-4000-8000-0000000000a1')
 AND coalesce(current_setting('sw.quote_accept_legacy', true), '') = '',
 'C4: the legacy write stands with its accepted_at, and its marker does not outlive the call');
-- No leak: an unmarked write later in the same transaction is still refused.
SELECT pg_temp.qa_cross('9a000000-0000-4000-8000-0000000000a2', 'accepted', 'unmarked after a legacy write', true);
SELECT pg_temp.qa_legacy('9a000000-0000-4000-8000-0000000000a2', 'accepted', NULL, 'second winner');
SELECT pg_temp.qa_assert((SELECT status = 'accepted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a2')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'partially_accepted_all_documents_accepted' AND job_id = '9a000000-0000-4000-8000-0000000000a2'),
 'C4 (c4d shape): the last contact''s legacy status write stands and the job drops out');
-- Won to partially accepted, and won to quoted (Codex finding 2): A1 leaving won makes the
-- trigger mark A1 under the remaining winner A2, which is forced to fail.
SELECT pg_temp.qa_cross('9a000000-0000-4000-8000-0000000000a1', 'partially_accepted', 'won to partial', true);
SELECT pg_temp.qa_legacy('9a000000-0000-4000-8000-0000000000a1', 'partially_accepted', NULL, 'won to partial');
SELECT pg_temp.qa_assert((SELECT status = 'partially_accepted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1'),
 'C4: the legacy write out of won stands');
SELECT pg_temp.qa_legacy('9a000000-0000-4000-8000-0000000000a1', 'accepted', '2026-10-20 03:00:00+00', 'back to won');
SELECT pg_temp.qa_cross('9a000000-0000-4000-8000-0000000000a1', 'quoted', 'won to quoted', true);
SELECT pg_temp.qa_legacy('9a000000-0000-4000-8000-0000000000a1', 'quoted', NULL, 'won to quoted');
-- The atomic marker wins over the legacy marker.
CREATE FUNCTION pg_temp.qa_both_markers() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('sw.quote_accept_legacy', 'on', true);
 PERFORM set_config('sw.quote_accept_atomic', 'on', true);
 UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000a1';
END $$;
SELECT set_config('qa.r', pg_temp.qa_try('SELECT pg_temp.qa_both_markers()'), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:quote_option_unrecorded%'
 AND (SELECT status = 'quoted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1')
 AND coalesce(current_setting('sw.quote_accept_legacy', true), '') = ''
 AND coalesce(current_setting('sw.quote_accept_atomic', true), '') = '',
 'C4: the atomic marker must win over the legacy marker');
UPDATE public.feature_flags SET enabled = false
 WHERE flag_name IN ('quote_option_strict_record_v1', 'quote_accept_atomic_v1');
-- Put A1 and A2 back as they were (quoted, unmarked, no accepted_at) without the trigger.
SET LOCAL session_replication_role = replica;
UPDATE public.jobs SET status = 'quoted', accepted_at = NULL, superseded_at = NULL, superseded_by_job_id = NULL
 WHERE id IN ('9a000000-0000-4000-8000-0000000000a1', '9a000000-0000-4000-8000-0000000000a2');
UPDATE public.job_documents SET superseded_at = NULL WHERE id = '9d000000-0000-4000-8000-0000000000a1';
DELETE FROM public.run_acceptances WHERE job_document_id IN ('9d000000-0000-4000-8000-0000000000f5', '9d000000-0000-4000-8000-0000000000f6');
DELETE FROM public.job_documents WHERE id IN ('9d000000-0000-4000-8000-0000000000f5', '9d000000-0000-4000-8000-0000000000f6',
  '9d000000-0000-4000-8000-0000000000f7', '9d000000-0000-4000-8000-0000000000f8');
DELETE FROM public.job_contacts WHERE id IN ('9c000000-0000-4000-8000-0000000000f5', '9c000000-0000-4000-8000-0000000000f6',
  '9c000000-0000-4000-8000-0000000000f7', '9c000000-0000-4000-8000-0000000000f8');
SET LOCAL session_replication_role = origin;
-- The marker is cooperative, not proof of origin: any SQL writer that sets it gets the raise.
-- Documented as a trusted-writer assumption.
CREATE FUNCTION pg_temp.qa_marked_update() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('sw.quote_accept_atomic', 'on', true);
 UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000a1';
END $$;
SELECT set_config('qa.r', pg_temp.qa_try('SELECT pg_temp.qa_marked_update()'), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:quote_option_unrecorded%'
 AND (SELECT status = 'quoted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000a1'),
 'the marker, however set, must make the final site raise (trusted-writer assumption)');
SELECT set_config('sw.quote_accept_atomic', '', true);
DROP TRIGGER qa_contract_fail_review ON public.job_events;
DROP FUNCTION public.qa_contract_fail_review();
DROP TRIGGER qa_contract_fail_mark ON public.jobs;
DROP FUNCTION public.qa_contract_fail_mark();
DROP TRIGGER qa_contract_fail_run ON public.quote_option_settle_runs;
DROP FUNCTION public.qa_contract_fail_run();
-- Positive control: with nothing forced, the same atomic acceptance commits and supersedes A2.
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000a1', 'accepted')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted'
 AND (SELECT superseded_by_job_id = '9a000000-0000-4000-8000-0000000000a1' FROM public.jobs
       WHERE id = '9a000000-0000-4000-8000-0000000000a2')
 AND (SELECT count(*) = 1 FROM public.quote_option_settle_runs
       WHERE job_id = '9a000000-0000-4000-8000-0000000000a1' AND settled_at IS NOT NULL),
 'with nothing forced, the atomic acceptance must commit and the trigger must supersede the sibling');
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'quote_option_supersede_v1';

-- Whole quote. Job B (patio), recipient with no contact row: options DB1 and DB2; a second
-- party (contact CB) has DB3.
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'quoted', 'patio');
INSERT INTO public.job_contacts (id, job_id) VALUES
 ('9c000000-0000-4000-8000-0000000000b3', '9a000000-0000-4000-8000-0000000000b1');
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, job_contact_id) VALUES
 ('9d000000-0000-4000-8000-0000000000b1', '9a000000-0000-4000-8000-0000000000b1', 'quote', true, NULL),
 ('9d000000-0000-4000-8000-0000000000b2', '9a000000-0000-4000-8000-0000000000b1', 'quote', true, NULL),
 ('9d000000-0000-4000-8000-0000000000b3', '9a000000-0000-4000-8000-0000000000b1', 'quote', true, '9c000000-0000-4000-8000-0000000000b3'),
 ('9d000000-0000-4000-8000-0000000000b4', '9a000000-0000-4000-8000-0000000000b1', 'quote', false, NULL);
-- A stale snapshot writes nothing.
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b1', 'partially_accepted', NULL, NULL, 'not-the-snapshot')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb
  ->> 'outcome' = 'stale'
 AND (SELECT accepted_at IS NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000b1')
 AND (SELECT status = 'quoted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000b1'),
 'a changed snapshot must be stale and write nothing');
-- The snapshot and its fingerprint come from one statement and agree.
SELECT pg_temp.qa_assert((SELECT (x->>'fingerprint') = public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000b1')
   AND jsonb_array_length(x->'documents') = 4
   AND (x->'documents'->0) ? 'share_token' AND (x->'documents'->0) ? 'data_snapshot_json'
  FROM (SELECT public.quote_acceptance_snapshot('9a000000-0000-4000-8000-0000000000b1', NULL) AS x) s),
 'the snapshot must return its documents and the matching fingerprint');
-- Each input the guards and party rules read changes the fingerprint, and putting it back
-- restores it. A NULL-to-value move between columns is not lost.
CREATE FUNCTION pg_temp.qa_fp_moves(p_sql text, p_undo text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_before text := public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000b1');
BEGIN
 EXECUTE p_sql;
 IF public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000b1') = v_before THEN
  RAISE EXCEPTION 'quote accept atomic contract: % must change the fingerprint', p_what;
 END IF;
 EXECUTE p_undo;
 IF public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000b1') <> v_before THEN
  RAISE EXCEPTION 'quote accept atomic contract: undoing % must restore the fingerprint', p_what;
 END IF;
END $$;
INSERT INTO public.job_contacts (id, job_id) VALUES
 ('9c000000-0000-4000-8000-0000000000b9', '9a000000-0000-4000-8000-0000000000b1');
DO $$
DECLARE d text := '''9d000000-0000-4000-8000-0000000000b3''';
BEGIN
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET declined_at = now() WHERE id = ' || d,
   'UPDATE public.job_documents SET declined_at = NULL WHERE id = ' || d, 'a decline');
 UPDATE public.job_documents SET accepted_at = '2026-10-01 00:00:00+00' WHERE id = '9d000000-0000-4000-8000-0000000000b3';
 PERFORM pg_temp.qa_fp_moves(
   'UPDATE public.job_documents SET accepted_at = NULL, declined_at = ''2026-10-01 00:00:00+00'' WHERE id = ' || d,
   'UPDATE public.job_documents SET accepted_at = ''2026-10-01 00:00:00+00'', declined_at = NULL WHERE id = ' || d,
   'moving one instant from accepted_at to declined_at');
 UPDATE public.job_documents SET accepted_at = NULL WHERE id = '9d000000-0000-4000-8000-0000000000b3';
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET run_label = ''Z'' WHERE id = ' || d,
   'UPDATE public.job_documents SET run_label = NULL WHERE id = ' || d, 'a raw run label');
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET data_snapshot_json = ''{"run":{"run_label":"X"}}'' WHERE id = ' || d,
   'UPDATE public.job_documents SET data_snapshot_json = NULL WHERE id = ' || d, 'a snapshot run label');
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET version = version + 1 WHERE id = ' || d,
   'UPDATE public.job_documents SET version = version - 1 WHERE id = ' || d, 'a version');
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET sent_to_client = false WHERE id = ' || d,
   'UPDATE public.job_documents SET sent_to_client = true WHERE id = ' || d, 'sent_to_client');
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET share_token = ''rotated'' WHERE id = ' || d,
   'UPDATE public.job_documents SET share_token = ''tok-9d000000-0000-4000-8000-0000000000b3'' WHERE id = ' || d, 'a token rotation');
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET send_claimed_at = now() WHERE id = ' || d,
   'UPDATE public.job_documents SET send_claimed_at = NULL WHERE id = ' || d, 'a send claim');
 PERFORM pg_temp.qa_fp_moves('UPDATE public.job_documents SET superseded_at = now() WHERE id = ' || d,
   'UPDATE public.job_documents SET superseded_at = NULL WHERE id = ' || d, 'a supersession');
 PERFORM pg_temp.qa_fp_moves($q$INSERT INTO public.run_acceptances (id, job_id, job_contact_id, run_label, status)
   VALUES ('9e000000-0000-4000-8000-0000000000b9', '9a000000-0000-4000-8000-0000000000b1', '9c000000-0000-4000-8000-0000000000b9', 'R', 'pending')$q$,
   $q$DELETE FROM public.run_acceptances WHERE id = '9e000000-0000-4000-8000-0000000000b9'$q$, 'a run acceptance');
 INSERT INTO public.run_acceptances (id, job_id, job_contact_id, run_label, status)
 VALUES ('9e000000-0000-4000-8000-0000000000b9', '9a000000-0000-4000-8000-0000000000b1', '9c000000-0000-4000-8000-0000000000b9', 'R', 'pending');
 PERFORM pg_temp.qa_fp_moves($q$UPDATE public.run_acceptances SET status = 'declined' WHERE id = '9e000000-0000-4000-8000-0000000000b9'$q$,
   $q$UPDATE public.run_acceptances SET status = 'pending' WHERE id = '9e000000-0000-4000-8000-0000000000b9'$q$, 'a run acceptance status');
 DELETE FROM public.run_acceptances WHERE id = '9e000000-0000-4000-8000-0000000000b9';
 PERFORM pg_temp.qa_fp_moves($q$INSERT INTO public.run_line_items (id, job_id, run_label, job_contact_id, description)
   VALUES ('9f000000-0000-4000-8000-0000000000b9', '9a000000-0000-4000-8000-0000000000b1', 'R', '9c000000-0000-4000-8000-0000000000b9', 'x')$q$,
   $q$DELETE FROM public.run_line_items WHERE id = '9f000000-0000-4000-8000-0000000000b9'$q$, 'a run line item');
END $$;
DO $$
DECLARE v_before text := public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000b1');
BEGIN
 PERFORM set_config('TimeZone', 'Australia/Perth', true);
 IF public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000b1') <> v_before THEN
  RAISE EXCEPTION 'quote accept atomic contract: the fingerprint must not depend on TimeZone';
 END IF;
END $$;
-- A rotated or wrong token is refused before anything is written.
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b1', 'partially_accepted', NULL, NULL, NULL, 'wrong-token')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb
  ->> 'reason' = 'not_a_sent_quote'
 AND (SELECT accepted_at IS NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000b1'),
 'a token that is not the document''s current one must be refused');
-- A whole quote without its acceptance event raises and writes nothing.
SELECT set_config('qa.r', pg_temp.qa_try($q$SELECT public.accept_quote_document_atomic('9d000000-0000-4000-8000-0000000000b1',
   'tok-9d000000-0000-4000-8000-0000000000b1', gen_random_uuid(), now(), 'partially_accepted',
   public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000b1'), NULL, NULL, NULL)$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:quote_accept_event_missing%'
 AND (SELECT accepted_at IS NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000b1'),
 'a whole-quote acceptance must carry its acceptance event');
-- Bad inputs raise and write nothing.
SELECT set_config('qa.r', pg_temp.qa_try($q$SELECT pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b1', 'scheduled')$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:quote_accept_bad_status%'
 AND (SELECT accepted_at IS NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000b1'),
 'an invalid status must raise and write nothing');
SELECT set_config('qa.r', pg_temp.qa_try($q$SELECT pg_temp.qa_accept('9d000000-0000-4000-8000-00000000ffff', 'accepted')$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:quote_accept_document_missing%',
 'a missing document must raise');
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b4', 'accepted')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'reason' = 'not_a_sent_quote',
 'an unsent document must be refused');
-- Accept DB1: DB1 accepted, DB2 superseded, DB3 (another party) untouched, status as given,
-- the acceptance event and the attempt row, in one transaction.
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b1', 'partially_accepted', NULL,
   '{"document_id":"9d000000-0000-4000-8000-0000000000b1","new_status":"partially_accepted"}'::jsonb, NULL, NULL,
   '9b000000-0000-4000-8000-0000000000b1')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted',
 'a whole-quote acceptance must commit');
SELECT pg_temp.qa_assert((SELECT accepted_at = '2026-10-19 12:00:00+00' FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000b1')
 AND (SELECT superseded_at IS NOT NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000b2')
 AND (SELECT superseded_at IS NULL AND accepted_at IS NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000b3')
 AND (SELECT status = 'partially_accepted' AND accepted_at IS NULL FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000b1')
 AND (SELECT count(*) = 1 FROM public.job_events WHERE job_id = '9a000000-0000-4000-8000-0000000000b1' AND event_type = 'quote_accepted')
 AND (SELECT count(*) = 1 FROM public.quote_acceptance_attempts WHERE document_id = '9d000000-0000-4000-8000-0000000000b1'
       AND job_status = 'partially_accepted' AND previous_status = 'quoted' AND run_label IS NULL),
 'a whole-quote acceptance must write the document, the sibling, the status, the event and the attempt together');
-- Replay: the same document returns the stored result and writes nothing, even with a stale
-- fingerprint and a different status asked for.
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b1', 'accepted', NULL, NULL, 'stale')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb
  ->> 'request_id' = '9b000000-0000-4000-8000-0000000000b1'
 AND (SELECT status = 'partially_accepted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000b1')
 AND (SELECT count(*) = 1 FROM public.job_events WHERE job_id = '9a000000-0000-4000-8000-0000000000b1' AND event_type = 'quote_accepted'),
 'a repeat call must replay the committed result (with the committing request) and write nothing');
-- The superseded sibling is refused.
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b2', 'accepted')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'reason' = 'superseded',
 'a superseded option must be refused');
-- The second party accepts: the status written is the caller's (send-quote's party rules).
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000b3', 'accepted')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted'
 AND (SELECT status = 'accepted' AND accepted_at = '2026-10-19 12:00:00+00' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000b1'),
 'the second party''s acceptance must set accepted with its accepted_at');

-- A job staff had already moved on: today's overwrite is kept and recorded for a person.
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'scheduled', 'patio');
INSERT INTO public.job_documents (id, job_id, type, sent_to_client) VALUES
 ('9d000000-0000-4000-8000-0000000000c1', '9a000000-0000-4000-8000-0000000000c1', 'quote', true);
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000c1', 'accepted')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'previous_status' = 'scheduled'
 AND (SELECT status = 'accepted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000c1')
 AND (SELECT count(*) = 1 FROM public.job_events WHERE job_id = '9a000000-0000-4000-8000-0000000000c1'
       AND event_type = 'quote_acceptance_review_needed' AND detail_json->>'reason' = 'accepted_after_status_moved'),
 'an acceptance after staff moved the job must overwrite as today and leave a review event');

-- Per run. Job E (fencing), neighbour contact CE: run document DE1 for run A.
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing');
INSERT INTO public.job_contacts (id, job_id) VALUES
 ('9c000000-0000-4000-8000-0000000000e1', '9a000000-0000-4000-8000-0000000000e1');
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, job_contact_id, run_label) VALUES
 ('9d000000-0000-4000-8000-0000000000e1', '9a000000-0000-4000-8000-0000000000e1', 'quote', true, '9c000000-0000-4000-8000-0000000000e1', 'A'),
 ('9d000000-0000-4000-8000-0000000000e2', '9a000000-0000-4000-8000-0000000000e1', 'quote', true, NULL, 'A');
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000e1', 'partially_accepted', 'A')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted'
 AND (SELECT count(*) = 1 FROM public.job_events WHERE job_id = '9a000000-0000-4000-8000-0000000000e1'
       AND event_type = 'quote_run_accepted' AND detail_json->>'run_label' = 'A'
       AND (detail_json->>'accepted_at')::timestamptz = '2026-10-19 12:00:00+00')
 AND (SELECT count(*) = 1 FROM public.run_acceptances WHERE job_id = '9a000000-0000-4000-8000-0000000000e1'
       AND job_contact_id = '9c000000-0000-4000-8000-0000000000e1' AND run_label = 'A' AND status = 'accepted'
       AND job_document_id = '9d000000-0000-4000-8000-0000000000e1')
 AND (SELECT status = 'partially_accepted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000e1')
 AND (SELECT superseded_at IS NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000e2'),
 'a run acceptance must write the run acceptance and the status together, and supersede nothing');
SELECT set_config('qa.r', ((pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000e2', 'accepted', 'A')))::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted'
 AND (SELECT accepted_at IS NOT NULL FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000e2')
 AND (SELECT count(*) = 1 FROM public.run_acceptances WHERE job_id = '9a000000-0000-4000-8000-0000000000e1')
 AND (SELECT status = 'accepted' FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000e1'),
 'a run document with no contact must accept as today: no run acceptance row, the status written');

-- CIO condition 2: a live accepted document on a job still quoted (a split write whose
-- status never landed, e.g. strict on with the atomic path off) is listed; a job won through
-- the atomic path, which carries its acceptance event, is not.
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000c3', '00000000-0000-0000-0000-000000000001', 'quoted', 'patio');
INSERT INTO public.job_documents (id, job_id, type, sent_to_client) VALUES
 ('9d000000-0000-4000-8000-0000000000c3', '9a000000-0000-4000-8000-0000000000c3', 'quote', true);
UPDATE public.job_documents SET accepted_at = '2026-10-19 12:00:00+00' WHERE id = '9d000000-0000-4000-8000-0000000000c3';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_document_job_not_won' AND ref = '9d000000-0000-4000-8000-0000000000c3')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000b1')
 AND (SELECT count(*) = 0 FROM public.quote_acceptance_gaps(interval '15 minutes', '2026-10-20 00:00:00+00')
   WHERE kind = 'accepted_document_job_not_won' AND ref = '9d000000-0000-4000-8000-0000000000c3'),
 'R3: an accepted document on a job not won must be listed (and p_since must bound it); an atomic win must not be');
-- A won job with a sent quote and no acceptance event (a staff or legacy writer) is listed.
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000c3';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000c3')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_document_job_not_won' AND ref = '9d000000-0000-4000-8000-0000000000c3'),
 'R3: a won job with no acceptance event must be listed, and the accepted document then drops out');
UPDATE public.jobs SET status = 'lost' WHERE id = '9a000000-0000-4000-8000-0000000000c3';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_document_job_not_won' AND ref = '9d000000-0000-4000-8000-0000000000c3'),
 'R3: an accepted document on a job lost afterwards must be listed');
-- Condition-based (Codex fb11da4 must-fix 2): a resolution is refused, and the same
-- document listed again after its job is won and then reopened.
SELECT set_config('qa.r', pg_temp.qa_try($q$INSERT INTO public.quote_acceptance_gap_resolutions (kind, ref, resolved_by)
  VALUES ('accepted_document_job_not_won', '9d000000-0000-4000-8000-0000000000c3',
          '00000000-0000-0000-0000-000000000001')$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:%',
 'R3: an accepted document on a job not won must not be resolvable');
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000c3';
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_document_job_not_won' AND ref = '9d000000-0000-4000-8000-0000000000c3'),
 'R3: the accepted document drops out while its job is won');
UPDATE public.jobs SET status = 'quoted' WHERE id = '9a000000-0000-4000-8000-0000000000c3';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_document_job_not_won' AND ref = '9d000000-0000-4000-8000-0000000000c3'),
 'R3: an accepted document whose job is reopened must be listed again');
-- Codex fb11da4 must-fix 1: an earlier acceptance event does not cover a later win. Job C6
-- has a run acceptance event from 1 October; a later win at a new instant writes no event.
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000c6', '00000000-0000-0000-0000-000000000001', 'partially_accepted', 'fencing');
INSERT INTO public.job_events (job_id, event_type, detail_json) VALUES
 ('9a000000-0000-4000-8000-0000000000c6', 'quote_run_accepted', '{"accepted_at":"2026-10-01T00:00:00+00:00","run_label":"A"}');
UPDATE public.jobs SET status = 'accepted', accepted_at = '2026-10-19 09:00:00+00'
 WHERE id = '9a000000-0000-4000-8000-0000000000c6';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000c6'),
 'R3: a win whose own acceptance has no event must be listed despite an earlier acceptance event');
-- Reopened and re-won at a new instant: the original event no longer matches.
INSERT INTO public.job_events (job_id, event_type, detail_json) VALUES
 ('9a000000-0000-4000-8000-0000000000c6', 'quote_accepted', '{"accepted_at":"2026-10-19T09:00:00+00:00"}');
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000c6'),
 'R3: a win with an event carrying its own acceptance instant must not be listed');
UPDATE public.jobs SET status = 'quoted' WHERE id = '9a000000-0000-4000-8000-0000000000c6';
UPDATE public.jobs SET status = 'accepted', accepted_at = '2026-10-20 01:00:00+00'
 WHERE id = '9a000000-0000-4000-8000-0000000000c6';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000c6'),
 'R3: a reopened job re-won without an event must be listed again');
-- A won job with no acceptance event and no quote document at all (a staff write) is listed,
-- unless p_since puts its acceptance before the bound.
INSERT INTO public.jobs (id, org_id, status, type, accepted_at) VALUES
 ('9a000000-0000-4000-8000-0000000000c4', '00000000-0000-0000-0000-000000000001', 'quoted', 'patio', '2026-09-01 00:00:00+00');
UPDATE public.jobs SET status = 'scheduled' WHERE id = '9a000000-0000-4000-8000-0000000000c4';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000c4')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '15 minutes', '2026-10-01 00:00:00+00')
   WHERE kind = 'won_without_acceptance_event' AND job_id = '9a000000-0000-4000-8000-0000000000c4'),
 'R3: a staff-won job with no acceptance event must be listed, bounded by p_since');

-- The run neighbour the caller passes must be a value the legacy selection could return in
-- the locked state. Job N (fencing), contacts NA and NB, run documents per case.
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000c5', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing');
INSERT INTO public.job_contacts (id, job_id) VALUES
 ('9c000000-0000-4000-8000-0000000000c5', '9a000000-0000-4000-8000-0000000000c5'),
 ('9c000000-0000-4000-8000-0000000000c6', '9a000000-0000-4000-8000-0000000000c5');
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, job_contact_id, run_label) VALUES
 ('9d000000-0000-4000-8000-0000000000c5', '9a000000-0000-4000-8000-0000000000c5', 'quote', true, '9c000000-0000-4000-8000-0000000000c5', 'M'),
 ('9d000000-0000-4000-8000-0000000000c6', '9a000000-0000-4000-8000-0000000000c5', 'quote', true, '9c000000-0000-4000-8000-0000000000c5', 'L'),
 ('9d000000-0000-4000-8000-0000000000c7', '9a000000-0000-4000-8000-0000000000c5', 'quote', true, '9c000000-0000-4000-8000-0000000000c5', 'E'),
 ('9d000000-0000-4000-8000-0000000000c8', '9a000000-0000-4000-8000-0000000000c5', 'quote', true, '9c000000-0000-4000-8000-0000000000c5', 'X'),
 ('9d000000-0000-4000-8000-0000000000c9', '9a000000-0000-4000-8000-0000000000c5', 'quote', true, '9c000000-0000-4000-8000-0000000000c6', 'M');
INSERT INTO public.run_line_items (job_id, run_label, job_contact_id, description) VALUES
 ('9a000000-0000-4000-8000-0000000000c5', 'M', NULL, 'mixed: no contact'),
 ('9a000000-0000-4000-8000-0000000000c5', 'M', '9c000000-0000-4000-8000-0000000000c6', 'mixed: neighbour'),
 ('9a000000-0000-4000-8000-0000000000c5', 'L', NULL, 'all no contact'),
 ('9a000000-0000-4000-8000-0000000000c5', 'X', '9c000000-0000-4000-8000-0000000000c6', 'one neighbour');
CREATE FUNCTION pg_temp.qa_run_accept(p_doc uuid, p_run text, p_neighbour uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.accept_quote_document_atomic(p_doc, 'tok-' || p_doc::text, gen_random_uuid(), '2026-10-19 12:00:00+00',
   'partially_accepted', public.quote_acceptance_fingerprint('9a000000-0000-4000-8000-0000000000c5'), p_run, p_neighbour,
   '{"contract":true}'::jsonb)
$$;
-- Mixed run: NULL (a NULL-contact item exists) and NB are both legitimate legacy choices.
SELECT set_config('qa.r', pg_temp.qa_run_accept('9d000000-0000-4000-8000-0000000000c5', 'M', NULL)::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted',
 'run neighbour: NULL must be accepted when the run has a NULL-contact item');
SELECT set_config('qa.r', pg_temp.qa_run_accept('9d000000-0000-4000-8000-0000000000c9', 'M', '9c000000-0000-4000-8000-0000000000c6')::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted',
 'run neighbour: the mixed run''s contact must also be accepted');
-- All-NULL run: NULL accepted; a contact not on the run refused.
SELECT set_config('qa.r', pg_temp.qa_run_accept('9d000000-0000-4000-8000-0000000000c6', 'L', '9c000000-0000-4000-8000-0000000000c6')::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'reason' = 'run_neighbour_unbound',
 'run neighbour: a contact not on the run must be refused');
SELECT set_config('qa.r', pg_temp.qa_run_accept('9d000000-0000-4000-8000-0000000000c6', 'L', NULL)::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted',
 'run neighbour: NULL must be accepted on an all-NULL run');
-- Empty run: NULL accepted.
SELECT set_config('qa.r', pg_temp.qa_run_accept('9d000000-0000-4000-8000-0000000000c7', 'E', NULL)::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted',
 'run neighbour: NULL must be accepted when the run has no line items');
-- Single-neighbour run: NULL refused (the legacy choice is always NB); NB accepted.
SELECT set_config('qa.r', pg_temp.qa_run_accept('9d000000-0000-4000-8000-0000000000c8', 'X', NULL)::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'reason' = 'run_neighbour_unbound',
 'run neighbour: NULL must be refused when every item has a contact');
SELECT set_config('qa.r', pg_temp.qa_run_accept('9d000000-0000-4000-8000-0000000000c8', 'X', '9c000000-0000-4000-8000-0000000000c6')::text, true);
SELECT pg_temp.qa_assert(current_setting('qa.r')::jsonb->>'outcome' = 'accepted',
 'run neighbour: the run''s contact must be accepted');
SELECT pg_temp.qa_assert((public.quote_acceptance_snapshot('9a000000-0000-4000-8000-0000000000c5', 'X')->>'run_neighbour')
   = '9c000000-0000-4000-8000-0000000000c6'
 AND public.quote_acceptance_snapshot('9a000000-0000-4000-8000-0000000000c5', 'E')->>'run_neighbour' IS NULL
 AND public.quote_acceptance_snapshot('9a000000-0000-4000-8000-0000000000c5', NULL)->>'run_neighbour' IS NULL,
 'the snapshot must return the legacy neighbour choice for the run');

-- The handler-finished mark: only the committing request, only once.
SELECT pg_temp.qa_assert(NOT public.quote_acceptance_handler_finished('9d000000-0000-4000-8000-0000000000b1', gen_random_uuid()),
 'another request must not mark the handler finished');
SELECT pg_temp.qa_assert(public.quote_acceptance_handler_finished('9d000000-0000-4000-8000-0000000000b1', '9b000000-0000-4000-8000-0000000000b1'),
 'the committing request must mark the handler finished');
SELECT pg_temp.qa_assert(NOT public.quote_acceptance_handler_finished('9d000000-0000-4000-8000-0000000000b1', '9b000000-0000-4000-8000-0000000000b1'),
 'the handler must be marked finished only once');
SELECT pg_temp.qa_assert(
 (SELECT count(*) = 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_handler_unfinished' AND ref = '9d000000-0000-4000-8000-0000000000b3')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_handler_unfinished' AND ref = '9d000000-0000-4000-8000-0000000000b1')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '1 hour')
   WHERE kind = 'acceptance_handler_unfinished' AND ref = '9d000000-0000-4000-8000-0000000000b3'),
 'the gap read must list an unfinished handler after the grace period, and not a finished one');
-- Review events are listed one by one, and a resolution suppresses only its own row.
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'review_needed' AND job_id = '9a000000-0000-4000-8000-0000000000c1'),
 'the staff-advanced acceptance review event must be listed');
INSERT INTO public.quote_acceptance_gap_resolutions (kind, ref, resolved_by)
SELECT 'acceptance_handler_unfinished', '9d000000-0000-4000-8000-0000000000b3', '00000000-0000-0000-0000-000000000001';
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_handler_unfinished' AND ref = '9d000000-0000-4000-8000-0000000000b3')
 AND (SELECT count(*) = 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_handler_unfinished' AND ref = '9d000000-0000-4000-8000-0000000000c1'),
 'a resolution must suppress exactly its own obligation');
-- A follow-up write that failed after the commit is not swallowed: the handler reports it
-- with its finish mark, and it is listed until a person resolves it.
SELECT pg_temp.qa_assert(public.quote_acceptance_handler_finished('9d000000-0000-4000-8000-0000000000c1',
   (SELECT request_id FROM public.quote_acceptance_attempts WHERE document_id = '9d000000-0000-4000-8000-0000000000c1'),
   'quote.run_accepted: insert failed'),
 'the committing request must mark the handler finished with its follow-up issue');
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_follow_up_issue' AND ref = '9d000000-0000-4000-8000-0000000000c1')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_handler_unfinished' AND ref = '9d000000-0000-4000-8000-0000000000c1')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_follow_up_issue' AND ref = '9d000000-0000-4000-8000-0000000000b1'),
 'a reported follow-up failure must be listed, and a clean finish must not be');
INSERT INTO public.quote_acceptance_gap_resolutions (kind, ref, resolved_by) VALUES
 ('acceptance_follow_up_issue', '9d000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000001');
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps(interval '-1 second')
   WHERE kind = 'acceptance_follow_up_issue' AND ref = '9d000000-0000-4000-8000-0000000000c1'),
 'a person can resolve a reported follow-up failure');

-- R3 bypass: a grouped option set won with its trigger skipped (session_replication_role
-- replica, which only a superuser can set) shows in the gap read.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_option_supersede_v1';
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9a000000-0000-4000-8000-0000000000f1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-f'),
 ('9a000000-0000-4000-8000-0000000000f2', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-f');
SELECT public.link_fence_quote_option('9a000000-0000-4000-8000-0000000000f2', '9a000000-0000-4000-8000-0000000000f1', NULL, NULL);
SET LOCAL session_replication_role = replica;
UPDATE public.jobs SET status = 'accepted', accepted_at = now() WHERE id = '9a000000-0000-4000-8000-0000000000f1';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_with_open_sibling' AND job_id = '9a000000-0000-4000-8000-0000000000f1'),
 'R3: a won option whose status was written without its trigger must be listed');
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'quote_option_supersede_v1';
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps() WHERE kind = 'won_with_open_sibling')
 AND NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps() WHERE kind = 'supersede_switch_unreadable'),
 'R3: with marking off, an open sibling beside a won option is by design and must not be listed (off is not unreadable)');
SET LOCAL session_replication_role = replica;
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000f2';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'more_than_one_won' AND ref LIKE '9a000000-0000-4000-8000-0000000000f1@%'),
 'R3: two won options in one group must be listed');
-- A review-only failure (run insert and work failing, the review event written) has no
-- unsettled run, and is listed by its review event.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_option_supersede_v1';
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9a000000-0000-4000-8000-0000000000f5', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-g'),
 ('9a000000-0000-4000-8000-0000000000f6', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-g');
SELECT public.link_fence_quote_option('9a000000-0000-4000-8000-0000000000f6', '9a000000-0000-4000-8000-0000000000f5', NULL, NULL);
CREATE FUNCTION public.qa_fail_any() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'contract forced failure' USING ERRCODE = '55P03'; END $$;
CREATE TRIGGER qa_fail_run BEFORE INSERT ON public.quote_option_settle_runs FOR EACH ROW EXECUTE FUNCTION public.qa_fail_any();
CREATE TRIGGER qa_fail_mark BEFORE UPDATE OF superseded_at ON public.jobs FOR EACH ROW
 WHEN (NEW.id = '9a000000-0000-4000-8000-0000000000f6' AND NEW.superseded_at IS NOT NULL) EXECUTE FUNCTION public.qa_fail_any();
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000f5';
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_option_settle_runs WHERE job_id = '9a000000-0000-4000-8000-0000000000f5')
 AND (SELECT count(*) = 1 FROM public.quote_acceptance_gaps() WHERE kind = 'review_needed'
   AND job_id = '9a000000-0000-4000-8000-0000000000f5')
 AND (SELECT count(*) = 1 FROM public.quote_acceptance_gaps() WHERE kind = 'won_with_open_sibling'
   AND job_id = '9a000000-0000-4000-8000-0000000000f5'),
 'R3: a review-only failure must be listed by its review event, and its open sibling must still be listed');
DROP TRIGGER qa_fail_mark ON public.jobs;
DROP TRIGGER qa_fail_run ON public.quote_option_settle_runs;
DROP FUNCTION public.qa_fail_any();
-- Independent check at 2a09949: a job won without its trigger and never stamped accepted is
-- still listed, whatever older, unrelated review events its group has.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9a000000-0000-4000-8000-0000000000f7', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-h'),
 ('9a000000-0000-4000-8000-0000000000f8', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-h'),
 ('9a000000-0000-4000-8000-0000000000f9', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-h');
SELECT public.link_fence_quote_option('9a000000-0000-4000-8000-0000000000f8', '9a000000-0000-4000-8000-0000000000f7', NULL, NULL);
SELECT public.link_fence_quote_option('9a000000-0000-4000-8000-0000000000f9', '9a000000-0000-4000-8000-0000000000f7', NULL, NULL);
INSERT INTO public.job_events (job_id, event_type, detail_json, created_at) VALUES
 ('9a000000-0000-4000-8000-0000000000f8', 'quote_option_review_needed', '{"reason":"sibling_busy"}', '2025-10-01 00:00:00+00');
SET LOCAL session_replication_role = replica;
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000f7';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_with_open_sibling' AND job_id = '9a000000-0000-4000-8000-0000000000f7'
     AND ref = '9a000000-0000-4000-8000-0000000000f7>9a000000-0000-4000-8000-0000000000f8'),
 'R3: a won option with no acceptance instant must be listed despite an older unrelated review event');
-- The two condition kinds cannot be resolved (a row version is not a durable occurrence id):
-- each open sibling is listed for as long as the condition holds, and a reopened sibling
-- (cancelled, then quoted again: no trigger run, no event) is listed again.
SELECT set_config('qa.r', pg_temp.qa_try($q$INSERT INTO public.quote_acceptance_gap_resolutions (kind, ref, resolved_by)
  VALUES ('won_with_open_sibling', '9a000000-0000-4000-8000-0000000000f7>9a000000-0000-4000-8000-0000000000f8',
          '00000000-0000-0000-0000-000000000001')$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:%',
 'R3: an open-sibling gap must not be resolvable');
SELECT pg_temp.qa_assert((SELECT count(*) = 2 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_with_open_sibling' AND job_id = '9a000000-0000-4000-8000-0000000000f7'),
 'R3: each open sibling must be listed on its own');
UPDATE public.jobs SET status = 'cancelled' WHERE id = '9a000000-0000-4000-8000-0000000000f8';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_with_open_sibling' AND job_id = '9a000000-0000-4000-8000-0000000000f7'),
 'R3: a sibling no longer open must drop out');
UPDATE public.jobs SET status = 'quoted' WHERE id = '9a000000-0000-4000-8000-0000000000f8';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_with_open_sibling'
     AND ref = '9a000000-0000-4000-8000-0000000000f7>9a000000-0000-4000-8000-0000000000f8'),
 'R3: a reopened sibling must be listed again');
-- Independent check at 60df50f (b3x): an option already marked superseded, then won without
-- the trigger, is listed as won while superseded and as a second winner.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9a000000-0000-4000-8000-0000000000fa', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-k'),
 ('9a000000-0000-4000-8000-0000000000fb', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-k');
SELECT public.link_fence_quote_option('9a000000-0000-4000-8000-0000000000fb', '9a000000-0000-4000-8000-0000000000fa', NULL, NULL);
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000fb';
SELECT pg_temp.qa_assert((SELECT superseded_by_job_id = '9a000000-0000-4000-8000-0000000000fb'
  FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000fa'), 'b3x setup: accepting FB must mark FA');
SET LOCAL session_replication_role = replica;
UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000fa';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'won_while_superseded' AND job_id = '9a000000-0000-4000-8000-0000000000fa')
 AND (SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'more_than_one_won' AND ref LIKE '9a000000-0000-4000-8000-0000000000fa@%'),
 'R3: a superseded option won without the trigger must be listed');
SELECT set_config('qa.r', pg_temp.qa_try($q$INSERT INTO public.quote_acceptance_gap_resolutions (kind, ref, resolved_by)
  VALUES ('won_while_superseded', '9a000000-0000-4000-8000-0000000000fa', '00000000-0000-0000-0000-000000000001')$q$), true);
SELECT pg_temp.qa_assert(current_setting('qa.r') LIKE 'err:%', 'R3: a won-while-superseded gap must not be resolvable');
-- The gap reader treats an unreadable supersede switch as off, for every error the trigger
-- treats so, and still lists everything else.
CREATE FUNCTION public.qa_gap_raise() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'contract forced switch read failure' USING ERRCODE = current_setting('qa.flag_error'); END $$;
ALTER TABLE public.feature_flags RENAME TO qa_gap_flags;
CREATE VIEW public.feature_flags AS SELECT f.* FROM public.qa_gap_flags f
 WHERE CASE WHEN f.flag_name = 'quote_option_supersede_v1' THEN public.qa_gap_raise() ELSE true END;
DO $$
DECLARE v_code text;
BEGIN
 FOREACH v_code IN ARRAY ARRAY['57014', 'P0004', '42501', 'P0001'] LOOP
  PERFORM set_config('qa.flag_error', v_code, true);
  IF EXISTS (SELECT 1 FROM public.quote_acceptance_gaps() WHERE kind = 'won_with_open_sibling')
     OR NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps() WHERE kind = 'review_needed')
     OR NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps() WHERE kind = 'supersede_switch_unreadable') THEN
   RAISE EXCEPTION 'quote accept atomic contract: gap reader with the switch unreadable (%) must read it as off and list the rest', v_code;
  END IF;
 END LOOP;
END $$;
DROP VIEW public.feature_flags;
ALTER TABLE public.qa_gap_flags RENAME TO feature_flags;
DROP FUNCTION public.qa_gap_raise();

-- Switch combinations. In the database, quote_accept_atomic_v1 on means send-quote calls the
-- RPC (path 'rpc'); off, missing or unreadable means today's separate writes (path 'plain',
-- send-quote's own test proves that choice). quote_option_supersede_v1 is false, missing,
-- unreadable or true. quote_option_ops_reader_v1 is read only by the Ops reader (PR 1091), not
-- by anything on this branch; its combinations belong to that reader's contract. The strict
-- switch stays off. Each case runs with and without the triple failure, inside a
-- subtransaction that is always rolled back. Expected:
--   * the only refusal is rpc + supersede true + triple failure (full rollback);
--   * every other case commits the status; the sibling is marked only with supersede true and
--     no failure; the document is accepted on the rpc path only.
-- Compatible switch-on order (for the owning review): quote_accept_atomic_v1 first (the split
-- writes end while the trigger is still silent), then quote_option_ops_reader_v1 (readers
-- verified), then quote_option_supersede_v1. quote_option_strict_record_v1 is a separate
-- decision and never before the atomic path.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9a000000-0000-4000-8000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-d'),
 ('9a000000-0000-4000-8000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-d');
SELECT public.link_fence_quote_option('9a000000-0000-4000-8000-0000000000d2', '9a000000-0000-4000-8000-0000000000d1', NULL, NULL);
INSERT INTO public.job_documents (id, job_id, type, sent_to_client) VALUES
 ('9d000000-0000-4000-8000-0000000000d1', '9a000000-0000-4000-8000-0000000000d1', 'quote', true);
CREATE FUNCTION public.qa_combo_fail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'contract forced combination failure' USING ERRCODE = '55P03';
END $$;
CREATE FUNCTION public.qa_combo_fail_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_type = 'quote_option_review_needed' THEN
  RAISE EXCEPTION 'contract forced combination failure' USING ERRCODE = '55P03';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.qa_combo_raise() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'contract forced switch read failure' USING ERRCODE = '57014'; END $$;
CREATE FUNCTION pg_temp.qa_combo(p_supersede text, p_path text, p_fail boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 v_res text;
 v_refuse boolean := p_fail AND p_supersede = 'true' AND p_path = 'rpc';
 v_status text;
 v_marked boolean;
 v_doc boolean;
BEGIN
 UPDATE public.feature_flags SET enabled = (p_supersede IN ('true', 'unreadable'))
  WHERE flag_name = 'quote_option_supersede_v1';
 IF p_supersede IN ('missing', 'unreadable') THEN
  ALTER TABLE public.feature_flags RENAME TO qa_combo_flags;
  IF p_supersede = 'missing' THEN
   EXECUTE $v$CREATE VIEW public.feature_flags AS SELECT f.* FROM public.qa_combo_flags f
    WHERE f.flag_name <> 'quote_option_supersede_v1'$v$;
  ELSE
   EXECUTE $v$CREATE VIEW public.feature_flags AS SELECT f.* FROM public.qa_combo_flags f
    WHERE CASE WHEN f.flag_name = 'quote_option_supersede_v1' THEN public.qa_combo_raise() ELSE true END$v$;
  END IF;
 END IF;
 IF p_fail THEN
  CREATE TRIGGER qa_combo_fail_run BEFORE INSERT ON public.quote_option_settle_runs FOR EACH ROW
   EXECUTE FUNCTION public.qa_combo_fail();
  CREATE TRIGGER qa_combo_fail_mark BEFORE UPDATE OF superseded_at ON public.jobs FOR EACH ROW
   WHEN (NEW.id = '9a000000-0000-4000-8000-0000000000d2' AND NEW.superseded_at IS NOT NULL)
   EXECUTE FUNCTION public.qa_combo_fail();
  CREATE TRIGGER qa_combo_fail_review BEFORE INSERT ON public.job_events FOR EACH ROW
   EXECUTE FUNCTION public.qa_combo_fail_review();
 END IF;
 IF p_path = 'rpc' THEN
  v_res := pg_temp.qa_try($q$SELECT pg_temp.qa_accept('9d000000-0000-4000-8000-0000000000d1', 'accepted')$q$);
 ELSE
  v_res := pg_temp.qa_try($q$UPDATE public.jobs SET status = 'accepted' WHERE id = '9a000000-0000-4000-8000-0000000000d1'$q$);
 END IF;
 SELECT status INTO v_status FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000d1';
 SELECT superseded_at IS NOT NULL INTO v_marked FROM public.jobs WHERE id = '9a000000-0000-4000-8000-0000000000d2';
 SELECT accepted_at IS NOT NULL INTO v_doc FROM public.job_documents WHERE id = '9d000000-0000-4000-8000-0000000000d1';
 IF v_refuse THEN
  IF v_res NOT LIKE 'err:quote_option_unrecorded%' OR v_status <> 'quoted' OR v_marked OR v_doc THEN
   RAISE EXCEPTION 'combination %/%/fail=%: must be refused and roll back fully (got %, status %, marked %, document %)',
    p_supersede, p_path, p_fail, v_res, v_status, v_marked, v_doc;
  END IF;
 ELSE
  IF v_res <> 'ok' OR v_status <> 'accepted'
     OR v_marked IS DISTINCT FROM (p_supersede = 'true' AND NOT p_fail)
     OR v_doc IS DISTINCT FROM (p_path = 'rpc') THEN
   RAISE EXCEPTION 'combination %/%/fail=%: must commit as today (got %, status %, marked %, document %)',
    p_supersede, p_path, p_fail, v_res, v_status, v_marked, v_doc;
  END IF;
 END IF;
 RAISE EXCEPTION 'qa-case-ok';
END $$;
DO $$
DECLARE
 v_sup text;
 v_path text;
 v_fail boolean;
 v_res text;
BEGIN
 FOREACH v_sup IN ARRAY ARRAY['false', 'missing', 'unreadable', 'true'] LOOP
  FOREACH v_path IN ARRAY ARRAY['plain', 'rpc'] LOOP
   FOREACH v_fail IN ARRAY ARRAY[false, true] LOOP
    v_res := pg_temp.qa_try(format('SELECT pg_temp.qa_combo(%L, %L, %L)', v_sup, v_path, v_fail));
    IF v_res <> 'err:qa-case-ok' THEN
     RAISE EXCEPTION 'quote accept atomic contract: %', v_res;
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
END $$;
DROP FUNCTION public.qa_combo_fail();
DROP FUNCTION public.qa_combo_fail_review();
DROP FUNCTION public.qa_combo_raise();
-- C4 parity: with every switch off, the legacy status write has exactly the database effect
-- of the PATCH it replaces. Twin ungrouped jobs, one written each way, compared column by
-- column (id excepted); the same for a partial write (no accepted_at), a missing job (no row,
-- no error either way) and a refused value (an error either way).
UPDATE public.feature_flags SET enabled = false
 WHERE flag_name IN ('quote_option_supersede_v1', 'quote_accept_atomic_v1', 'quote_option_strict_record_v1');
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'quoted', 'patio'),
 ('9a000000-0000-4000-8000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'quoted', 'patio'),
 ('9a000000-0000-4000-8000-0000000000d3', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing'),
 ('9a000000-0000-4000-8000-0000000000d4', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing');
UPDATE public.jobs SET status = 'accepted', accepted_at = '2026-10-20 04:00:00+00'
 WHERE id = '9a000000-0000-4000-8000-0000000000d1';
SELECT public.quote_accept_legacy_set_status('9a000000-0000-4000-8000-0000000000d2', 'accepted', '2026-10-20 04:00:00+00');
UPDATE public.jobs SET status = 'partially_accepted' WHERE id = '9a000000-0000-4000-8000-0000000000d3';
SELECT public.quote_accept_legacy_set_status('9a000000-0000-4000-8000-0000000000d4', 'partially_accepted');
SELECT pg_temp.qa_assert(
 (SELECT to_jsonb(j) - 'id' FROM public.jobs j WHERE id = '9a000000-0000-4000-8000-0000000000d1')
   = (SELECT to_jsonb(j) - 'id' FROM public.jobs j WHERE id = '9a000000-0000-4000-8000-0000000000d2')
 AND (SELECT to_jsonb(j) - 'id' FROM public.jobs j WHERE id = '9a000000-0000-4000-8000-0000000000d3')
   = (SELECT to_jsonb(j) - 'id' FROM public.jobs j WHERE id = '9a000000-0000-4000-8000-0000000000d4')
 AND (SELECT count(*) FROM public.job_events WHERE job_id IN ('9a000000-0000-4000-8000-0000000000d1', '9a000000-0000-4000-8000-0000000000d3'))
   = (SELECT count(*) FROM public.job_events WHERE job_id IN ('9a000000-0000-4000-8000-0000000000d2', '9a000000-0000-4000-8000-0000000000d4')),
 'C4 parity: the legacy status write must leave exactly the row the PATCH leaves');
SELECT pg_temp.qa_assert(pg_temp.qa_try($q$SELECT public.quote_accept_legacy_set_status('9a000000-0000-4000-8000-00000000ffff', 'accepted', now())$q$) = 'ok',
 'C4 parity: a missing job is no row and no error, like the PATCH');
SELECT pg_temp.qa_assert(
 (pg_temp.qa_try($q$UPDATE public.jobs SET status = 'qa-not-a-status' WHERE id = '9a000000-0000-4000-8000-0000000000d1'$q$) LIKE 'err:%')
 = (pg_temp.qa_try($q$SELECT public.quote_accept_legacy_set_status('9a000000-0000-4000-8000-0000000000d2', 'qa-not-a-status')$q$) LIKE 'err:%'),
 'C4 parity: a value the PATCH refuses, the legacy write refuses too (and vice versa)');
SELECT pg_temp.qa_assert(NOT has_function_privilege('anon', 'public.quote_accept_legacy_set_status(uuid, text, timestamptz)', 'EXECUTE')
 AND NOT has_function_privilege('authenticated', 'public.quote_accept_legacy_set_status(uuid, text, timestamptz)', 'EXECUTE')
 AND has_function_privilege('service_role', 'public.quote_accept_legacy_set_status(uuid, text, timestamptz)', 'EXECUTE'),
 'the legacy status write is service role only');

-- Gap fixtures for Codex d98903c finding 4 (each listed; each clears when corrected).
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000e5', '00000000-0000-0000-0000-000000000001', 'partially_accepted', 'fencing'),
 ('9a000000-0000-4000-8000-0000000000e6', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio');
INSERT INTO public.job_contacts (id, job_id) VALUES
 ('9c000000-0000-4000-8000-0000000000e5', '9a000000-0000-4000-8000-0000000000e5');
-- A run document accepted with no run row (the legacy run upsert failed).
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, run_label, job_contact_id, accepted_at) VALUES
 ('9d000000-0000-4000-8000-0000000000e5', '9a000000-0000-4000-8000-0000000000e5', 'quote', true, 'A',
  '9c000000-0000-4000-8000-0000000000e5', '2026-10-20 05:00:00+00');
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_run_document_without_run_acceptance' AND ref = '9d000000-0000-4000-8000-0000000000e5'),
 'gap: an accepted run document with no run row must be listed');
INSERT INTO public.run_acceptances (job_id, job_contact_id, job_document_id, run_label, status, accepted_at) VALUES
 ('9a000000-0000-4000-8000-0000000000e5', '9c000000-0000-4000-8000-0000000000e5', '9d000000-0000-4000-8000-0000000000e5',
  'A', 'accepted', '2026-10-20 05:00:00+00');
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_run_document_without_run_acceptance' AND ref = '9d000000-0000-4000-8000-0000000000e5'),
 'gap: it clears once the run row exists');
-- The run row outlives its document (the document is later superseded).
UPDATE public.job_documents SET superseded_at = '2026-10-20 06:00:00+00' WHERE id = '9d000000-0000-4000-8000-0000000000e5';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'run_acceptance_document_not_live' AND job_id = '9a000000-0000-4000-8000-0000000000e5'),
 'gap: an accepted run row whose document is superseded must be listed');
UPDATE public.job_documents SET superseded_at = NULL, declined_at = '2026-10-20 06:00:00+00'
 WHERE id = '9d000000-0000-4000-8000-0000000000e5';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'run_acceptance_document_not_live' AND job_id = '9a000000-0000-4000-8000-0000000000e5'),
 'gap: an accepted run row whose document is declined must be listed');
UPDATE public.run_acceptances SET status = 'declined' WHERE job_document_id = '9d000000-0000-4000-8000-0000000000e5';
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'run_acceptance_document_not_live' AND job_id = '9a000000-0000-4000-8000-0000000000e5'),
 'gap: it clears once the run row is declined too');
-- A whole quote accepted while an older option for the same recipient stays open (the legacy
-- sibling supersession failed); an option created after the acceptance is not listed.
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, created_at, accepted_at) VALUES
 ('9d000000-0000-4000-8000-0000000000e6', '9a000000-0000-4000-8000-0000000000e6', 'quote', true,
  '2026-10-19 00:00:00+00', '2026-10-20 07:00:00+00'),
 ('9d000000-0000-4000-8000-0000000000e7', '9a000000-0000-4000-8000-0000000000e6', 'quote', true,
  '2026-10-19 00:00:00+00', NULL),
 ('9d000000-0000-4000-8000-0000000000e8', '9a000000-0000-4000-8000-0000000000e6', 'quote', true,
  '2026-10-21 00:00:00+00', NULL);
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_quote_with_open_sibling_document' AND job_id = '9a000000-0000-4000-8000-0000000000e6'
     AND ref = '9d000000-0000-4000-8000-0000000000e6>9d000000-0000-4000-8000-0000000000e7'),
 'gap: an older open option beside an accepted whole quote must be listed, a later one not');
UPDATE public.job_documents SET superseded_at = '2026-10-20 07:00:00+00' WHERE id = '9d000000-0000-4000-8000-0000000000e7';
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'accepted_quote_with_open_sibling_document' AND job_id = '9a000000-0000-4000-8000-0000000000e6'),
 'gap: it clears once the sibling is superseded');
-- A decline legitimately leaves a job partially accepted: not listed.
INSERT INTO public.jobs (id, org_id, status, type) VALUES
 ('9a000000-0000-4000-8000-0000000000e9', '00000000-0000-0000-0000-000000000001', 'partially_accepted', 'patio');
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, accepted_at, declined_at) VALUES
 ('9d000000-0000-4000-8000-0000000000e9', '9a000000-0000-4000-8000-0000000000e9', 'quote', true, '2026-10-20 01:00:00+00', NULL),
 ('9d000000-0000-4000-8000-0000000000ea', '9a000000-0000-4000-8000-0000000000e9', 'quote', true, '2026-10-20 01:00:00+00', NULL),
 ('9d000000-0000-4000-8000-0000000000eb', '9a000000-0000-4000-8000-0000000000e9', 'quote', true, NULL, '2026-10-20 02:00:00+00');
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'partially_accepted_all_documents_accepted' AND job_id = '9a000000-0000-4000-8000-0000000000e9'),
 'gap: a job partially accepted because a party declined must not be listed');
-- A decline on a superseded (historical) document does not hide a current inconsistency.
UPDATE public.job_documents SET superseded_at = '2026-10-20 03:00:00+00' WHERE id = '9d000000-0000-4000-8000-0000000000eb';
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'partially_accepted_all_documents_accepted' AND job_id = '9a000000-0000-4000-8000-0000000000e9'),
 'gap: a superseded historical decline must not hide a partial job whose live documents are all accepted');
-- An unaccepted live document (an unsent alternative, say) keeps the job out: a known limit
-- of this document heuristic, recorded here so a change to it is deliberate.
INSERT INTO public.job_documents (id, job_id, type, sent_to_client) VALUES
 ('9d000000-0000-4000-8000-0000000000ec', '9a000000-0000-4000-8000-0000000000e9', 'quote', false);
SELECT pg_temp.qa_assert(NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'partially_accepted_all_documents_accepted' AND job_id = '9a000000-0000-4000-8000-0000000000e9'),
 'gap (known limit): any live unaccepted document keeps the job out of the heuristic');
-- A run row with no document pointer is listed as not live.
INSERT INTO public.run_acceptances (job_id, job_contact_id, job_document_id, run_label, status, accepted_at) VALUES
 ('9a000000-0000-4000-8000-0000000000e5', '9c000000-0000-4000-8000-0000000000e5', NULL, 'B', 'accepted', '2026-10-20 05:00:00+00');
SELECT pg_temp.qa_assert((SELECT count(*) = 1 FROM public.quote_acceptance_gaps()
   WHERE kind = 'run_acceptance_document_not_live' AND ref = '9a000000-0000-4000-8000-0000000000e5/9c000000-0000-4000-8000-0000000000e5/B'),
 'gap: an accepted run row with no document must be listed');
-- New condition kinds cannot be resolved.
SELECT pg_temp.qa_assert(pg_temp.qa_try($q$INSERT INTO public.quote_acceptance_gap_resolutions (kind, ref, resolved_by)
  VALUES ('run_acceptance_document_not_live', 'x', '00000000-0000-0000-0000-000000000001')$q$) LIKE 'err:%',
 'gap: a new condition kind must not be resolvable');
ROLLBACK;
