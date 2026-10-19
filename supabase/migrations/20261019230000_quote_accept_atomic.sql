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
  'SQ-23: when on, ANY status change whose quote-option supersede run can record nothing (run row, work and review event all failed) is refused and rolls back. Off: the status change stands with a warning (today). Owning-review decision: it can block staff status changes. No effect unless quote_accept_atomic_v1 also reads true (enforced in the trigger); unreadable is off.'
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
  handler_issues text,
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
  'SQ-23 remedy: one row per quote document accepted through accept_quote_document_atomic, committed with the acceptance. handler_finished_at = the handler reached its response; handler_issues = follow-up writes it reported as failed.';

-- A person marks a listed gap handled. One row per (kind, ref) as
-- quote_acceptance_gaps names them; it suppresses only that one obligation.
-- Only event- and attempt-based kinds can be resolved; the condition kinds
-- clear when the data changes.
CREATE TABLE public.quote_acceptance_gap_resolutions (
  kind text NOT NULL CHECK (kind IN ('review_needed', 'settle_run_unsettled', 'acceptance_handler_unfinished',
                                     'acceptance_follow_up_issue')),
  ref text NOT NULL,
  resolved_by uuid NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  note text,
  PRIMARY KEY (kind, ref)
);
COMMENT ON TABLE public.quote_acceptance_gap_resolutions IS
  'SQ-23 remedy: a person''s resolution of one listed acceptance gap (kind, ref).';
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
-- plus share_token; run line items are in id order. run_neighbour is today's
-- own choice (send-quote's LIMIT 1, no order) for p_run_label, taken in the
-- same statement, so it belongs to the same snapshot as the fingerprint.
CREATE OR REPLACE FUNCTION public.quote_acceptance_snapshot(p_job_id uuid, p_run_label text)
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
       FROM public.run_line_items r WHERE r.job_id = p_job_id), '[]'::jsonb),
    'run_neighbour', (SELECT r.job_contact_id FROM public.run_line_items r
                       WHERE p_run_label IS NOT NULL AND r.job_id = p_job_id AND r.run_label = p_run_label LIMIT 1))
$$;
REVOKE ALL ON FUNCTION public.quote_acceptance_snapshot(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_snapshot(uuid, text) TO service_role;

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
  p_run_neighbour uuid,
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
  -- Every acceptance, whole quote or run, carries its acceptance event, written
  -- in this transaction (CIO condition 1).
  IF p_accept_event IS NULL THEN
    RAISE EXCEPTION 'quote_accept_event_missing' USING ERRCODE = '22023';
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
    -- The neighbour the caller decided with must be a value the legacy
    -- selection (LIMIT 1, no order) could return in the locked
    -- (fingerprint-equal) state: the contact of one of the run's line items,
    -- including NULL when a NULL-contact item exists, or NULL when the run
    -- has no line items at all.
    IF p_run_neighbour IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.run_line_items r WHERE r.job_id = v_job AND r.run_label = v_run)
         AND NOT EXISTS (SELECT 1 FROM public.run_line_items r
                          WHERE r.job_id = v_job AND r.run_label = v_run AND r.job_contact_id IS NULL) THEN
        RETURN jsonb_build_object('outcome', 'stale', 'reason', 'run_neighbour_unbound');
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.run_line_items r
                       WHERE r.job_id = v_job AND r.run_label = v_run AND r.job_contact_id = p_run_neighbour) THEN
      RETURN jsonb_build_object('outcome', 'stale', 'reason', 'run_neighbour_unbound');
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

  -- The acceptance event, in this transaction, stamped with the acceptance
  -- instant (detail_json.accepted_at) whatever the caller sent: job_events
  -- has no occurred_at, and its created_at is commit time.
  INSERT INTO public.job_events (job_id, event_type, detail_json)
  VALUES (v_job, CASE WHEN v_run IS NULL THEN 'quote_accepted' ELSE 'quote_run_accepted' END,
          p_accept_event || jsonb_build_object('document_id', p_document_id, 'accepted_at', p_accepted_at,
                                               'new_status', p_job_status)
            || CASE WHEN v_run IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('run_label', v_run) END);

  INSERT INTO public.quote_acceptance_attempts (document_id, request_id, job_id, run_label, job_status,
                                                previous_status, accepted_at)
  VALUES (p_document_id, p_request_id, v_job, v_run, p_job_status, v_prev_status, p_accepted_at)
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('outcome', 'accepted', 'attempt_id', v_attempt.id, 'request_id', p_request_id,
    'job_id', v_job, 'job_status', p_job_status, 'previous_status', v_prev_status, 'accepted_at', p_accepted_at);
