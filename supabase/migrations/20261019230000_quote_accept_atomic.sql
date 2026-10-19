-- SQ-23 remedy, slice 1 (branch sq23/acceptance-atomic): a public quote
-- acceptance commits its accepted document, its sibling supersession or run
-- acceptance, its job status, its acceptance event and its attempt row in
-- ONE transaction. Design: docs/sq23/acceptance-atomic-design.md (revision 8).
-- Requirement: CIO R1 to R5 (secureworks-projects ctx/cio-20261019 ef20d6f).
--
-- Nothing here changes behaviour while its switches are off:
--   * quote_accept_atomic_v1 (seeded off): send-quote takes the atomic path
--     only when this reads true. Off, missing or unreadable selects today's
--     separate writes.
--   * quote_option_strict_record_v1 (seeded off): read only by the SQ-23
--     supersede trigger at its final "nothing recorded" site. On, every writer
--     whose supersede run records nothing is refused. That is an owning-review
--     decision (it could block staff status changes), not settled here.
--
-- Snapshot protocol. The party rules (which status an acceptance gives the
-- job) stay in send-quote. send-quote decides from quote_acceptance_snapshot,
-- which returns the decision inputs and their fingerprint from ONE statement
-- (one database snapshot), so the inputs and the fingerprint describe the
-- same state. accept_quote_document_atomic locks the job, its quote documents,
-- run acceptances and run line items, recomputes the fingerprint and refuses
-- with 'stale' if it differs. Equal means the locked state is the state the
-- decision was made from. Rows inserted by other writers after the lock are
-- ordered after this acceptance (stated limit).

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'quote_accept_atomic_v1', false,
  'SQ-23 remedy: when on, send-quote accepts a quote through accept_quote_document_atomic (document, supersession or run acceptance, job status, acceptance event and attempt row in one transaction). Off: today''s separate writes. Turn on only on the owner''s word after the owning review.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_accept_atomic_v1');

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'quote_option_strict_record_v1', false,
  'SQ-23: when on, ANY status change whose quote-option supersede run can record nothing (run row, work and review event all failed) is refused and rolls back. Off: the status change stands with a warning (today). Owning-review decision: it can block staff status changes. Never on unless quote_accept_atomic_v1 is on and reads reliably.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_option_strict_record_v1');

-- One row per document accepted through the atomic path, written in the
-- acceptance transaction. A document is accepted at most once, so the
-- document is the acceptance's identity; request_id names the one request
-- that committed it. Its follow-up work (invoice, GHL, messages) belongs to
-- that request only and runs at most once; a replay never runs it.
-- handler_finished_at means the handler reached its customer response. It
-- does NOT mean the follow-up work succeeded: those steps keep today's
-- best-effort handling. Until slice 2 (a per-step ledger), their outcomes are
-- not recorded here.
CREATE TABLE public.quote_acceptance_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE,
  job_id uuid NOT NULL,
  run_label text,
  job_status text NOT NULL,
  previous_status text,
  accepted_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  handler_finished_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid,
  CONSTRAINT quote_acceptance_attempts_status CHECK (job_status IN ('accepted', 'partially_accepted', 'quoted'))
);
ALTER TABLE public.quote_acceptance_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quote_acceptance_attempts DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_acceptance_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE (resolved_at, resolved_by) ON public.quote_acceptance_attempts TO service_role;
CREATE INDEX idx_quote_acceptance_attempts_open
  ON public.quote_acceptance_attempts (committed_at) WHERE handler_finished_at IS NULL AND resolved_at IS NULL;
COMMENT ON TABLE public.quote_acceptance_attempts IS
  'SQ-23 remedy: one row per quote document accepted through accept_quote_document_atomic, committed with the acceptance. handler_finished_at = the handler reached its response, not that follow-up work succeeded.';

-- A person marks a listed gap handled. One row per (kind, ref) as
-- quote_acceptance_gaps names them; it suppresses only that one obligation.
CREATE TABLE public.quote_acceptance_gap_resolutions (
  kind text NOT NULL,
  ref text NOT NULL,
  resolved_by uuid NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  note text,
  PRIMARY KEY (kind, ref)
);
ALTER TABLE public.quote_acceptance_gap_resolutions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quote_acceptance_gap_resolutions DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_acceptance_gap_resolutions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.quote_acceptance_gap_resolutions TO service_role;

