-- SQ-23 remedy, slice 1 (branch sq23/acceptance-atomic): a public quote
-- acceptance commits its accepted document, its sibling supersession or run
-- acceptance, its job status and its acceptance record in ONE transaction.
-- Design: docs/sq23/acceptance-atomic-design.md. Requirement: CIO R1 to R5
-- (secureworks-projects ctx/cio-20261019 ef20d6f).
--
-- Nothing here changes behaviour while its switches are off:
--   * quote_accept_atomic_v1 (seeded off): send-quote calls
--     accept_quote_document_atomic only when this reads true. Off, missing or
--     unreadable selects today's separate writes.
--   * quote_option_strict_record_v1 (seeded off): read only by the SQ-23
--     supersede trigger at its final "nothing recorded" site. On, every writer
--     whose supersede run records nothing is refused. That is an owning-review
--     decision (it could block staff status changes), not settled here.
-- The party rules (which status an acceptance gives the job) stay in
-- send-quote, unchanged. This function does not re-derive them: it checks,
-- under the job lock, that everything they were computed from is unchanged
-- (quote_acceptance_fingerprint), and refuses with 'stale' otherwise, so the
-- caller re-reads and re-decides.

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'quote_accept_atomic_v1', false,
  'SQ-23 remedy: when on, send-quote accepts a quote through accept_quote_document_atomic (document, supersession or run acceptance, job status, acceptance event and attempt row in one transaction). Off: today''s separate writes. Turn on only on the owner''s word after the owning review.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_accept_atomic_v1');

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'quote_option_strict_record_v1', false,
  'SQ-23: when on, ANY status change whose quote-option supersede run can record nothing (run row, work and review event all failed) is refused and rolls back. Off: the status change stands with a warning (today). Owning-review decision: it can block staff status changes.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_option_strict_record_v1');

-- One row per document accepted through the atomic path, written in the
-- acceptance transaction. A document is accepted at most once, so the
-- document is the acceptance's identity: a repeat call (lost response,
-- reload, retry) finds this row and gets the committed result back.
-- downstream_started_at is set at commit: the follow-up work (invoice, GHL,
-- messages) belongs to the one request that committed, and runs at most once.
-- A replay never runs it. A crash before downstream_completed_at leaves the
-- row for a person (quote_acceptance_gaps), never a re-run.
CREATE TABLE public.quote_acceptance_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL UNIQUE,
  job_id uuid NOT NULL,
  run_label text,
  job_status text NOT NULL,
  previous_status text,
  accepted_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  downstream_started_at timestamptz,
  downstream_completed_at timestamptz,
  downstream_outcome text,
  resolved_at timestamptz,
  resolved_by uuid,
  CONSTRAINT quote_acceptance_attempts_status CHECK (job_status IN ('accepted', 'partially_accepted', 'quoted')),
  CONSTRAINT quote_acceptance_attempts_downstream_order CHECK (
    downstream_completed_at IS NULL OR downstream_started_at IS NOT NULL)
);
ALTER TABLE public.quote_acceptance_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quote_acceptance_attempts DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_acceptance_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE (resolved_at, resolved_by) ON public.quote_acceptance_attempts TO service_role;
CREATE INDEX idx_quote_acceptance_attempts_open
  ON public.quote_acceptance_attempts (committed_at) WHERE downstream_completed_at IS NULL AND resolved_at IS NULL;
COMMENT ON TABLE public.quote_acceptance_attempts IS
  'SQ-23 remedy: one row per quote document accepted through accept_quote_document_atomic, committed with the acceptance. Rows whose downstream work did not complete are listed by quote_acceptance_gaps for a person.';

-- Everything send-quote's party rules read, for one job, as one text value.
-- Timestamps as epoch numbers so the value does not depend on TimeZone or
-- DateStyle. send-quote reads this BEFORE its own reads; the RPC compares it
-- under the job lock. A change at any moment after the first read makes the
-- values differ, so the comparison is conservative (a spurious 'stale' only
-- costs a re-read).
CREATE OR REPLACE FUNCTION public.quote_acceptance_fingerprint(p_job_id uuid)
RETURNS text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT md5(
    coalesce((SELECT string_agg(concat_ws('|', d.id, d.job_contact_id, d.run_label, d.sent_to_client,
                extract(epoch FROM d.sent_at), extract(epoch FROM d.send_claimed_at),
                extract(epoch FROM d.accepted_at), extract(epoch FROM d.declined_at),
                extract(epoch FROM d.superseded_at), extract(epoch FROM d.created_at), d.version,
                d.data_snapshot_json -> 'run' ->> 'run_label'), ',' ORDER BY d.id)
       FROM public.job_documents d WHERE d.job_id = p_job_id AND d.type = 'quote'), '')
    || '#' ||
    coalesce((SELECT string_agg(concat_ws('|', a.id, a.job_document_id, a.job_contact_id, a.run_label,
                a.status, extract(epoch FROM a.accepted_at)), ',' ORDER BY a.id)
       FROM public.run_acceptances a WHERE a.job_id = p_job_id), '')
    || '#' ||
    coalesce((SELECT string_agg(DISTINCT concat_ws('|', r.run_label, r.job_contact_id), ',')
       FROM public.run_line_items r WHERE r.job_id = p_job_id), ''))
