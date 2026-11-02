-- CTX-T22/T24, Matching MT2/MT3: show original CRM source time for legacy
-- cache imports, never their loading clock. Reuses context_job_record_crm_time.
-- Existing decisions and source rows are never rewritten. A new optional time
-- witness binds future decisions to what was shown; prior NULL witnesses retain
-- their original contract. Source-time recovery alone does not erase a prior
-- person's placement. Changed words still invalidate it as before.
-- The shown 32-hex hash combines the existing content hash and time witness
-- only for legacy imports. Ordinary events and invoice decisions are unchanged.
-- No first live staff decision, placement activation, send or accounting change.
-- Rollback refuses if any time-aware decision exists: reverting after adoption
-- would silently remove its source-time protection. Do not delete such rows.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_evidence_hash(uuid)')),'') NOT IN ('da853bc2ff86c12d28e2b87fdbea1f02','44ccd308c15f5d3e7f12503965a834eb') THEN RAISE EXCEPTION 'matching_time_preimage_mismatch: context_recon_evidence_hash(uuid)'; END IF;
 IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_decision_state(uuid)')),'') NOT IN ('3167947e7b2ec2ed8f85edf4ec7883ad','2a804b7b7c226c1b623a14d8f5c81026') THEN RAISE EXCEPTION 'matching_time_preimage_mismatch: context_recon_decision_state(uuid)'; END IF;
 IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_record_decision(uuid,text,text,uuid[],text,uuid,text)')),'') NOT IN ('3b5443a511ac3b5ec08a07293d11eb50','9cc5672723ba368861f1305812bb6f2e') THEN RAISE EXCEPTION 'matching_time_preimage_mismatch: context_recon_record_decision(uuid,text,text,uuid[],text,uuid,text)'; END IF;
 IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_hold_decided()')),'') NOT IN ('da3065a6761af94b78bccd643e554176','b2cf225251d4e69b81d27be277fbff27') THEN RAISE EXCEPTION 'matching_time_preimage_mismatch: context_recon_hold_decided()'; END IF;
 IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_daily_rows(timestamp with time zone)')),'') NOT IN ('a598eda6cab72661c424e3b748d0c53c','b09aeb980a947da9de9d4a64f132e5f3') THEN RAISE EXCEPTION 'matching_time_preimage_mismatch: context_recon_daily_rows(timestamp with time zone)'; END IF;
 IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_job_items(uuid)')),'') NOT IN ('806739c4179184e11b54b7f29bc6565b','3fb6517fa8b4cf3a9f56192bedeb47ce') THEN RAISE EXCEPTION 'matching_time_preimage_mismatch: context_recon_job_items(uuid)'; END IF;
 IF to_regprocedure('public.context_recon_source_at(business_events)') IS NOT NULL AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_source_at(business_events)')) IS DISTINCT FROM '8b40d559006f9a4241180b90852a5939' THEN RAISE EXCEPTION 'matching_time_helper_mismatch'; END IF;
 IF to_regprocedure('public.context_recon_source_time_hash(business_events)') IS NOT NULL AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_recon_source_time_hash(business_events)')) IS DISTINCT FROM '61c301d66ba259cb0052456fba0abb39' THEN RAISE EXCEPTION 'matching_time_helper_mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_reconciliation_decisions'::regclass AND attname='source_time_hash' AND NOT attisdropped AND (atttypid<>'text'::regtype OR attnotnull OR COALESCE(col_description(attrelid,attnum),'') NOT LIKE 'Matching source-time correction:%')) THEN RAISE EXCEPTION 'matching_time_column_mismatch'; END IF;
END $guard$;
DO $data$ DECLARE used boolean; BEGIN
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_reconciliation_decisions'::regclass AND attname='source_time_hash' AND NOT attisdropped) THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.context_reconciliation_decisions WHERE source_time_hash IS NOT NULL)' INTO used;
  IF used THEN RAISE EXCEPTION 'matching_time_rollback_has_decisions: preserve time-aware decisions; forward recovery required';END IF;
 END IF;