-- Everything the party rules and the acceptance guards read, for one job, as
-- one value. Structured and NULL-preserving (jsonb with explicit nulls);
-- timestamps as epoch numbers so it does not depend on TimeZone or DateStyle.
CREATE OR REPLACE FUNCTION public.quote_acceptance_fingerprint(p_job_id uuid)
RETURNS text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT md5(jsonb_build_object(
    'documents', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'job_contact_id', d.job_contact_id, 'run_label', d.run_label,
        'snapshot_run_label', d.data_snapshot_json -> 'run' -> 'run_label',
        'sent_to_client', d.sent_to_client, 'share_token', d.share_token, 'version', d.version,
        'sent_at', extract(epoch FROM d.sent_at), 'send_claimed_at', extract(epoch FROM d.send_claimed_at),
        'accepted_at', extract(epoch FROM d.accepted_at), 'declined_at', extract(epoch FROM d.declined_at),
        'superseded_at', extract(epoch FROM d.superseded_at), 'created_at', extract(epoch FROM d.created_at))
        ORDER BY d.id)
       FROM public.job_documents d WHERE d.job_id = p_job_id AND d.type = 'quote'), '[]'::jsonb),
    'acceptances', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'job_document_id', a.job_document_id, 'job_contact_id', a.job_contact_id,
        'run_label', a.run_label, 'status', a.status, 'accepted_at', extract(epoch FROM a.accepted_at),
        'declined_at', extract(epoch FROM a.declined_at))
        ORDER BY a.id)
       FROM public.run_acceptances a WHERE a.job_id = p_job_id), '[]'::jsonb),
    'run_line_items', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'run_label', r.run_label, 'job_contact_id', r.job_contact_id)
        ORDER BY r.id)
       FROM public.run_line_items r WHERE r.job_id = p_job_id), '[]'::jsonb)
  )::text)
$$;
REVOKE ALL ON FUNCTION public.quote_acceptance_fingerprint(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_fingerprint(uuid) TO service_role;

-- The decision inputs and their fingerprint from one statement. Documents
-- carry the columns send-quote's party rules read (QUOTE_PARTY_DOCUMENT_COLUMNS)
-- plus share_token; run line items are in id order.
CREATE OR REPLACE FUNCTION public.quote_acceptance_snapshot(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'fingerprint', public.quote_acceptance_fingerprint(p_job_id),
    'documents', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'job_contact_id', d.job_contact_id, 'run_label', d.run_label,
        'sent_to_client', d.sent_to_client, 'sent_at', d.sent_at, 'send_claimed_at', d.send_claimed_at,
        'accepted_at', d.accepted_at, 'declined_at', d.declined_at, 'superseded_at', d.superseded_at,
        'created_at', d.created_at, 'version', d.version, 'data_snapshot_json', d.data_snapshot_json,
        'share_token', d.share_token)
        ORDER BY d.id)
       FROM public.job_documents d WHERE d.job_id = p_job_id AND d.type = 'quote'), '[]'::jsonb),
    'acceptances', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'job_document_id', a.job_document_id, 'job_contact_id', a.job_contact_id,
        'run_label', a.run_label, 'status', a.status, 'accepted_at', a.accepted_at)
        ORDER BY a.id)
       FROM public.run_acceptances a WHERE a.job_id = p_job_id), '[]'::jsonb),
    'run_line_items', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'run_label', r.run_label, 'job_contact_id', r.job_contact_id)
        ORDER BY r.id)
       FROM public.run_line_items r WHERE r.job_id = p_job_id), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.quote_acceptance_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_snapshot(uuid) TO service_role;

