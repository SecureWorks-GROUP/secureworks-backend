-- Context reconciliation daily list (CTX-R1 staff door), 20 Oct 2026.
-- Design: context-system contract ctx-reconciliation-workflow-design-v2.1-20261020.md, sections 4,
-- 5, 6.3, 6.5 and 14.3. Builds on 20261020140000_context_reconciliation_decisions.sql.
--
-- 1. The decision store also takes an owed invoice as its subject (subject_kind 'invoice'),
--    keyed by xero_invoices.id and an evidence hash over what the invoice says. A person says
--    which job it is for (correct), that it is for no job (unrelated), leaves it unresolved, or
--    escalates it to Finance. The decision is a statement only: nothing here writes
--    xero_invoices (job_id stays as Xero sync and the sealed money writers leave it), a ledger
--    item, a payment or a permission to pay.
-- 2. context_recon_record_invoice_decision: the invoice writer, with the same staff rule and the
--    same stale-evidence refusal as context_recon_record_decision.
-- 3. context_recon_daily_list: the short list a resolver works each morning, ranked by business
--    consequence (section 14.3): owed invoices with no job first, then queued messages from a
--    contact who owes money, then recent customer messages from a contact with a live job. Each
--    row carries the evidence hash the screen sends back, a short summary and the jobs to choose
--    from. Defect causes stay on the engineering list (section 8), never here.
-- Service role only, as in 20261020140000. Writes no business row.

DO $$
BEGIN
  IF to_regclass('public.context_reconciliation_decisions') IS NULL
     OR to_regprocedure('public.context_recon_queue(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'context_recon_daily_list_prerequisite_missing: apply 20261020140000_context_reconciliation_decisions first';
  END IF;
  IF to_regprocedure('public.context_recon_live_from()') IS NULL THEN
    RAISE EXCEPTION 'context_recon_daily_list_prerequisite_missing: apply 20261020155000_context_recon_backlog_lane first';
  END IF;
END $$;

ALTER TABLE public.context_reconciliation_decisions
  DROP CONSTRAINT IF EXISTS context_reconciliation_decisions_subject_kind_check;
ALTER TABLE public.context_reconciliation_decisions
  ADD CONSTRAINT context_reconciliation_decisions_subject_kind_check CHECK (subject_kind IN ('event', 'invoice'));

-- What an invoice says, for its decision: number, type, Xero contact, reference, total and date.
-- Status, amount due and payments stay outside it, so a payment or a part payment never reopens
-- a decision about which job the invoice is for. The date is written as YYYY-MM-DD, so the
-- session's DateStyle never changes the hash.
CREATE OR REPLACE FUNCTION public.context_recon_invoice_evidence_hash(p_invoice uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT md5(jsonb_build_object(
    'v', 1, 'kind', 'invoice', 'number', i.invoice_number, 'type', upper(coalesce(i.invoice_type, '')),
    'xero_contact_id', i.xero_contact_id, 'reference', i.reference, 'total', i.total::text,
    'invoice_date', to_char(i.invoice_date, 'YYYY-MM-DD'))::text)
  FROM public.xero_invoices i WHERE i.id = p_invoice
$$;

CREATE OR REPLACE FUNCTION public.context_recon_invoice_decision_state(p_invoice uuid)
RETURNS TABLE (decision_id bigint, action text, job_ids uuid[], escalate_to text, state text)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.action, d.job_ids, d.escalate_to,
         CASE WHEN d.id IS NULL THEN 'none'
              WHEN d.evidence_hash = public.context_recon_invoice_evidence_hash(p_invoice) THEN 'decided'
              ELSE 'evidence_changed' END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT x.* FROM public.context_reconciliation_decisions x
                     WHERE x.subject_kind = 'invoice' AND x.subject_id = p_invoice
                     ORDER BY x.id DESC LIMIT 1) d ON true
$$;

-- The invoice writer. Correct names the one job (any job); unrelated says it is for no job;
-- unresolved keeps it visible; escalate sends it to Finance (or the sales owner or owner). Confirm
-- and split are refused: there is no proposal to confirm, and an invoice across jobs is a money
-- question for Finance.
CREATE OR REPLACE FUNCTION public.context_recon_record_invoice_decision(
  p_invoice uuid, p_shown_hash text, p_action text, p_job_ids uuid[], p_cause text,
  p_user_id uuid, p_escalate_to text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_now text; v_prev bigint; v_id bigint;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id
                                      AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
    RAISE EXCEPTION 'recon_not_staff' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('correct', 'unrelated', 'unresolved', 'escalate') THEN
    RAISE EXCEPTION 'recon_invoice_action_not_allowed' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.xero_invoices WHERE id = p_invoice) THEN
    RAISE EXCEPTION 'recon_subject_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_now := public.context_recon_invoice_evidence_hash(p_invoice);
  IF p_shown_hash IS DISTINCT FROM v_now THEN
    RAISE EXCEPTION 'recon_evidence_changed_since_shown' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_job_ids, '{}')) j
             WHERE NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = j)) THEN
    RAISE EXCEPTION 'recon_job_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT s.decision_id INTO v_prev FROM public.context_recon_invoice_decision_state(p_invoice) s;
  INSERT INTO public.context_reconciliation_decisions
    (subject_kind, subject_id, evidence_hash, action, job_ids, cause, escalate_to, by, supersedes)
  VALUES ('invoice', p_invoice, v_now, p_action, coalesce(p_job_ids, '{}'), p_cause, p_escalate_to,
          'person:' || p_user_id, v_prev)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION public.context_recon_record_invoice_decision(uuid, text, text, uuid[], text, uuid, text) IS
 'Context reconciliation daily list (20261020160000): the only writer of invoice decisions. Refuses a person who is not admin, owner or ops_manager (42501), an action other than correct, unrelated, unresolved or escalate (22023), an unknown invoice or job (P0002), and evidence that moved since it was shown (40001). Writes only the decisions table, never xero_invoices. Service role only.';

