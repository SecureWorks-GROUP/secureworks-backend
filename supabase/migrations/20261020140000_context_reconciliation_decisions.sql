-- Context reconciliation decisions (CTX-R1, R1b), 20 Oct 2026.
-- A person's decision about which job a captured row concerns: append-only, keyed by the row's
-- evidence, read by every rebuild. Design: context-system contract
-- ctx-reconciliation-workflow-design-v2-20261020.md (sections 5, 6, 8, 10, 13).
--
-- 1. context_reconciliation_decisions: one row per decision (confirm, correct, split, unrelated,
--    unresolved, escalate), with the evidence hash the person was shown. Never updated or deleted.
-- 2. context_placement_links: a person's placement, one row per (decision, job), so a split can
--    put one row on two jobs. business_events.job_id is one column and candidate_job_ids is a
--    doubt list; neither can hold a split. A split is a person's statement about one row, not
--    CTX-01 (the ladder placing one message on all candidate jobs automatically).
-- 3. context_event_jobs(event): the one read of which jobs a row is on and how sure. Consumers
--    that read business_events.job_id move to it slice by slice.
-- 4. context_recon_hold_decided: while a decision's evidence still matches, a re-placement path
--    (reopen, bucket re-run, misfile repair, re-decide triggers) that agrees with the person goes
--    through; one that would move the row away from the person's answer (another job, or the
--    same job with a status that turns it from linked to unlinked) is held and stamped
--    metadata.recon_held, never silently. When the evidence changes the decision stops applying
--    and the row is queued again. context_recon_health counts held rows.
-- 5. context_recon_queue: what needs a person, with cause (ambiguity or a named defect).
-- 6. context_job_owed_lines, context_job_view: read-time recorded-invoice lines (no stored table;
--    Xero is authoritative for recorded balances and payment status only) and the job view that
--    puts them beside the messages.
-- A decision records attribution only. It never writes an invoice, a ledger item, a work state,
-- a payment or a permission to pay. Service role only: every table and function is revoked from
-- PUBLIC, anon and authenticated (Supabase's default privileges grant EXECUTE to anon and
-- authenticated directly, so a revoke from PUBLIC alone is not enough). The writer takes the
-- deciding person's user id, checks the same staff roles as context_ledger_person_edit
-- (admin, owner, ops_manager) and builds `by` itself.

CREATE TABLE IF NOT EXISTS public.context_reconciliation_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('event')),
  subject_id uuid NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{32}$'),
  action text NOT NULL CHECK (action IN ('confirm','correct','split','unrelated','unresolved','escalate')),
  job_ids uuid[] NOT NULL DEFAULT '{}',
  cause text NOT NULL CHECK (cause ~ '^(ambiguity|defect):[a-z_]{1,40}$'),
  escalate_to text CHECK (escalate_to IS NULL OR escalate_to IN ('finance','sales','owner')),
  by text NOT NULL CHECK (by ~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  decided_at timestamptz NOT NULL DEFAULT now(),
  supersedes bigint REFERENCES public.context_reconciliation_decisions(id),
  CONSTRAINT crd_jobs_fit_action CHECK (
    (action IN ('confirm','correct') AND cardinality(job_ids) = 1) OR
    (action = 'split' AND cardinality(job_ids) >= 2) OR
    (action IN ('unrelated','unresolved') AND cardinality(job_ids) = 0) OR
    (action = 'escalate' AND escalate_to IS NOT NULL)),
  CONSTRAINT crd_escalate_only CHECK (escalate_to IS NULL OR action = 'escalate')
);
CREATE INDEX IF NOT EXISTS crd_subject ON public.context_reconciliation_decisions (subject_kind, subject_id, id DESC);
COMMENT ON TABLE public.context_reconciliation_decisions IS
 'Context reconciliation decisions (20261020140000): a person''s decision about one captured row, keyed by the row''s evidence hash (context_recon_evidence_hash_of). Append-only; written only by context_recon_record_decision. The newest row per subject is the decision; it applies only while the row''s evidence hash still matches. Attribution only: never an invoice, ledger item, work state, payment or permission to pay.';

CREATE TABLE IF NOT EXISTS public.context_placement_links (
  decision_id bigint NOT NULL REFERENCES public.context_reconciliation_decisions(id),
  event_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  certain boolean NOT NULL DEFAULT true,
  PRIMARY KEY (decision_id, job_id)
);
CREATE INDEX IF NOT EXISTS cpl_job ON public.context_placement_links (job_id);
CREATE INDEX IF NOT EXISTS cpl_event ON public.context_placement_links (event_id);
COMMENT ON TABLE public.context_placement_links IS
 'Context placement links (20261020140000): the jobs a person''s confirm, correct or split put a row on, one row per job. Append-only; written only by context_recon_record_decision. Read through context_event_jobs, never directly.';