-- The atomic acceptance. Returns jsonb {outcome, ...}:
--   accepted  committed now, by p_request_id.
--   replay    this document already has an attempt row: its stored result
--             (including the request that committed it); nothing written.
--   stale     the locked state is not the snapshot the caller decided from.
--   refused   the document cannot be accepted (reason): nothing written.
-- Any error (including the supersede trigger's quote_option_unrecorded raise)
-- rolls the whole call back. The database checks the share token, the
-- document's state, the status vocabulary and that a whole quote carries its
-- acceptance event; it trusts the caller's party rules and run label, which
-- are bound to the fingerprinted snapshot (trusted service-role caller).
CREATE OR REPLACE FUNCTION public.accept_quote_document_atomic(
  p_document_id uuid,
  p_share_token text,
  p_request_id uuid,
  p_accepted_at timestamptz,
  p_job_status text,
  p_fingerprint text,
  p_run_label text,
  p_accept_event jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_run text;
  v_contact uuid;
  v_doc public.job_documents%ROWTYPE;
  v_attempt public.quote_acceptance_attempts%ROWTYPE;
  v_prev_status text;
  v_prev_marker text;
  v_rows integer;
BEGIN
  IF p_document_id IS NULL OR p_request_id IS NULL OR p_accepted_at IS NULL OR p_share_token IS NULL THEN
    RAISE EXCEPTION 'quote_accept_bad_input' USING ERRCODE = '22023';
  END IF;
  SELECT d.job_id INTO v_job FROM public.job_documents d WHERE d.id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_accept_document_missing' USING ERRCODE = 'P0002';
  END IF;
  IF v_job IS NULL THEN
    -- Jobless documents keep today's path in send-quote.
    RAISE EXCEPTION 'quote_accept_jobless' USING ERRCODE = '22023';
  END IF;
  -- Serialize by job, then lock everything the fingerprint covers, each in
  -- id order.
  PERFORM 1 FROM public.jobs j WHERE j.id = v_job FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_accept_job_missing' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.job_documents d WHERE d.job_id = v_job AND d.type = 'quote' ORDER BY d.id FOR UPDATE;
  PERFORM 1 FROM public.run_acceptances a WHERE a.job_id = v_job ORDER BY a.id FOR UPDATE;
  PERFORM 1 FROM public.run_line_items r WHERE r.job_id = v_job ORDER BY r.id FOR UPDATE;
  SELECT * INTO v_doc FROM public.job_documents d WHERE d.id = p_document_id;
  IF v_doc.job_id IS DISTINCT FROM v_job THEN
    RETURN jsonb_build_object('outcome', 'stale', 'reason', 'document_moved');
  END IF;

  -- Replay before any eligibility check.
  SELECT * INTO v_attempt FROM public.quote_acceptance_attempts a WHERE a.document_id = p_document_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'replay', 'attempt_id', v_attempt.id,
      'request_id', v_attempt.request_id, 'job_id', v_attempt.job_id, 'job_status', v_attempt.job_status,
      'previous_status', v_attempt.previous_status, 'accepted_at', v_attempt.accepted_at);
  END IF;

  IF v_doc.share_token IS DISTINCT FROM p_share_token THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_a_sent_quote');
  END IF;
  IF public.quote_acceptance_fingerprint(v_job) IS DISTINCT FROM p_fingerprint THEN
    RETURN jsonb_build_object('outcome', 'stale', 'reason', 'snapshot_changed');
  END IF;
  IF v_doc.type IS DISTINCT FROM 'quote' OR v_doc.sent_to_client IS NOT TRUE THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_a_sent_quote');
  END IF;
  IF v_doc.accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'already_accepted');
  END IF;
  IF v_doc.declined_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'already_declined');
  END IF;
  IF v_doc.superseded_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'superseded');
  END IF;

  -- The caller's quoteDocumentRunLabel(doc), computed from the fingerprinted
  -- snapshot (that rule stays in send-quote). NULL selects the whole-quote
  -- path, as today.
  v_run := p_run_label;
  v_contact := v_doc.job_contact_id;
  IF v_run IS NULL THEN
    IF p_job_status IS NULL OR p_job_status NOT IN ('accepted', 'partially_accepted') THEN
      RAISE EXCEPTION 'quote_accept_bad_status: %', p_job_status USING ERRCODE = '22023';
    END IF;
    IF p_accept_event IS NULL THEN
      RAISE EXCEPTION 'quote_accept_event_missing' USING ERRCODE = '22023';
    END IF;
    -- The same recipient's other whole-quote option already accepted.
    IF EXISTS (SELECT 1 FROM public.job_documents d
                WHERE d.job_id = v_job AND d.type = 'quote' AND d.run_label IS NULL
                  AND d.id <> p_document_id AND d.accepted_at IS NOT NULL AND d.superseded_at IS NULL
                  AND d.job_contact_id IS NOT DISTINCT FROM v_contact) THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'sibling_accepted');
    END IF;
  ELSE
    IF p_job_status IS NULL OR p_job_status NOT IN ('accepted', 'partially_accepted', 'quoted') THEN
      RAISE EXCEPTION 'quote_accept_bad_status: %', p_job_status USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.job_documents SET accepted_at = p_accepted_at WHERE id = p_document_id;

  IF v_run IS NULL THEN
    -- Today's sibling supersession (send-quote ~1729), now in this transaction.
    UPDATE public.job_documents d SET superseded_at = now()
     WHERE d.job_id = v_job AND d.type = 'quote' AND d.run_label IS NULL
       AND d.superseded_at IS NULL AND d.id <> p_document_id
       AND d.job_contact_id IS NOT DISTINCT FROM v_contact;
  ELSIF v_contact IS NOT NULL THEN
    -- Today's run acceptance upsert (send-quote ~1838), now in this transaction.
    -- With no contact, today's upsert fails on run_acceptances.job_contact_id
    -- NOT NULL, its error ignored, and the acceptance goes on: so no row here
    -- either, and the attempt records run_label for review.
    INSERT INTO public.run_acceptances (job_id, job_contact_id, job_document_id, run_label, status, accepted_at)
    VALUES (v_job, v_contact, p_document_id, v_run, 'accepted', p_accepted_at)
    ON CONFLICT (job_id, job_contact_id, run_label) DO UPDATE
      SET job_document_id = EXCLUDED.job_document_id, status = 'accepted', accepted_at = EXCLUDED.accepted_at;
  END IF;

  -- The job status, written as today (overwriting whatever it holds), with the
  -- transaction-local marker set only around this one statement.
  SELECT j.status INTO v_prev_status FROM public.jobs j WHERE j.id = v_job;
  v_prev_marker := current_setting('sw.quote_accept_atomic', true);
  PERFORM set_config('sw.quote_accept_atomic', 'on', true);
  UPDATE public.jobs
     SET status = p_job_status,
         accepted_at = CASE WHEN p_job_status = 'accepted' THEN p_accepted_at ELSE accepted_at END
   WHERE id = v_job;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('sw.quote_accept_atomic', coalesce(v_prev_marker, ''), true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'quote_accept_job_update_rows: %', v_rows;
  END IF;

  IF coalesce(v_prev_status, 'draft') NOT IN ('draft', 'quoted', 'partially_accepted', 'accepted') THEN
    -- Staff had already moved the job on. Today's overwrite is kept; this
    -- records it for a person (listed by quote_acceptance_gaps).
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (v_job, 'quote_acceptance_review_needed',
            jsonb_build_object('reason', 'accepted_after_status_moved', 'document_id', p_document_id,
                               'previous_status', v_prev_status, 'new_status', p_job_status));
  END IF;

  IF p_accept_event IS NOT NULL THEN
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (v_job, 'quote_accepted', p_accept_event);
  END IF;

  INSERT INTO public.quote_acceptance_attempts (document_id, request_id, job_id, run_label, job_status,
                                                previous_status, accepted_at)
  VALUES (p_document_id, p_request_id, v_job, v_run, p_job_status, v_prev_status, p_accepted_at)
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('outcome', 'accepted', 'attempt_id', v_attempt.id, 'request_id', p_request_id,
    'job_id', v_job, 'job_status', p_job_status, 'previous_status', v_prev_status, 'accepted_at', p_accepted_at);
END $$;
REVOKE ALL ON FUNCTION public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, jsonb) TO service_role;