END $data$;
CREATE OR REPLACE FUNCTION public.context_recon_evidence_hash(p_event uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT public.context_recon_evidence_hash_of(e.channel, e.direction, e.occurred_at, e.contact_id, e.payload)
  FROM public.business_events e WHERE e.id = p_event
$function$;
CREATE OR REPLACE FUNCTION public.context_recon_decision_state(p_event uuid)
 RETURNS TABLE(decision_id bigint, action text, job_ids uuid[], escalate_to text, state text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT d.id, d.action, d.job_ids, d.escalate_to,
         CASE WHEN d.id IS NULL THEN 'none'
              WHEN d.evidence_hash = public.context_recon_evidence_hash(p_event) THEN 'decided'
              ELSE 'evidence_changed' END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT x.* FROM public.context_reconciliation_decisions x
                     WHERE x.subject_kind = 'event' AND x.subject_id = p_event
                     ORDER BY x.id DESC LIMIT 1) d ON true
$function$;
CREATE OR REPLACE FUNCTION public.context_recon_record_decision(p_event uuid, p_shown_hash text, p_action text, p_job_ids uuid[], p_cause text, p_user_id uuid, p_escalate_to text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
CREATE OR REPLACE FUNCTION public.context_recon_hold_decided()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
CREATE OR REPLACE FUNCTION public.context_recon_daily_rows(p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(band integer, band_label text, subject_kind text, subject_id uuid, amount numeric, waiting_days numeric, cause text, decision_state text, last_action text, owner text, summary jsonb, offered uuid[], others uuid[])
 LANGUAGE sql
 STABLE
AS $function$
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
           coalesce(nullif(e.metadata -> 'party_roles' ->> 'counterpart_role', ''), 'unstamped') AS role,
           nullif(e.metadata -> 'party_roles' ->> 'counterpart_role', '') AS counterpart_role
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
           jsonb_build_object('channel', q.channel,
                              'counterpart_role', q.counterpart_role,
                              'direction', q.direction,
                              'occurred_at', to_char(q.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                              'from', coalesce(q.payload ->> 'from', q.payload ->> 'email', q.payload ->> 'line'),
                              'subject', left(q.payload ->> 'subject', 200),
                              'preview', CASE WHEN q.channel IS DISTINCT FROM 'call' THEN
                                left(coalesce(q.payload ->> 'body_preview', q.payload ->> 'body', q.payload ->> 'text',
                                              q.payload ->> 'message'), 280) END) AS summary,
           coalesce(q.candidate_job_ids, '{}') || CASE WHEN q.job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[q.job_id] END AS offered,
           cj.job_ids AS others
    FROM q
    LEFT JOIN owed ON owed.contact_id = q.contact_id
    LEFT JOIN cj ON cj.contact_id = q.contact_id
    WHERE owed.owed > 0
       OR (cj.has_live AND q.direction = 'inbound'
           AND q.role IN ('job_customer', 'any_job_customer', 'customer', 'unstamped', 'unknown')
           AND q.captured >= p_as_of - interval '30 days'))
  SELECT * FROM band1
  UNION ALL
  SELECT band, band_label, subject_kind, subject_id, amount, waiting_days, cause, decision_state, last_action, owner,
         summary, offered, others FROM msgs
$function$;
CREATE OR REPLACE FUNCTION public.context_recon_job_items(p_job uuid)
 RETURNS TABLE(event_id uuid, channel text, direction text, occurred_at timestamp with time zone, from_address text, subject text, preview text, counterpart_role text, cause text, decision_state text, last_action text, shown_hash text, offered jsonb)
 LANGUAGE sql
 STABLE
AS $function$
  WITH near AS (
    SELECT e.id FROM public.business_events e WHERE e.candidate_job_ids @> ARRAY[p_job]
    UNION SELECT e.id FROM public.business_events e WHERE e.job_id = p_job
    UNION SELECT l.event_id FROM public.context_placement_links l WHERE l.job_id = p_job),
  q AS (
    SELECT e.*, s.state, s.action
    FROM near n JOIN public.business_events e ON e.id = n.id
    CROSS JOIN LATERAL public.context_recon_decision_state(e.id) s
    WHERE (e.attribution_status = ANY (public.context_recon_queue_statuses())
           OR (e.attribution_status IS NULL AND e.job_id IS NULL)
           OR s.decision_id IS NOT NULL)
      AND NOT (s.state = 'decided' AND s.action IN ('confirm','correct','split','unrelated'))
      AND NOT (coalesce(e.metadata, '{}'::jsonb) ? 'duplicate_of'))
  SELECT q.id, q.channel, q.direction, q.occurred_at,
         CASE WHEN jsonb_typeof(q.payload -> 'from') = 'string' THEN q.payload ->> 'from' END,
         q.payload ->> 'subject',
         CASE WHEN q.channel IS DISTINCT FROM 'call' THEN
           left(coalesce(nullif(q.payload ->> 'body_preview', ''), nullif(q.payload ->> 'text', ''),
                         regexp_replace(left(coalesce(q.payload ->> 'body', ''), 2000), '\s+', ' ', 'g')), 240) END,
         q.metadata -> 'party_roles' ->> 'counterpart_role',
         CASE WHEN q.contact_id IS NULL THEN 'defect:no_identity'
              WHEN q.attribution_checked_at IS NULL THEN 'defect:backfill_never_asked'
              WHEN coalesce(cardinality(q.candidate_job_ids), 0) > 1 THEN 'ambiguity:several_candidates'
              WHEN coalesce(cardinality(q.candidate_job_ids), 0) = 1 THEN 'ambiguity:one_candidate'
              ELSE 'ambiguity:no_candidate' END,
         q.state, q.action,
         public.context_recon_evidence_hash_of(q.channel, q.direction, q.occurred_at, q.contact_id, q.payload),
         coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', j.id, 'job_number', j.job_number,
                                                       'type', j.type, 'suburb', j.site_suburb, 'status', j.status,
                                                       'reasons', to_jsonb(array_remove(ARRAY[
                                                         CASE WHEN j.id = q.job_id THEN 'ladder_job' END,
                                                         CASE WHEN j.id = ANY (coalesce(q.candidate_job_ids, '{}'::uuid[]))
                                                              THEN 'candidate' END,
                                                         CASE WHEN q.contact_id IS NOT NULL AND j.ghl_contact_id = q.contact_id
                                                              THEN 'customer_job' END,
                                                         CASE WHEN j.job_number IS NOT NULL AND q.channel IS DISTINCT FROM 'call'
                                                               AND (coalesce(q.payload ->> 'subject', '') || ' '
                                                                    || left(coalesce(q.payload ->> 'body', q.payload ->> 'text', ''), 2000))
                                                                   ~* ('(^|[^A-Za-z0-9])' || j.job_number || '($|[^A-Za-z0-9])')
                                                              THEN 'job_number_in_message' END], NULL)))
                                    ORDER BY j.job_number COLLATE "C", j.id)
                   FROM public.jobs j
                   WHERE j.id = ANY (coalesce(q.candidate_job_ids, '{}'::uuid[])
                                     || CASE WHEN q.job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[q.job_id] END)),
                  '[]'::jsonb)
  FROM q
  ORDER BY q.occurred_at DESC, q.id DESC
  LIMIT 201
$function$;
DROP FUNCTION IF EXISTS public.context_recon_source_time_hash(public.business_events);
DROP FUNCTION IF EXISTS public.context_recon_source_at(public.business_events);
ALTER TABLE public.context_reconciliation_decisions DROP COLUMN IF EXISTS source_time_hash;
COMMIT;
