-- Context recon dispute marker (CTX-18), 21 Oct 2026.
--
-- CTX-18 is not written down in this repo, in docs/context, or on an open issue. The word
-- "dispute" already in the framework is the ledger item status set by context_ledger_person_edit
-- (an open item is wrong). That is a different question and this migration does not touch it.
--
-- A dispute here is a person's statement that a captured message's reconciliation is wrong.
-- Decisions stay append-only attribution (context_recon_record_decision). The marker is a
-- separate, clearable row so it can be reversed without a new decision action and without
-- reopening the queue.
--
-- One row per business_events id. reason, disputed_by and disputed_at are all null or all set.
-- A null or blank reason clears them. The newest mark replaces the previous one; there is no
-- history. disputed_by is person:<user id>, built here, never taken from the caller as text.
-- Nothing is seeded. There is no feature flag.
--
-- The marker is read by context_recon_dispute, and surfaced on context_job_view (per message,
-- plus disputed_messages) and context_recon_health (disputed_open). context_recon_queue is
-- left as it is: the unmerged daily list selects that function by column name and, once the
-- backlog lane lands, by a lane column. Replacing the queue from this file would drop that
-- column. A dispute does not change queue membership, the evidence hash, placement, money
-- or a ledger item, and it does not update business_events.
--
-- Service role only. The writer is the only insert and update. Rollback:
-- supabase/rollbacks/20261021160000_context_recon_dispute_down.sql.