-- The committing request reached its customer response. Only that request
-- (request_id), only once. Says nothing about follow-up success.
CREATE OR REPLACE FUNCTION public.quote_acceptance_handler_finished(p_document_id uuid, p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_rows integer;
BEGIN
  UPDATE public.quote_acceptance_attempts SET handler_finished_at = now()
   WHERE document_id = p_document_id AND request_id = p_request_id AND handler_finished_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION public.quote_acceptance_handler_finished(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_handler_finished(uuid, uuid) TO service_role;

-- R3: read-only list of what needs a person. Ids, codes and instants only.
-- A row disappears only when its own (kind, ref) is resolved (or, for runs
-- and attempts, their resolved_at is set); nothing else suppresses it.
--   settle_run_unsettled     a supersede run whose work failed
--   review_needed            every quote_option_review_needed and
--                            quote_acceptance_review_needed event (ref: the
--                            event id), including review-only failures and
--                            staff-advanced acceptances
--   won_with_open_sibling    a grouped job in a won status beside an open,
--                            unmarked option (ref: job@acceptance instant).
--                            Listed only while quote_option_supersede_v1 reads
--                            true: with marking off, open siblings are by design
--   more_than_one_won        a group with two or more won, unmarked options
--                            (ref: group@won ids)
--   acceptance_handler_unfinished  committed, the handler never reached its
--                            response (follow-up work state unknown)
-- p_grace: how old an attempt must be before it is listed.
CREATE OR REPLACE FUNCTION public.quote_acceptance_gaps(p_grace interval DEFAULT interval '15 minutes')
RETURNS TABLE (kind text, job_id uuid, ref text, at timestamptz)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_supersede_on boolean := false;
BEGIN
  BEGIN
    v_supersede_on := coalesce((SELECT f.enabled FROM public.feature_flags f
                                 WHERE f.flag_name = 'quote_option_supersede_v1'), false) IS TRUE;
  EXCEPTION WHEN OTHERS THEN
    v_supersede_on := false;
  END;
  RETURN QUERY
  SELECT g.kind, g.job_id, g.ref, g.at FROM (
    SELECT 'settle_run_unsettled'::text AS kind, r.job_id, r.id::text AS ref, r.created_at AS at
      FROM public.quote_option_settle_runs r
     WHERE r.settled_at IS NULL AND r.resolved_at IS NULL
    UNION ALL
    SELECT 'review_needed', e.job_id, e.id::text, e.created_at
      FROM public.job_events e
     WHERE e.event_type IN ('quote_option_review_needed', 'quote_acceptance_review_needed')
    UNION ALL
    SELECT 'won_with_open_sibling', w.id,
           w.id::text || '@' || coalesce(extract(epoch FROM w.accepted_at)::text, 'none'), w.accepted_at
      FROM public.jobs w
     WHERE v_supersede_on
       AND w.quote_option_group_id IS NOT NULL
       AND public.fence_quote_option_status_won(w.status)
       AND w.superseded_at IS NULL
       AND EXISTS (SELECT 1 FROM public.jobs s
                    WHERE s.quote_option_group_id = w.quote_option_group_id AND s.id <> w.id
                      AND coalesce(s.status, 'draft') IN ('draft', 'quoted') AND s.superseded_at IS NULL)
    UNION ALL
    SELECT 'more_than_one_won', NULL::uuid,
           m.quote_option_group_id::text || '@' || string_agg(m.id::text, ',' ORDER BY m.id), max(m.accepted_at)
      FROM public.jobs m
     WHERE m.quote_option_group_id IS NOT NULL
       AND public.fence_quote_option_status_won(m.status) AND m.superseded_at IS NULL
     GROUP BY m.quote_option_group_id
    HAVING count(*) > 1
    UNION ALL
    SELECT 'acceptance_handler_unfinished', a.job_id, a.document_id::text, a.committed_at
      FROM public.quote_acceptance_attempts a
     WHERE a.handler_finished_at IS NULL AND a.resolved_at IS NULL AND a.committed_at < now() - p_grace
  ) g
  WHERE NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gap_resolutions x WHERE x.kind = g.kind AND x.ref = g.ref);
END $$;
REVOKE ALL ON FUNCTION public.quote_acceptance_gaps(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_gaps(interval) TO service_role;