ALTER TABLE public.context_reconciliation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_placement_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_reconciliation_decisions, public.context_placement_links FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.context_reconciliation_decisions_id_seq FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.context_reconciliation_decisions, public.context_placement_links FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.context_reconciliation_decisions_id_seq FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT ON public.context_reconciliation_decisions, public.context_placement_links TO service_role';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.context_recon_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
DROP TRIGGER IF EXISTS crd_append_only ON public.context_reconciliation_decisions;
CREATE TRIGGER crd_append_only BEFORE UPDATE OR DELETE ON public.context_reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.context_recon_append_only();
DROP TRIGGER IF EXISTS crd_no_truncate ON public.context_reconciliation_decisions;
CREATE TRIGGER crd_no_truncate BEFORE TRUNCATE ON public.context_reconciliation_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.context_recon_append_only();
DROP TRIGGER IF EXISTS cpl_append_only ON public.context_placement_links;
CREATE TRIGGER cpl_append_only BEFORE UPDATE OR DELETE ON public.context_placement_links
  FOR EACH ROW EXECUTE FUNCTION public.context_recon_append_only();
DROP TRIGGER IF EXISTS cpl_no_truncate ON public.context_placement_links;
CREATE TRIGGER cpl_no_truncate BEFORE TRUNCATE ON public.context_placement_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.context_recon_append_only();

-- The evidence a decision is about: what was said, by whom, when, on which channel. The hash is
-- over an explicit field list, so placement columns, metadata and every classification key a
-- backfill adds to the payload (audience_basis, builder_refs, to_tag, job_id, ...) stay outside it
-- and a rebuild, a re-stamp or a relabel never reads as changed evidence. The time is its epoch,
-- so the session's TimeZone and DateStyle never change the hash. jsonb renders keys in a fixed
-- order. Evidence payload keys (from the writers in _shared/evidence): the words (body, text,
-- message, subject, transcript, turns, words, transcript_version, forwarded_correspondence,
-- title, body_preview, body_hash, body_pointer), who and where (from, to, cc, email, line,
-- from_line), what came with it (attachments), and what a call, appointment or task says
-- (call_status, duration_seconds, start_time, end_time, due_date, appointment_status,
-- appointment_action, task_action, completed). A content key missing from this list errs
-- unsafe (a changed row keeps its decision), so a writer that adds one adds it here.
CREATE OR REPLACE FUNCTION public.context_recon_evidence_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['body','text','message','subject','transcript','turns','words','transcript_version',
               'forwarded_correspondence','title','body_preview','body_hash','body_pointer',
               'from','to','cc','email','line','from_line','attachments',
               'call_status','duration_seconds','start_time','end_time','due_date','appointment_status',
               'appointment_action','task_action','completed']::text[]
$$;

