-- Rollback for 20261021160000_context_recon_dispute.sql.
--
-- Drops the dispute marker and restores context_job_view to its body from 20261020140000 and
-- context_recon_health to its body from 20261020155000 (with queue_by_lane). context_recon_queue is not touched. An open marker (disputed_at
-- set) is a person's statement and is kept nowhere else, so this refuses while one exists:
-- clear it first, or keep the migration. A cleared row does not block the drop. Re-running
-- after a successful drop is a no-op.

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.context_recon_disputes') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.context_recon_disputes WHERE disputed_at IS NOT NULL' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'context_recon_disputes holds % open dispute markers; clear them before dropping the table', n
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
END $$;

-- The job view a staff member reads: messages only through context_event_jobs, money from the
-- lines, open work from the live ledger, and scope (contract 6b). Scope reads every active party
-- on the job (the job's own contact and each job_contacts party), not only the primary contact,
-- and every row shown on the job as a candidate. It never says "nothing outstanding": Context
-- obligations are not built yet, so the quietest answer is no_recorded_invoice_or_open_item,
-- with scope_reads and scope_not_read naming what was and was not looked at.
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
  msgs AS (SELECT * FROM placed WHERE job_id = p_job),
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
                           'by', by, 'reason', reason) ORDER BY occurred_at, id) FROM msgs), '[]'::jsonb),
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

-- Counts for the daily health row: held re-placements (all time and since p_since) and the
-- queue by cause.
CREATE OR REPLACE FUNCTION public.context_recon_health(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'held_total', (SELECT count(*) FROM public.business_events e WHERE e.metadata ? 'recon_held'),
    'held_since', (SELECT count(*) FROM public.business_events e
                   WHERE e.metadata ? 'recon_held' AND (e.metadata -> 'recon_held' ->> 'at')::timestamptz >= p_since),
    'queue_by_cause', coalesce((SELECT jsonb_object_agg(cause, n) FROM
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb),
    'queue_by_lane', coalesce((SELECT jsonb_object_agg(lane, n) FROM
                       (SELECT q.lane, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.lane) c), '{}'::jsonb))
$$;

COMMENT ON FUNCTION public.context_job_view(uuid) IS NULL;
COMMENT ON FUNCTION public.context_recon_health(timestamptz) IS NULL;

DROP FUNCTION IF EXISTS public.context_recon_set_dispute(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.context_recon_dispute(uuid);
DROP TABLE IF EXISTS public.context_recon_disputes;