$$;
REVOKE ALL ON FUNCTION public.quote_acceptance_fingerprint(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_fingerprint(uuid) TO service_role;

-- The atomic acceptance. Returns jsonb {outcome, ...}:
--   accepted  committed now: document, supersession or run acceptance, job
--             status, acceptance event (when given) and attempt row.
--   replay    this document already has an attempt row: its stored result,
--             nothing written. Checked first, under the locks.
--   stale     what the caller decided from changed: nothing written; re-read.
--   refused   the document cannot be accepted (reason): nothing written.
-- Any error (including the supersede trigger's quote_option_unrecorded raise)
-- rolls the whole call back.
CREATE OR REPLACE FUNCTION public.accept_quote_document_atomic(
  p_document_id uuid,
  p_accepted_at timestamptz,
  p_job_status text,
  p_fingerprint text,
  p_run_label text,
  p_accept_event jsonb DEFAULT NULL
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
  IF p_document_id IS NULL OR p_accepted_at IS NULL THEN
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
  -- Serialize by job, then lock the job's quote documents in id order.
  PERFORM 1 FROM public.jobs j WHERE j.id = v_job FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_accept_job_missing' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.job_documents d WHERE d.job_id = v_job AND d.type = 'quote' ORDER BY d.id FOR UPDATE;
  SELECT * INTO v_doc FROM public.job_documents d WHERE d.id = p_document_id;
  IF v_doc.job_id IS DISTINCT FROM v_job THEN
    RETURN jsonb_build_object('outcome', 'stale', 'reason', 'document_moved');
  END IF;

  -- Replay before any eligibility check.
  SELECT * INTO v_attempt FROM public.quote_acceptance_attempts a WHERE a.document_id = p_document_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'replay', 'attempt_id', v_attempt.id,
      'job_id', v_attempt.job_id, 'job_status', v_attempt.job_status,
      'previous_status', v_attempt.previous_status, 'accepted_at', v_attempt.accepted_at,
      'downstream_started_at', v_attempt.downstream_started_at,
      'downstream_completed_at', v_attempt.downstream_completed_at);
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

  -- The caller's quoteDocumentRunLabel(doc), passed as computed (that rule
  -- stays in send-quote). NULL selects the whole-quote path, as today.
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
    -- records it for a person.
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (v_job, 'quote_acceptance_review_needed',
            jsonb_build_object('reason', 'accepted_after_status_moved', 'document_id', p_document_id,
                               'previous_status', v_prev_status, 'new_status', p_job_status));
  END IF;

  IF p_accept_event IS NOT NULL THEN
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (v_job, 'quote_accepted', p_accept_event);
  END IF;

  INSERT INTO public.quote_acceptance_attempts (document_id, job_id, run_label, job_status, previous_status, accepted_at,
                                                downstream_started_at)
  VALUES (p_document_id, v_job, v_run, p_job_status, v_prev_status, p_accepted_at, now())
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('outcome', 'accepted', 'attempt_id', v_attempt.id, 'job_id', v_job,
    'job_status', p_job_status, 'previous_status', v_prev_status, 'accepted_at', p_accepted_at);
END $$;
REVOKE ALL ON FUNCTION public.accept_quote_document_atomic(uuid, timestamptz, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote_document_atomic(uuid, timestamptz, text, text, text, jsonb) TO service_role;

-- Marks the follow-up work finished, with a short outcome. Only once.
CREATE OR REPLACE FUNCTION public.quote_acceptance_finish_downstream(p_document_id uuid, p_outcome text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_rows integer;
BEGIN
  UPDATE public.quote_acceptance_attempts
     SET downstream_completed_at = now(), downstream_outcome = left(coalesce(p_outcome, ''), 500)
   WHERE document_id = p_document_id AND downstream_started_at IS NOT NULL AND downstream_completed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION public.quote_acceptance_finish_downstream(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_finish_downstream(uuid, text) TO service_role;

-- R3: read-only list of what needs a person. Ids, codes and instants only.
--   settle_run_unsettled           a supersede run whose work failed
--   won_with_open_sibling          a grouped job in a won status beside an
--                                  open, unmarked option, with no review
--                                  event in the group since its acceptance
--                                  (meaningful only while the supersede
--                                  switch is on; a status written without
--                                  its trigger shows here)
--   acceptance_downstream_unfinished   committed, follow-up work not finished
-- p_grace: how old a downstream row must be before it is listed.
CREATE OR REPLACE FUNCTION public.quote_acceptance_gaps(p_grace interval DEFAULT interval '15 minutes')
RETURNS TABLE (kind text, job_id uuid, ref text, at timestamptz)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'settle_run_unsettled', r.job_id, r.id::text, r.created_at
    FROM public.quote_option_settle_runs r
   WHERE r.settled_at IS NULL AND r.resolved_at IS NULL
  UNION ALL
  SELECT 'won_with_open_sibling', w.id, w.quote_option_group_id::text, w.accepted_at
    FROM public.jobs w
   WHERE w.quote_option_group_id IS NOT NULL
     AND public.fence_quote_option_status_won(w.status)
     AND w.superseded_at IS NULL
     AND EXISTS (SELECT 1 FROM public.jobs s
                  WHERE s.quote_option_group_id = w.quote_option_group_id AND s.id <> w.id
                    AND coalesce(s.status, 'draft') IN ('draft', 'quoted') AND s.superseded_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.job_events e
                      JOIN public.jobs g ON g.id = e.job_id AND g.quote_option_group_id = w.quote_option_group_id
                     WHERE e.event_type = 'quote_option_review_needed'
                       AND (w.accepted_at IS NULL OR e.created_at >= w.accepted_at))
  UNION ALL
  SELECT 'acceptance_downstream_unfinished', a.job_id, a.document_id::text, a.downstream_started_at
    FROM public.quote_acceptance_attempts a
   WHERE a.downstream_started_at IS NOT NULL AND a.downstream_completed_at IS NULL
     AND a.resolved_at IS NULL AND a.downstream_started_at < now() - p_grace

$$;
REVOKE ALL ON FUNCTION public.quote_acceptance_gaps(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_acceptance_gaps(interval) TO service_role;