CREATE OR REPLACE FUNCTION public.context_recon_evidence_hash_of(
  p_channel text, p_direction text, p_occurred_at timestamptz, p_contact_id text, p_payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(jsonb_build_object(
    'v', 1, 'channel', p_channel, 'direction', p_direction,
    'occurred_at_epoch', extract(epoch FROM p_occurred_at)::text, 'contact_id', p_contact_id,
    'payload', coalesce((SELECT jsonb_object_agg(k, v) FROM jsonb_each(coalesce(p_payload, '{}'::jsonb)) AS t(k, v)
                         WHERE k = ANY (public.context_recon_evidence_keys())), '{}'::jsonb))::text)
$$;

CREATE OR REPLACE FUNCTION public.context_recon_evidence_hash(p_event uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT public.context_recon_evidence_hash_of(e.channel, e.direction, e.occurred_at, e.contact_id, e.payload)
  FROM public.business_events e WHERE e.id = p_event
$$;

-- The newest decision on a row and whether its evidence still matches: none, decided, evidence_changed.
CREATE OR REPLACE FUNCTION public.context_recon_decision_state(p_event uuid)
RETURNS TABLE (decision_id bigint, action text, job_ids uuid[], escalate_to text, state text)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.action, d.job_ids, d.escalate_to,
         CASE WHEN d.id IS NULL THEN 'none'
              WHEN d.evidence_hash = public.context_recon_evidence_hash(p_event) THEN 'decided'
              ELSE 'evidence_changed' END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT x.* FROM public.context_reconciliation_decisions x
                     WHERE x.subject_kind = 'event' AND x.subject_id = p_event
                     ORDER BY x.id DESC LIMIT 1) d ON true
$$;

-- The one writer. Takes the evidence hash the person was shown and refuses when it moved since.
-- Confirm picks a job the ladder offered (the row's candidates or its job); correct may name any job.
CREATE OR REPLACE FUNCTION public.context_recon_record_decision(
  p_event uuid, p_shown_hash text, p_action text, p_job_ids uuid[], p_cause text,
  p_user_id uuid, p_escalate_to text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_now text; v_prev bigint; v_id bigint; v_offered uuid[];
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id
                                      AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
    RAISE EXCEPTION 'recon_not_staff' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.business_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recon_subject_not_found' USING ERRCODE = 'P0002'; END IF;
  v_now := public.context_recon_evidence_hash(p_event);
  IF p_shown_hash IS DISTINCT FROM v_now THEN
    RAISE EXCEPTION 'recon_evidence_changed_since_shown' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_job_ids, '{}')) j
             WHERE NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = j)) THEN
    RAISE EXCEPTION 'recon_job_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT coalesce(e.candidate_job_ids, '{}') || CASE WHEN e.job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[e.job_id] END
    INTO v_offered FROM public.business_events e WHERE e.id = p_event;
  IF p_action = 'confirm' AND NOT (coalesce(p_job_ids, '{}') <@ v_offered) THEN
    RAISE EXCEPTION 'recon_confirm_needs_offered_job' USING ERRCODE = '22023', HINT = 'use correct';
  END IF;
  SELECT s.decision_id INTO v_prev FROM public.context_recon_decision_state(p_event) s;
  INSERT INTO public.context_reconciliation_decisions
    (subject_kind, subject_id, evidence_hash, action, job_ids, cause, escalate_to, by, supersedes)
  VALUES ('event', p_event, v_now, p_action, coalesce(p_job_ids, '{}'), p_cause, p_escalate_to, 'person:' || p_user_id, v_prev)
  RETURNING id INTO v_id;
  IF p_action IN ('confirm','correct','split') THEN
    INSERT INTO public.context_placement_links (decision_id, event_id, job_id)
    SELECT v_id, p_event, j FROM unnest(p_job_ids) j;
  END IF;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION public.context_recon_record_decision(uuid, text, text, uuid[], text, uuid, text) IS
 'Context reconciliation decisions (20261020140000): the only writer of decisions and placement links. Refuses a person who is not admin, owner or ops_manager (42501, the roles context_ledger_person_edit admits), evidence that moved since it was shown (40001), an unknown job (P0002), or a confirm of a job never offered (22023; offered = the row''s candidates or the ladder''s own job). Builds by as person:<user id>. Writes only the decision and links tables. Service role only.';

CREATE OR REPLACE FUNCTION public.context_recon_placement(p_event uuid)
RETURNS TABLE (job_ids uuid[], by text, decision_id bigint)
LANGUAGE sql STABLE AS $$
  SELECT s.job_ids, 'person'::text, s.decision_id
  FROM public.context_recon_decision_state(p_event) s
  WHERE s.state = 'decided' AND s.action IN ('confirm','correct','split')
$$;