-- A contact's owed money: unpaid recorded invoices (ACCREC, AUTHORISED or SUBMITTED) on the
-- contact's jobs.
CREATE OR REPLACE FUNCTION public.context_recon_contact_owed(p_contacts text[])
RETURNS TABLE (contact_id text, owed numeric)
LANGUAGE sql STABLE AS $$
  SELECT j.ghl_contact_id, sum(x.amount_due)
  FROM public.jobs j JOIN public.xero_invoices x ON x.job_id = j.id
  WHERE j.ghl_contact_id = ANY (p_contacts)
    AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
    AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED')
    AND coalesce(x.amount_due, 0) > 0
  GROUP BY 1
$$;

CREATE OR REPLACE FUNCTION public.context_recon_job_is_live(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(coalesce(p_status, '')) NOT IN ('archived', 'complete', 'completed', 'cancelled', 'lost', 'draft')
$$;

-- The jobs a person chooses from: id, number, type, status and suburb, live jobs first. Client
-- names and addresses stay on the job page.
CREATE OR REPLACE FUNCTION public.context_recon_job_choices(p_jobs uuid[])
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('job_id', j.id, 'job_number', j.job_number, 'type', j.type,
                                               'status', j.status, 'suburb', j.site_suburb,
                                               'live', public.context_recon_job_is_live(j.status))
                            ORDER BY public.context_recon_job_is_live(j.status) DESC, j.job_number COLLATE "C"), '[]'::jsonb)
  FROM public.jobs j WHERE j.id = ANY (p_jobs)
$$;