END $$;
REVOKE ALL ON FUNCTION public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, uuid, jsonb) TO service_role;

-- The committing request reached its customer response. Only that request
-- (request_id), only once. Says nothing about follow-up success.
CREATE OR REPLACE FUNCTION public.quote_acceptance_handler_finished(p_document_id uuid, p_request_id uuid,
                                                                    p_issues text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_rows integer;
BEGIN
  UPDATE public.quote_acceptance_attempts
     SET handler_finished_at = now(), handler_issues = nullif(left(coalesce(p_issues, ''), 500), '')
   WHERE document_id = p_document_id AND request_id = p_request_id AND handler_finished_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION public.quote_acceptance_handler_finished(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_handler_finished(uuid, uuid, text) TO service_role;

-- R3: read-only list of what needs a person. Ids, codes and instants only.
-- Event and attempt rows disappear only when their own (kind, ref) is
-- resolved (or, for runs and attempts, their resolved_at is set). The
-- condition kinds (won_with_open_sibling, more_than_one_won,
-- won_without_acceptance_event, won_while_superseded,
-- accepted_document_job_not_won, supersede_switch_unreadable) cannot be resolved:
-- they are listed while the condition holds.
--   settle_run_unsettled     a supersede run whose work failed
--   review_needed            every quote_option_review_needed and
--                            quote_acceptance_review_needed event (ref: the
--                            event id), including review-only failures and
--                            staff-advanced acceptances
--   won_with_open_sibling    a grouped job in a won status beside an open,
--                            unmarked option, one row per sibling (ref:
--                            winner>sibling); condition-based.
--                            Listed only while quote_option_supersede_v1 reads
--                            true: with marking off, open siblings are by design
--   more_than_one_won        a group with two or more won options (marked or not)
--                            (ref: group@won ids); condition-based
--   won_without_acceptance_event   won job with no acceptance event (any
--                            writer); condition-based; bounded by p_since
--   accepted_document_job_not_won  live accepted quote document on a job
--                            neither won nor partially accepted; condition-based
--   acceptance_follow_up_issue  the committing request reached its response but
--                            reported a failed follow-up write (ref: document)
--   won_while_superseded     won job still marked superseded; condition-based
--   accepted_run_document_without_run_acceptance  accepted run document (with a
--                            contact) with no accepted run row; condition-based
--   run_acceptance_document_not_live  accepted run row whose document is
--                            superseded, declined or not accepted; condition-based
--   partially_accepted_all_documents_accepted  document heuristic: job
--                            partially accepted although every live quote
--                            document (two or more) is accepted and none is
--                            declined; condition-based
--   accepted_quote_with_open_sibling_document  accepted whole quote beside an
--                            older open option for the same recipient
--                            (ref: accepted>sibling); condition-based
--   supersede_switch_unreadable  the reader could not read the supersede switch,
--                            so open-sibling rows were not computed (CIO reader
--                            rule: never read an empty answer as clean)
--   acceptance_handler_unfinished  committed, the handler never reached its
--                            response (follow-up work state unknown)
-- p_grace: how old an attempt must be before it is listed.
CREATE OR REPLACE FUNCTION public.quote_acceptance_gaps(p_grace interval DEFAULT interval '15 minutes',
                                                        p_since timestamptz DEFAULT NULL)
RETURNS TABLE (kind text, job_id uuid, ref text, at timestamptz)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_supersede_on boolean := false;
  v_unreadable boolean := false;
BEGIN
  BEGIN
    v_supersede_on := coalesce((SELECT f.enabled FROM public.feature_flags f
                                 WHERE f.flag_name = 'quote_option_supersede_v1'), false) IS TRUE;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    -- Unreadable is off, as in the trigger: the reader still lists everything
    -- else, plus one row saying so, so an empty answer is never read as clean.
    v_supersede_on := false;
    v_unreadable := true;
  END;
  RETURN QUERY
  SELECT g.kind, g.job_id, g.ref, g.at FROM (
    SELECT 'supersede_switch_unreadable'::text AS kind, NULL::uuid AS job_id, 'quote_option_supersede_v1'::text AS ref,
           now() AS at
     WHERE v_unreadable
    UNION ALL
    SELECT 'settle_run_unsettled'::text AS kind, r.job_id, r.id::text AS ref, r.created_at AS at
      FROM public.quote_option_settle_runs r
     WHERE r.settled_at IS NULL AND r.resolved_at IS NULL
    UNION ALL
    SELECT 'review_needed', e.job_id, e.id::text, e.created_at
      FROM public.job_events e
     WHERE e.event_type IN ('quote_option_review_needed', 'quote_acceptance_review_needed')
    UNION ALL
    -- One row per (winner, open sibling), ref winner>sibling. Condition-based:
    -- listed for as long as the condition holds, and never suppressed by a
    -- resolution (a row version is not a durable occurrence id). A person
    -- clears it by changing the data through the normal paths.
    SELECT 'won_with_open_sibling', w.id, w.id::text || '>' || s.id::text, w.accepted_at
      FROM public.jobs w
      JOIN public.jobs s ON s.quote_option_group_id = w.quote_option_group_id AND s.id <> w.id
     WHERE v_supersede_on
       AND w.quote_option_group_id IS NOT NULL
       AND public.fence_quote_option_status_won(w.status)
       AND w.superseded_at IS NULL
       AND coalesce(s.status, 'draft') IN ('draft', 'quoted') AND s.superseded_at IS NULL
    UNION ALL
    SELECT 'more_than_one_won', NULL::uuid,
           m.quote_option_group_id::text || '@' || string_agg(m.id::text, ',' ORDER BY m.id),
           max(m.accepted_at)
      FROM public.jobs m
     WHERE m.quote_option_group_id IS NOT NULL
       AND public.fence_quote_option_status_won(m.status)
     GROUP BY m.quote_option_group_id
    HAVING count(*) > 1
    UNION ALL
    -- A job in a won status whose acceptance has no event of its own: no
    -- quote_accepted or quote_run_accepted event carries the job's own
    -- acceptance instant (the atomic path writes both from one value, so they
    -- are equal exactly). Any older event does not count: an event's mere
    -- existence is not chronology. So it lists any writer that moved the job
    -- to won without its acceptance (CIO condition 2), every legacy
    -- acceptance (held uncertain, as Context's rule asks), and jobs with no
    -- accepted_at. Known limit: a later re-win that leaves accepted_at
    -- unchanged looks, in the database, like the original acceptance.
    -- Condition-based. p_since bounds the history by accepted_at.
    SELECT 'won_without_acceptance_event', j.id, j.id::text, j.accepted_at
      FROM public.jobs j
     WHERE public.fence_quote_option_status_won(j.status)
       AND (p_since IS NULL OR j.accepted_at IS NULL OR j.accepted_at >= p_since)
       AND NOT EXISTS (SELECT 1 FROM public.job_events e
                        WHERE e.job_id = j.id AND e.event_type IN ('quote_accepted', 'quote_run_accepted')
                          AND j.accepted_at IS NOT NULL
                          AND (e.detail_json->>'accepted_at')::timestamptz = j.accepted_at)
    UNION ALL
    -- A live accepted quote document on a job that is neither won nor
    -- partially accepted: the document committed and the status did not (the
    -- strict-on, atomic-off inverse gap; any split write), or the job was
    -- moved back or lost afterwards. ref: the document. Condition-based: the
    -- same document's job can become inconsistent again after a resolution,
    -- so it cannot be resolved; it clears when the job is won again or the
    -- document is declined or superseded through the normal paths.
    SELECT 'accepted_document_job_not_won', d.job_id, d.id::text, d.accepted_at
      FROM public.job_documents d
      JOIN public.jobs j ON j.id = d.job_id
     WHERE d.type = 'quote' AND d.accepted_at IS NOT NULL AND d.superseded_at IS NULL AND d.declined_at IS NULL
       AND NOT public.fence_quote_option_status_won(j.status)
       AND coalesce(j.status, '') <> 'partially_accepted'
       AND (p_since IS NULL OR d.accepted_at >= p_since)
    UNION ALL
    -- A document heuristic, not the handler's party decision: a job left
    -- partially accepted although every live quote document on it (not
    -- superseded, not declined; sent or not) is accepted, there are at least
    -- two, and no live document or current run row on it is declined (a
    -- decline legitimately leaves a job partially accepted). It shows the
    -- checker's c4c and c4d result at d98903c (the final party's status did
    -- not land). Known limits (design section 3): an unaccepted live document
    -- (an unsent alternative, an older run revision, a contactless whole-job
    -- quote beside party documents) keeps a job out; a single-document job is
    -- never listed; documents are counted, not parties, so a listed job may
    -- still be legitimately partial. Condition-based.
    SELECT 'partially_accepted_all_documents_accepted', j.id, j.id::text, max(d.accepted_at)
      FROM public.jobs j
      JOIN public.job_documents d ON d.job_id = j.id AND d.type = 'quote'
                                 AND d.superseded_at IS NULL AND d.declined_at IS NULL
     WHERE j.status = 'partially_accepted'
       AND NOT EXISTS (SELECT 1 FROM public.job_documents x
                        WHERE x.job_id = j.id AND x.type = 'quote' AND x.declined_at IS NOT NULL
                          AND x.superseded_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.run_acceptances r
                         LEFT JOIN public.job_documents rd ON rd.id = r.job_document_id
                        WHERE r.job_id = j.id AND r.status = 'declined'
                          AND (rd.id IS NULL OR rd.superseded_at IS NULL))
     GROUP BY j.id
    HAVING count(*) >= 2 AND bool_and(d.accepted_at IS NOT NULL)
       AND (p_since IS NULL OR max(d.accepted_at) >= p_since)
    UNION ALL
    -- An accepted run document with a contact but no accepted run acceptance
    -- pointing at it: the legacy run upsert failed after the document
    -- committed (Codex d98903c finding 4). Condition-based. A run document
    -- with no contact is excluded: today's upsert fails for it by design.
    SELECT 'accepted_run_document_without_run_acceptance', d.job_id, d.id::text, d.accepted_at
      FROM public.job_documents d
     WHERE d.type = 'quote' AND d.accepted_at IS NOT NULL AND d.superseded_at IS NULL AND d.declined_at IS NULL
       AND d.job_contact_id IS NOT NULL
       AND coalesce(d.data_snapshot_json->'run'->>'run_label', d.run_label) IS NOT NULL
       AND (p_since IS NULL OR d.accepted_at >= p_since)
       AND NOT EXISTS (SELECT 1 FROM public.run_acceptances ra
                        WHERE ra.job_document_id = d.id AND ra.status = 'accepted')
    UNION ALL
    -- An accepted run acceptance whose document is no longer live (superseded,
    -- declined, not accepted, missing, or no pointer at all): the run row
    -- outlived its document. Codex d98903c finding 4. Condition-based; may
    -- include a re-quote that replaced the document without clearing the run
    -- row. Bounded by p_since on the run row's acceptance.
    SELECT 'run_acceptance_document_not_live', ra.job_id,
           ra.job_id::text || '/' || coalesce(ra.job_contact_id::text, 'none') || '/' || ra.run_label, ra.accepted_at
      FROM public.run_acceptances ra
      LEFT JOIN public.job_documents d ON d.id = ra.job_document_id
     WHERE ra.status = 'accepted'
       AND (d.id IS NULL OR d.superseded_at IS NOT NULL OR d.declined_at IS NOT NULL OR d.accepted_at IS NULL)
       AND (p_since IS NULL OR ra.accepted_at IS NULL OR ra.accepted_at >= p_since)
    UNION ALL
    -- An accepted whole-quote document beside a sibling option for the same
    -- recipient (same job, no run label, same contact or both none) that was
    -- created before the acceptance and is still open: the legacy sibling
    -- supersession failed after the acceptance committed (Codex d98903c
    -- finding 4). ref: accepted>sibling. Condition-based.
    SELECT 'accepted_quote_with_open_sibling_document', d.job_id, d.id::text || '>' || s.id::text, d.accepted_at
      FROM public.job_documents d
      JOIN public.job_documents s
        ON s.job_id = d.job_id AND s.id <> d.id AND s.type = 'quote'
       AND s.job_contact_id IS NOT DISTINCT FROM d.job_contact_id
     WHERE d.type = 'quote' AND d.accepted_at IS NOT NULL AND d.superseded_at IS NULL AND d.declined_at IS NULL
       AND coalesce(d.data_snapshot_json->'run'->>'run_label', d.run_label) IS NULL
       AND coalesce(s.data_snapshot_json->'run'->>'run_label', s.run_label) IS NULL
       AND s.superseded_at IS NULL AND s.declined_at IS NULL AND s.accepted_at IS NULL
       AND s.created_at <= d.accepted_at
       AND (p_since IS NULL OR d.accepted_at >= p_since)
    UNION ALL
    -- A job in a won status still marked superseded: only a write that
    -- skipped the trigger can leave this (the trigger clears a winner's own
    -- mark). Condition-based.
    SELECT 'won_while_superseded', w.id, w.id::text, w.accepted_at
      FROM public.jobs w
     WHERE w.quote_option_group_id IS NOT NULL
       AND public.fence_quote_option_status_won(w.status) AND w.superseded_at IS NOT NULL
    UNION ALL
    -- The handler reached its response but a follow-up write it is meant to
    -- make (for example the post-commit business event) failed: not swallowed.
    SELECT 'acceptance_follow_up_issue', a.job_id, a.document_id::text, a.handler_finished_at
      FROM public.quote_acceptance_attempts a
     WHERE a.handler_issues IS NOT NULL AND a.resolved_at IS NULL
    UNION ALL
    SELECT 'acceptance_handler_unfinished', a.job_id, a.document_id::text, a.committed_at
      FROM public.quote_acceptance_attempts a
     WHERE a.handler_finished_at IS NULL AND a.resolved_at IS NULL AND a.committed_at < now() - p_grace
  ) g
  WHERE g.kind IN ('won_with_open_sibling', 'more_than_one_won', 'won_without_acceptance_event',
                   'won_while_superseded', 'accepted_document_job_not_won', 'supersede_switch_unreadable',
                   'accepted_run_document_without_run_acceptance', 'run_acceptance_document_not_live',
                   'accepted_quote_with_open_sibling_document', 'partially_accepted_all_documents_accepted')
     OR NOT EXISTS (SELECT 1 FROM public.quote_acceptance_gap_resolutions x WHERE x.kind = g.kind AND x.ref = g.ref);
END $$;
REVOKE ALL ON FUNCTION public.quote_acceptance_gaps(interval, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_gaps(interval, timestamptz) TO service_role;

-- Every object this migration owns carries an 'SQ-23 remedy:' comment, so the
-- rollback contract can find one that was renamed rather than dropped.
COMMENT ON FUNCTION public.quote_acceptance_fingerprint(uuid) IS 'SQ-23 remedy: acceptance decision fingerprint.';
COMMENT ON FUNCTION public.quote_acceptance_snapshot(uuid, text) IS 'SQ-23 remedy: acceptance decision snapshot.';
COMMENT ON FUNCTION public.accept_quote_document_atomic(uuid, text, uuid, timestamptz, text, text, text, uuid, jsonb) IS 'SQ-23 remedy: atomic quote acceptance.';
COMMENT ON FUNCTION public.quote_acceptance_handler_finished(uuid, uuid, text) IS 'SQ-23 remedy: handler reached its response.';
COMMENT ON FUNCTION public.quote_acceptance_gaps(interval, timestamptz) IS 'SQ-23 remedy: R3 gap read.';

-- C4 (Codex d98903c): send-quote's legacy (split-write) status write, as one
-- call that marks its own transaction. The supersede trigger's final site
-- treats sw.quote_accept_legacy = 'on' like today's behaviour (warning, the
-- status stands) whatever the strict and atomic switches read, so a switch
-- read in the trigger can never refuse the status of a legacy acceptance whose
-- document (and run acceptance) has already committed in an earlier request.
-- The write is exactly the PATCH it replaces: status, and accepted_at only when
-- one is given (the handler passes it only for 'accepted', from the same clock
-- read as before). The atomic marker still wins over this one. Cooperative,
-- like the atomic marker: a trusted-writer assumption; EXECUTE is service role
-- only. A returned error is ignored by the handler, as today's PATCH result is
-- (a separate residual, design section 3).
CREATE OR REPLACE FUNCTION public.quote_accept_legacy_set_status(
  p_job_id uuid, p_status text, p_accepted_at timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev text := coalesce(current_setting('sw.quote_accept_legacy', true), '');
BEGIN
  PERFORM set_config('sw.quote_accept_legacy', 'on', true);
  IF p_accepted_at IS NULL THEN
    UPDATE public.jobs SET status = p_status WHERE id = p_job_id;
  ELSE
    UPDATE public.jobs SET status = p_status, accepted_at = p_accepted_at WHERE id = p_job_id;
  END IF;
  PERFORM set_config('sw.quote_accept_legacy', v_prev, true);
END $$;
REVOKE ALL ON FUNCTION public.quote_accept_legacy_set_status(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_accept_legacy_set_status(uuid, text, timestamptz) TO service_role;
COMMENT ON FUNCTION public.quote_accept_legacy_set_status(uuid, text, timestamptz) IS 'SQ-23 remedy: legacy acceptance status write, marked so strict never refuses it.';