-- Which jobs a row is on and how sure. A current placing decision gives its links, certain, by a
-- person. A current unrelated gives none, by a person. Otherwise the ladder: its linked job
-- (candidate with evidence_changed when a decision's evidence moved), its candidates, or none.
CREATE OR REPLACE FUNCTION public.context_event_jobs(p_event uuid)
RETURNS TABLE (job_id uuid, placement text, by text, reason text)
LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT * FROM public.context_recon_decision_state(p_event)),
       e AS (SELECT * FROM public.business_events WHERE id = p_event),
       person AS (
         SELECT l.job_id, 'certain'::text AS placement, 'person'::text AS by, NULL::text AS reason
         FROM s JOIN public.context_placement_links l ON l.decision_id = s.decision_id
         WHERE s.state = 'decided' AND s.action IN ('confirm','correct','split')),
       unrelated AS (SELECT 1 FROM s WHERE s.state = 'decided' AND s.action = 'unrelated'),
       chg AS (SELECT CASE WHEN s.state = 'evidence_changed' THEN 'evidence_changed' END AS why FROM s),
       ladder AS (
         SELECT e.job_id, CASE WHEN chg.why IS NULL THEN 'certain' ELSE 'candidate' END, 'ladder'::text, chg.why
         FROM e, chg
         WHERE NOT EXISTS (SELECT 1 FROM person) AND NOT EXISTS (SELECT 1 FROM unrelated)
           AND e.job_id IS NOT NULL AND public.context_linked_status(e.attribution_status)
         UNION ALL
         SELECT c, 'candidate', 'ladder',
                coalesce(chg.why, CASE WHEN cardinality(e.candidate_job_ids) > 1 THEN 'several_candidates' ELSE 'one_candidate' END)
         FROM e, chg, unnest(e.candidate_job_ids) c
         WHERE NOT EXISTS (SELECT 1 FROM person) AND NOT EXISTS (SELECT 1 FROM unrelated)
           AND NOT (e.job_id IS NOT NULL AND public.context_linked_status(e.attribution_status))),
       nothing AS (
         SELECT NULL::uuid, 'none'::text,
                CASE WHEN EXISTS (SELECT 1 FROM unrelated) THEN 'person' ELSE 'ladder' END,
                CASE WHEN EXISTS (SELECT 1 FROM unrelated) THEN 'unrelated'
                     ELSE coalesce((SELECT why FROM chg), 'placement_none') END
         FROM e
         WHERE NOT EXISTS (SELECT 1 FROM person) AND NOT EXISTS (SELECT 1 FROM ladder))
  SELECT * FROM person UNION ALL SELECT * FROM ladder UNION ALL SELECT * FROM nothing
$$;
COMMENT ON FUNCTION public.context_event_jobs(uuid) IS
 'Context reconciliation decisions (20261020140000): the one read of which jobs a captured row is on (placement certain, candidate or none; by person or ladder; reason). Consumers of business_events.job_id move to it.';

-- While a decision's evidence still matches, a re-placement that agrees with the person goes
-- through (confirm or correct onto the decided job, a split onto one of its jobs, each with a
-- linked status; unrelated onto no job), so existing readers of business_events.job_id follow the person's answer when the
-- ladder reaches it. An update that keeps the job and whether the status is linked passes as it
-- is. A re-placement that disagrees, including one that keeps the job but turns a linked status
-- unlinked, is held: the placement columns keep their old
-- values and the row is stamped metadata.recon_held (decision id, when, the job and status the
-- writer tried), never silently. context_recon_health counts held rows. Sorts before
-- context_party_roles_business_event so the roles trigger stamps the placement that stands.
CREATE OR REPLACE FUNCTION public.context_recon_hold_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record;
BEGIN
  SELECT x.id, x.action, x.job_ids, x.evidence_hash INTO d FROM public.context_reconciliation_decisions x
   WHERE x.subject_kind = 'event' AND x.subject_id = OLD.id ORDER BY x.id DESC LIMIT 1;
  IF NOT FOUND OR d.action NOT IN ('confirm','correct','split','unrelated') THEN RETURN NEW; END IF;
  IF d.evidence_hash IS DISTINCT FROM
     public.context_recon_evidence_hash_of(NEW.channel, NEW.direction, NEW.occurred_at, NEW.contact_id, NEW.payload) THEN
    RETURN NEW;
  END IF;
  IF NEW.job_id IS NOT DISTINCT FROM OLD.job_id
     AND public.context_linked_status(NEW.attribution_status) = public.context_linked_status(OLD.attribution_status) THEN
    RETURN NEW;
  END IF;
  IF (d.action = 'unrelated' AND NEW.job_id IS NULL)
     OR (d.action <> 'unrelated' AND NEW.job_id = ANY (d.job_ids) AND public.context_linked_status(NEW.attribution_status)) THEN
    RETURN NEW;
  END IF;
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('recon_held', jsonb_build_object(
    'decision_id', d.id, 'at', now(), 'tried_job_id', NEW.job_id, 'tried_status', NEW.attribution_status));
  NEW.job_id := OLD.job_id;
  NEW.attribution_status := OLD.attribution_status;
  NEW.attribution_step := OLD.attribution_step;
  NEW.attribution_confidence := OLD.attribution_confidence;
  NEW.attributed_at := OLD.attributed_at;
  NEW.candidate_job_ids := OLD.candidate_job_ids;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS context_aa_recon_hold_decided ON public.business_events;
CREATE TRIGGER context_aa_recon_hold_decided
  BEFORE UPDATE OF job_id, attribution_status, attribution_step, attribution_confidence, attributed_at, candidate_job_ids
  ON public.business_events FOR EACH ROW EXECUTE FUNCTION public.context_recon_hold_decided();