CREATE TABLE IF NOT EXISTS public.context_recon_disputes (
  event_id uuid PRIMARY KEY REFERENCES public.business_events(id) ON DELETE CASCADE,
  reason text,
  disputed_by text,
  disputed_at timestamptz,
  CONSTRAINT context_recon_disputes_marker CHECK (
    (reason IS NULL AND disputed_by IS NULL AND disputed_at IS NULL)
    OR (reason IS NOT NULL AND disputed_by IS NOT NULL AND disputed_at IS NOT NULL)),
  CONSTRAINT context_recon_disputes_reason_len CHECK (
    reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 600),
  CONSTRAINT context_recon_disputes_by CHECK (
    disputed_by IS NULL
    OR disputed_by ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
COMMENT ON TABLE public.context_recon_disputes IS
 'Context recon dispute (20261021160000): the current dispute marker on one captured message. reason, disputed_by and disputed_at are all null (clear) or all set. Written only by context_recon_set_dispute. Not a decision, not a ledger status, and not queue membership. The newest mark replaces the previous one.';

ALTER TABLE public.context_recon_disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_recon_disputes FROM PUBLIC;

-- Staff only, the same roles as context_recon_record_decision. A null or blank reason clears.
-- A missing message is recon_subject_not_found. The lock is a read lock: this function does
-- not update business_events, so the hold and party-roles triggers do not run.
CREATE OR REPLACE FUNCTION public.context_recon_set_dispute(
  p_event uuid, p_user_id uuid, p_reason text)
RETURNS TABLE (reason text, disputed_by text, disputed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_reason text; v_by text; v_at timestamptz;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.users u WHERE u.id = p_user_id
         AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
    RAISE EXCEPTION 'recon_not_staff' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.business_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recon_subject_not_found' USING ERRCODE = 'P0002'; END IF;
  v_reason := nullif(btrim(p_reason), '');
  IF v_reason IS NULL THEN
    UPDATE public.context_recon_disputes AS d
       SET reason = NULL, disputed_by = NULL, disputed_at = NULL
     WHERE d.event_id = p_event
     RETURNING d.reason, d.disputed_by, d.disputed_at INTO v_reason, v_by, v_at;
    reason := NULL;
    disputed_by := NULL;
    disputed_at := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  IF char_length(v_reason) > 600 THEN
    RAISE EXCEPTION 'recon_dispute_reason' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.context_recon_disputes AS d (event_id, reason, disputed_by, disputed_at)
  VALUES (p_event, v_reason, 'person:' || p_user_id::text, now())
  ON CONFLICT (event_id) DO UPDATE
    SET reason = EXCLUDED.reason,
        disputed_by = EXCLUDED.disputed_by,
        disputed_at = EXCLUDED.disputed_at
  RETURNING d.reason, d.disputed_by, d.disputed_at INTO v_reason, v_by, v_at;
  reason := v_reason;
  disputed_by := v_by;
  disputed_at := v_at;
  RETURN NEXT;
END $$;
COMMENT ON FUNCTION public.context_recon_set_dispute(uuid, uuid, text) IS
 'Context recon dispute (20261021160000): the only writer of the dispute marker. Refuses a person who is not admin, owner or ops_manager (42501) and an unknown message (P0002). A null or blank reason clears the marker. A reason longer than 600 characters is 22023. Builds disputed_by as person:<user id>. Does not write a decision, a ledger item, an invoice, or any business_events column. Service role only.';

CREATE OR REPLACE FUNCTION public.context_recon_dispute(p_event uuid)
RETURNS TABLE (reason text, disputed_by text, disputed_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT d.reason, d.disputed_by, d.disputed_at
  FROM (SELECT p_event AS event_id) e
  LEFT JOIN public.context_recon_disputes d ON d.event_id = e.event_id
$$;
COMMENT ON FUNCTION public.context_recon_dispute(uuid) IS
 'Context recon dispute (20261021160000): the current marker on one message. One row; reason, disputed_by and disputed_at are null when the message has no row or the marker was cleared. Service role only.';

-- The job view a staff member reads: messages only through context_event_jobs, money from the
-- lines, open work from the live ledger, and scope (contract 6b). Scope reads every active party
-- on the job (the job's own contact and each job_contacts party), not only the primary contact,
-- and every row shown on the job as a candidate. It never says "nothing outstanding": Context
-- obligations are not built yet, so the quietest answer is no_recorded_invoice_or_open_item,
-- with scope_reads and scope_not_read naming what was and was not looked at.
-- A current dispute marker rides each message (dispute_reason, dispute_by, dispute_at) and
-- disputed_messages counts them. A clear marker is null and is not counted. Placement is unchanged.
CREATE OR REPLACE FUNCTION public.context_job_view(p_job uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH j AS (SELECT * FROM public.jobs WHERE id = p_job),
  party AS (
    SELECT j.ghl_contact_id AS contact_id FROM j WHERE nullif(btrim(j.ghl_contact_id), '') IS NOT NULL
    UNION
    SELECT jc.ghl_contact_id FROM public.job_contacts jc
    WHERE jc.job_id = p_job AND jc.removed_at IS NULL AND coalesce(jc.status, '') <> 'removed'
      AND nullif(btrim(jc.ghl_contact_id), '') IS NOT NULL),
  near AS (
    SELECT e.id FROM public.business_events e WHERE e.job_id = p_job
    UNION SELECT e.id FROM public.business_events e WHERE e.candidate_job_ids @> ARRAY[p_job]
    UNION SELECT l.event_id FROM public.context_placement_links l WHERE l.job_id = p_job
    UNION SELECT e.id FROM public.business_events e JOIN party ON e.contact_id = party.contact_id),
  placed AS (
    SELECT e.id, e.channel, e.occurred_at, e.contact_id, ej.job_id, ej.placement, ej.by, ej.reason
    FROM near n JOIN public.business_events e ON e.id = n.id
    CROSS JOIN LATERAL public.context_event_jobs(e.id) ej),
  msgs AS (
    SELECT p.id, p.channel, p.occurred_at, p.contact_id, p.job_id, p.placement, p.by, p.reason,
           d.reason AS dispute_reason, d.disputed_by AS dispute_by, d.disputed_at AS dispute_at
    FROM placed p
    LEFT JOIN public.context_recon_disputes d
      ON d.event_id = p.id AND d.disputed_at IS NOT NULL
    WHERE p.job_id = p_job),
  unclassified AS (
    SELECT count(DISTINCT p.id) AS n FROM placed p
    WHERE (p.job_id = p_job AND p.placement = 'candidate')
       OR (p.contact_id IN (SELECT contact_id FROM party) AND p.placement IN ('none', 'candidate')
           AND coalesce(p.reason, '') <> 'unrelated')),
  ln AS (SELECT * FROM public.context_job_owed_lines(ARRAY[p_job])),
  items AS (
    SELECT i.status FROM public.context_ledger_items i
    JOIN public.context_ledger_generations g ON g.id = i.generation_id AND g.status = 'live'
    WHERE i.job_id = p_job AND i.status IN ('open', 'disputed')),
  open_n AS (SELECT (SELECT count(*) FROM ln WHERE state = 'open') + (SELECT count(*) FROM items) AS n)
  SELECT jsonb_build_object(
    'job_number', (SELECT job_number FROM j),
    'messages', coalesce((SELECT jsonb_agg(jsonb_build_object('event', id, 'channel', channel, 'placement', placement,
                           'by', by, 'reason', reason, 'dispute_reason', dispute_reason, 'dispute_by', dispute_by,
                           'dispute_at', dispute_at) ORDER BY occurred_at, id) FROM msgs), '[]'::jsonb),
    'disputed_messages', (SELECT count(*) FROM msgs WHERE dispute_at IS NOT NULL),
    'money', coalesce((SELECT jsonb_agg(jsonb_build_object('invoice', invoice_number, 'state', state, 'certainty', certainty,
                        'due', due, 'paid_wording', payment_wording, 'bank_matched', bank_matched, 'bank_source', bank_source,
                        'reasons', to_jsonb(reasons), 'credit_applied', credit_applied_info,
                        'obligation_reassessment', obligation_reassessment)
                        ORDER BY invoice_number COLLATE "C") FROM ln), '[]'::jsonb),
    'owed_due', (SELECT coalesce(sum(due), 0) FROM ln WHERE state = 'open'),
    'open_ledger_items', (SELECT count(*) FROM items),
    'scope', CASE WHEN (SELECT n FROM unclassified) > 0 THEN 'not_everything_classified_yet'
                  WHEN (SELECT n FROM open_n) > 0 THEN 'outstanding_shown'
                  ELSE 'no_recorded_invoice_or_open_item' END,
    'scope_reads', jsonb_build_array('xero_invoices', 'context_ledger_items', 'party_messages'),
    'scope_not_read', jsonb_build_array('context_obligations'),
    'unclassified_customer_evidence', (SELECT n FROM unclassified))
  WHERE EXISTS (SELECT 1 FROM j)
$$;

-- Counts for the daily health row: held re-placements (all time and since p_since), the
-- queue by cause, and how many messages currently carry a dispute marker.
CREATE OR REPLACE FUNCTION public.context_recon_health(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'held_total', (SELECT count(*) FROM public.business_events e WHERE e.metadata ? 'recon_held'),
    'held_since', (SELECT count(*) FROM public.business_events e
                   WHERE e.metadata ? 'recon_held' AND (e.metadata -> 'recon_held' ->> 'at')::timestamptz >= p_since),
    'queue_by_cause', coalesce((SELECT jsonb_object_agg(cause, n) FROM
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb),
    'disputed_open', (SELECT count(*) FROM public.context_recon_disputes d WHERE d.disputed_at IS NOT NULL))
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.context_recon_set_dispute(uuid,uuid,text)',
    'public.context_recon_dispute(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.context_recon_disputes FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT ON public.context_recon_disputes TO service_role';
  END IF;
END $$;