-- The daily list. Band 1: owed invoices with no job (not VOIDED, DELETED or DRAFT, amount due
-- above zero) that hold no current correct or unrelated decision. Band 2: queued messages (an
-- ambiguity, not a defect) from a contact who owes money. Band 3: queued inbound customer
-- messages from the last 30 days from a contact with a live job. Within a band the larger
-- amount and then the longer wait come first. Each row: the subject, its evidence hash, the
-- amount at stake, the wait, a short summary, the offered jobs (the ladder's candidates and job,
-- or the invoice contact's jobs) and the contact's other jobs.
CREATE OR REPLACE FUNCTION public.context_recon_daily_list(p_as_of timestamptz DEFAULT now(), p_limit int DEFAULT 50)
RETURNS TABLE (band int, band_label text, subject_kind text, subject_id uuid, evidence_hash text,
               amount numeric, waiting_days numeric, cause text, decision_state text, last_action text,
               owner text, summary jsonb, offered_jobs jsonb, other_jobs jsonb)
LANGUAGE sql STABLE AS $$
  WITH inv AS (
    SELECT i.id, i.amount_due, i.invoice_date, i.xero_contact_id,
           s.state, s.action, s.escalate_to, s.job_ids,
           jsonb_build_object('invoice_number', i.invoice_number, 'reference', i.reference, 'contact_name', i.contact_name,
                              'total', i.total, 'amount_due', i.amount_due, 'status', i.status,
                              'invoice_date', to_char(i.invoice_date, 'YYYY-MM-DD'),
                              'due_date', to_char(i.due_date, 'YYYY-MM-DD')) AS summary
    FROM public.xero_invoices i
    CROSS JOIN LATERAL public.context_recon_invoice_decision_state(i.id) s
    -- A decided item stays on the list with Finance until Xero carries the job (job_id set) or it
    -- stops being owed: a choice here changes nothing in Xero, so it must never make an owed invoice vanish.
    WHERE upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC' AND i.job_id IS NULL
      AND upper(coalesce(i.status, '')) NOT IN ('VOIDED', 'DELETED', 'DRAFT')
      AND coalesce(i.amount_due, 0) > 0),
  band1 AS (
    SELECT 1 AS band, 'owed_invoice_no_job'::text AS band_label, 'invoice'::text AS subject_kind, inv.id AS subject_id,
           inv.amount_due AS amount,
           round((extract(epoch FROM p_as_of - inv.invoice_date::timestamptz) / 86400)::numeric, 1) AS waiting_days,
           'ambiguity:invoice_no_job'::text AS cause, inv.state, inv.action,
           CASE WHEN inv.state = 'decided' AND inv.action IN ('correct', 'unrelated') THEN 'finance'
                WHEN inv.state = 'decided' AND inv.action = 'escalate' THEN inv.escalate_to
                ELSE 'context_resolver' END AS owner,
           inv.summary || jsonb_build_object('decided_jobs',
             CASE WHEN inv.state = 'decided' AND inv.action = 'correct'
                  THEN public.context_recon_job_choices(inv.job_ids) ELSE '[]'::jsonb END) AS summary,
           (SELECT array_agg(j.id) FROM public.jobs j WHERE inv.xero_contact_id IS NOT NULL AND j.xero_contact_id = inv.xero_contact_id) AS offered,
           NULL::uuid[] AS others
    FROM inv),
  q AS (
    SELECT q.*, e.contact_id, e.direction, e.candidate_job_ids, e.job_id, e.payload, e.occurred_at,
           coalesce(e.context_captured_at, e.occurred_at) AS captured,
           coalesce(nullif(e.metadata -> 'party_roles' ->> 'counterpart_role', ''), 'unstamped') AS role
    FROM public.context_recon_queue(p_as_of) q JOIN public.business_events e ON e.id = q.event_id
    WHERE q.cause LIKE 'ambiguity:%' AND e.contact_id IS NOT NULL AND q.lane = 'live'),
  owed AS (SELECT * FROM public.context_recon_contact_owed((SELECT array_agg(DISTINCT contact_id) FROM q))),
  cj AS (
    SELECT j.ghl_contact_id AS contact_id, array_agg(j.id) AS job_ids,
           bool_or(public.context_recon_job_is_live(j.status)) AS has_live
    FROM public.jobs j WHERE j.ghl_contact_id IN (SELECT DISTINCT contact_id FROM q) GROUP BY 1),
  msgs AS (
    SELECT CASE WHEN owed.owed > 0 THEN 2 ELSE 3 END AS band,
           CASE WHEN owed.owed > 0 THEN 'owing_contact' ELSE 'recent_customer_live_job' END AS band_label,
           'event'::text AS subject_kind, q.event_id AS subject_id, owed.owed AS amount, q.waiting_days,
           q.cause, q.decision_state, q.last_action, q.owner,
           jsonb_build_object('channel', q.channel, 'direction', q.direction,
                              'occurred_at', to_char(q.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                              'from', coalesce(q.payload ->> 'from', q.payload ->> 'email', q.payload ->> 'line'),
                              'subject', left(q.payload ->> 'subject', 200),
                              'preview', left(coalesce(q.payload ->> 'body_preview', q.payload ->> 'body', q.payload ->> 'text',
                                                       q.payload ->> 'message'), 280)) AS summary,
           coalesce(q.candidate_job_ids, '{}') || CASE WHEN q.job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[q.job_id] END AS offered,
           cj.job_ids AS others
    FROM q
    LEFT JOIN owed ON owed.contact_id = q.contact_id
    LEFT JOIN cj ON cj.contact_id = q.contact_id
    WHERE owed.owed > 0
       OR (cj.has_live AND q.direction = 'inbound'
           AND q.role IN ('job_customer', 'any_job_customer', 'customer', 'unstamped', 'unknown')
           AND q.captured >= p_as_of - interval '30 days')),
  ranked AS (
    SELECT * FROM band1
    UNION ALL
    SELECT band, band_label, subject_kind, subject_id, amount, waiting_days, cause, decision_state, last_action, owner,
           summary, offered, others FROM msgs
    ORDER BY 1, 5 DESC NULLS LAST, 6 DESC NULLS LAST, 4
    LIMIT greatest(1, least(coalesce(p_limit, 50), 200)))
  SELECT r.band, r.band_label, r.subject_kind, r.subject_id,
         CASE WHEN r.subject_kind = 'invoice' THEN public.context_recon_invoice_evidence_hash(r.subject_id)
              ELSE public.context_recon_evidence_hash(r.subject_id) END,
         r.amount, r.waiting_days, r.cause, r.state, r.action, r.owner, r.summary,
         public.context_recon_job_choices(coalesce(r.offered, '{}')),
         public.context_recon_job_choices(ARRAY(SELECT x FROM unnest(coalesce(r.others, '{}')) x
                                                EXCEPT SELECT y FROM unnest(coalesce(r.offered, '{}')) y))
  FROM ranked r
  ORDER BY r.band, r.amount DESC NULLS LAST, r.waiting_days DESC NULLS LAST, r.subject_id
$$;
COMMENT ON FUNCTION public.context_recon_daily_list(timestamptz, int) IS
 'Context reconciliation daily list (20261020160000): the resolver''s list, ranked by consequence (owed invoices with no job, then messages from a contact who owes, then recent customer messages on a live job). Read only. Service role only.';

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.context_recon_invoice_evidence_hash(uuid)',
    'public.context_recon_invoice_decision_state(uuid)',
    'public.context_recon_record_invoice_decision(uuid,text,text,uuid[],text,uuid,text)',
    'public.context_recon_contact_owed(text[])',
    'public.context_recon_job_is_live(text)',
    'public.context_recon_job_choices(uuid[])',
    'public.context_recon_daily_list(timestamptz,int)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;