-- What needs a person now. Kept: never decided, unresolved, escalated (with who owns it), and
-- evidence changed. Left out: decided with unchanged evidence (confirm, correct, split, unrelated).
CREATE OR REPLACE FUNCTION public.context_recon_queue_statuses() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['unplaced','pending_luna','admin_bucket','review']::text[] $$;

CREATE OR REPLACE FUNCTION public.context_recon_queue(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (event_id uuid, channel text, waiting_days numeric, candidates int,
               cause text, decision_state text, last_action text, owner text)
LANGUAGE sql STABLE AS $$
  WITH pool AS (
    SELECT e.id FROM public.business_events e
    WHERE e.attribution_status = ANY (public.context_recon_queue_statuses())
       OR (e.attribution_status IS NULL AND e.job_id IS NULL)
    UNION
    SELECT DISTINCT d.subject_id FROM public.context_reconciliation_decisions d WHERE d.subject_kind = 'event')
  SELECT e.id, e.channel,
         round(extract(epoch FROM p_as_of - coalesce(e.context_captured_at, e.occurred_at)) / 86400, 1),
         coalesce(cardinality(e.candidate_job_ids), 0),
         CASE WHEN e.contact_id IS NULL THEN 'defect:no_identity'
              WHEN e.attribution_checked_at IS NULL THEN 'defect:backfill_never_asked'
              WHEN coalesce(cardinality(e.candidate_job_ids), 0) > 1 THEN 'ambiguity:several_candidates'
              WHEN coalesce(cardinality(e.candidate_job_ids), 0) = 1 THEN 'ambiguity:one_candidate'
              ELSE 'ambiguity:no_candidate' END,
         s.state, s.action,
         CASE WHEN s.state = 'decided' AND s.action = 'escalate' THEN s.escalate_to ELSE 'context_resolver' END
  FROM pool p JOIN public.business_events e ON e.id = p.id
  CROSS JOIN LATERAL public.context_recon_decision_state(e.id) s
  WHERE NOT (s.state = 'decided' AND s.action IN ('confirm','correct','split','unrelated'))
$$;

-- Read-time recorded-invoice lines. No stored table: Xero is authoritative for recorded balances
-- and payment status only. Reads xero_invoices directly (the job record's money read drops VOIDED
-- and DELETED) with the deployed paid and credited split (20261006011000). Each line carries
-- state, certainty (money design v3.1 section 6) and reasons. Kind is not stored yet, so every line
-- carries invoice_kind_unread. A credit is information on a certain line and a reassessment of the
-- linked obligation. PAID reads "Xero shows paid", never bank settled: bank_matched is 'unknown'
-- until a finance source feeds it (bank_source names it). Not built here: prepayments and
-- overpayments, so party_shared_contact is not produced.
CREATE OR REPLACE FUNCTION public.context_job_owed_lines(p_job_ids uuid[])
RETURNS TABLE (invoice_id uuid, job_id uuid, invoice_number text, state text, certainty text, due numeric,
               paid numeric, credited numeric, paid_on date, payment_wording text, bank_matched text,
               bank_source text, placement text, reasons text[], credit_applied_info boolean,
               obligation_reassessment boolean)
LANGUAGE sql STABLE AS $$
  WITH inv AS (
    SELECT x.id, x.job_id, x.invoice_number, x.reference, x.total, x.amount_due, x.amount_paid,
           x.fully_paid_on, x.raw_json, x.job_contact_id, upper(coalesce(x.status, '')) AS st, j.job_number
    FROM public.xero_invoices x JOIN public.jobs j ON j.id = x.job_id
    WHERE x.job_id = ANY (p_job_ids)
      AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(x.status, '')) <> 'DRAFT'),
  m AS (
    SELECT i.*, coalesce(i.amount_paid, 0) AS paid_amt,
      CASE WHEN jsonb_typeof(i.raw_json -> 'AmountCredited') = 'number' AND upper(coalesce(i.raw_json ->> 'Status', '')) = i.st
           THEN (i.raw_json ->> 'AmountCredited')::numeric
           WHEN i.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
           THEN greatest(coalesce(i.total, 0) - coalesce(i.amount_paid, 0) - coalesce(i.amount_due, 0), 0)
           ELSE 0 END AS credited_amt,
      (coalesce(i.reference, '') ~* ('(^|[^A-Za-z0-9])' || regexp_replace(i.job_number, '([^A-Za-z0-9])', '\\\1', 'g') || '([^A-Za-z0-9]|$)')) AS ref_names_job,
      EXISTS (SELECT 1 FROM public.job_contacts jc WHERE jc.id = i.job_contact_id AND jc.removed_at IS NULL
              AND coalesce(jc.status, '') <> 'removed') AS party_known,
      (SELECT max(left(p ->> 'Date', 10))::date FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(i.raw_json -> 'Payments') = 'array' THEN i.raw_json -> 'Payments' ELSE '[]'::jsonb END) p
        WHERE p ->> 'Date' ~ '^\d{4}-\d{2}-\d{2}') AS last_payment_date,
      (coalesce(i.amount_paid, 0) > 0 OR (jsonb_typeof(i.raw_json -> 'Payments') = 'array'
        AND jsonb_array_length(i.raw_json -> 'Payments') > 0)) AS any_payment,
      bool_and(i.st IN ('VOIDED', 'DELETED')) OVER (PARTITION BY i.job_id) AS job_only_void
    FROM inv i),
  d AS (SELECT m.*, coalesce(m.fully_paid_on, CASE WHEN m.st = 'PAID' THEN m.last_payment_date END) AS paid_date FROM m)
  SELECT d.id, d.job_id, d.invoice_number,
    CASE WHEN d.st IN ('VOIDED', 'DELETED') THEN 'superseded'
         WHEN d.st = 'PAID' OR coalesce(d.amount_due, 0) <= 0 THEN 'closed' ELSE 'open' END,
    CASE WHEN d.st IN ('VOIDED', 'DELETED', 'SUBMITTED') THEN 'uncertain'
         WHEN d.st = 'AUTHORISED' AND coalesce(d.amount_due, 0) <= 0 THEN 'uncertain'
         WHEN d.st = 'PAID' AND d.paid_date IS NULL THEN 'uncertain'
         ELSE 'certain' END,
    CASE WHEN d.st IN ('AUTHORISED', 'SUBMITTED') THEN greatest(coalesce(d.amount_due, 0), 0) ELSE 0 END,
    d.paid_amt, d.credited_amt, d.paid_date,
    CASE WHEN d.st = 'PAID' THEN 'Xero shows paid' || coalesce(' on ' || d.paid_date::text, '') || '; bank settlement not verified' END,
    'unknown'::text, 'none_yet'::text,
    'certain',
    array_remove(ARRAY[
      'invoice_kind_unread',
      CASE WHEN NOT d.party_known THEN 'party_unresolved' END,
      CASE WHEN NOT d.ref_names_job THEN 'link_unverified' END,
      CASE WHEN d.st = 'SUBMITTED' THEN 'invoice_not_approved' END,
      CASE WHEN d.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(d.amount_due, 0) <= 0 THEN 'closing_record_may_resolve' END,
      CASE WHEN d.st IN ('VOIDED', 'DELETED') THEN 'reassessment_needed' END,
      CASE WHEN d.st IN ('VOIDED', 'DELETED') AND d.any_payment THEN 'paid_then_voided' END,
      CASE WHEN d.st IN ('VOIDED', 'DELETED') AND d.job_only_void THEN 'voided_or_deleted_only' END,
      CASE WHEN d.st = 'PAID' AND d.fully_paid_on IS NULL AND d.paid_date IS NOT NULL THEN 'paid_date_from_payment' END,
      CASE WHEN d.st = 'PAID' AND d.paid_date IS NULL THEN 'paid_date_unknown' END], NULL),
    (d.st NOT IN ('VOIDED', 'DELETED') AND d.credited_amt > 0),
    (d.st IN ('VOIDED', 'DELETED') OR d.credited_amt > 0)
  FROM d
$$;

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
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb))
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.context_recon_append_only()',
    'public.context_recon_evidence_keys()',
    'public.context_recon_evidence_hash_of(text,text,timestamptz,text,jsonb)',
    'public.context_recon_evidence_hash(uuid)',
    'public.context_recon_decision_state(uuid)',
    'public.context_recon_record_decision(uuid,text,text,uuid[],text,uuid,text)',
    'public.context_recon_placement(uuid)',
    'public.context_recon_queue_statuses()',
    'public.context_event_jobs(uuid)',
    'public.context_recon_hold_decided()',
    'public.context_recon_queue(timestamptz)',
    'public.context_job_owed_lines(uuid[])',
    'public.context_job_view(uuid)',
    'public.context_recon_health(timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;
