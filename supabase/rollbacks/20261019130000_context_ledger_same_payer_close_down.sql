-- Rollback of 20261019130000_context_ledger_same_payer_close.sql (same payer close, 19 Oct 2026).
-- Restores the three bodies and comments this migration replaced, word for word as production ran
-- them before it (context_ledger_cite from 20261014120000, context_ledger_check_item from
-- 20261015100000, context_ledger_write from 20261007150000), drops the helpers, the builder contact
-- table and the three item columns. The feature flag row is kept (off or on, as it is), so a
-- re-apply finds it. Guarded: refuses while a later body than this migration's is live.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE problems text[] := '{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_cite(uuid,jsonb)', ARRAY['44b8faee5207fa4a4604dbcb25cbfc12', 'cefd4fe399725489eeb3d67705e951c6']),
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', ARRAY['af976e59b8e6f35612d6383042d6e38e', 'ae35dea41a3c51b6afe29366cc496823']),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', ARRAY['6da1007ff2a6331219f4d98f85749ca7', '63c8d04b7fcba89a7bf5519581601298'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_same_payer_close_down_mismatch: %; a later body is live, roll it back first', array_to_string(problems, '; ');
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_ledger_cite(p_job_id uuid, p_cite jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_table text; v_id uuid; v_excerpt text; v_norm text; e public.business_events; v_text text; v_at timestamptz;
 v_cmail text; v_job uuid; v_found boolean; i record; v_ours boolean := false; v_customer boolean := false;
 v_call_note boolean := false; v_internal boolean := false; v_record boolean := false; v_worded boolean := false;
 v_subject text; v_body text; v_close_at timestamptz; v_automated boolean := false; v_made_at timestamptz; v_paid_at timestamptz;
 v_job_created timestamptz; v_repeat boolean; v_kind text; v_doc text; v_crm_at timestamptz;
BEGIN
 IF p_cite IS NULL OR jsonb_typeof(p_cite) <> 'object'
  OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_cite) k WHERE k NOT IN ('table', 'id', 'excerpt'))
  OR jsonb_typeof(p_cite -> 'table') IS DISTINCT FROM 'string' OR jsonb_typeof(p_cite -> 'id') IS DISTINCT FROM 'string'
  OR coalesce(jsonb_typeof(p_cite -> 'excerpt'), 'null') NOT IN ('string', 'null') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_shape', 'detail', 'a citation is {table, id, excerpt}');
 END IF;
 v_table := p_cite ->> 'table';
 IF v_table NOT IN ('business_events','inbox_events','job_documents','xero_invoices','job_assignments','job_events','email_events') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_table_not_allowed', 'detail', left(v_table, 40));
 END IF;
 IF (p_cite ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_shape', 'detail', 'id is not a uuid');
 END IF;
 v_id := (p_cite ->> 'id')::uuid;
 v_excerpt := p_cite ->> 'excerpt';
 v_norm := public.context_ledger_text_norm(v_excerpt);
 IF length(v_norm) > 400 THEN RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_long', 'detail', v_table || ':' || v_id); END IF;
 IF v_table = 'business_events' THEN
  SELECT * INTO e FROM public.business_events b WHERE b.id = v_id;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  IF e.job_id IS DISTINCT FROM p_job_id THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id); END IF;
  -- the same admission as the evidence: linked, not retracted, our own writer,
  -- worded, a message (never a status-only or record-kind row)
  IF NOT public.context_ledger_row_admissible(e) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id);
  END IF;
  v_body := public.context_story_message_text(e);
  v_worded := btrim(v_body) <> '';
  v_subject := nullif(btrim(e.payload ->> 'subject'), '');
  v_text := concat_ws(' ', v_subject, v_body);
  v_at := coalesce(e.event_at, e.occurred_at);
  -- a CRM text loaded later from the CRM's cache is at the CRM's own time, as the evidence
  -- times it; one the CRM dates more than 30 days before the job was created is not this
  -- job's evidence (the evidence leaves it out), so it is not cited (story safety, 20261006040000),
  -- nor one whose CRM time is no longer known (sixth review: the evidence leaves it out too)
  IF e.source = 'ghl_sms_cache_backfill' THEN
   v_crm_at := public.context_job_record_crm_time(e.source, e.contact_id,
    coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id);
   IF v_crm_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible',
     'detail', v_table || ':' || v_id || ' was loaded from the CRM''s cache and its CRM time is no longer kept');
   END IF;
   IF v_crm_at < (SELECT jb.created_at FROM public.jobs jb WHERE jb.id = p_job_id) - interval '30 days' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible',
     'detail', v_table || ':' || v_id || ' is dated by the CRM more than 30 days before the job was created');
   END IF;
   v_at := v_crm_at;
  END IF;
  IF e.event_type = 'call.transcript_completed' THEN
   -- A transcript holds both sides' words: it counts as the customer's only on
   -- its call's stamp (the job's customer was the other party on that call).
   v_customer := coalesce(public.context_ledger_call_customer(e), false);
  ELSE
   v_customer := (e.metadata #>> '{party_roles,sender_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer')
    OR (NOT coalesce(e.metadata ? 'party_roles', false) AND e.event_type LIKE 'client.%' AND e.direction = 'inbound');
  END IF;
  v_automated := coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other';
  v_ours := public.context_event_is_ours(e);
  v_call_note := e.channel IN ('call', 'note') OR e.event_type IN ('call.transcript_completed', 'client.call_logged', 'note.added', 'ghl.internal_comment');
  v_internal := e.channel IN ('sms', 'email') AND (public.context_internal_text_role(e) <> 'other'
   OR coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') = 'internal');
 ELSIF v_table = 'inbox_events' THEN
  SELECT lower(nullif(btrim(jb.client_email), '')), jb.created_at, (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
    OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id))
  INTO v_cmail, v_job_created, v_repeat FROM public.jobs jb WHERE jb.id = p_job_id;
  SELECT x.id, x.job_id, x.from_email, x.subject, x.body_preview, x.received_at, x.graph_message_id, x.classification INTO i
  FROM public.inbox_events x WHERE x.id = v_id;
  IF i.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  IF NOT (i.job_id IS NOT DISTINCT FROM p_job_id OR (i.job_id IS NULL AND v_cmail IS NOT NULL AND lower(btrim(i.from_email)) = v_cmail)) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id);
  END IF;
  -- Unplaced mail as the evidence admits it: never when the client has another
  -- job (it may be that job's), never from before 30 days ahead of the job.
  IF i.job_id IS NULL AND (coalesce(v_repeat, false) OR i.received_at < v_job_created - interval '30 days') THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible',
    'detail', v_table || ':' || v_id || ' is placed on no job and ' || CASE WHEN coalesce(v_repeat, false)
     THEN 'the client has another job' ELSE 'is older than 30 days before the job' END);
  END IF;
  -- Same admission as the evidence: a mail with a business_events copy is cited by its copy.
  IF i.received_at IS NULL OR coalesce(i.classification, '') IN ('spam', 'newsletter')
   OR coalesce(i.subject, '') ~* '^(automatic reply|auto[- ]?reply|out of office)'
   OR btrim(coalesce(i.subject, '') || coalesce(i.body_preview, '')) = ''
   -- (a copy counts on this job, and (seventh review) on another live job, which decides where
   -- the mail belongs, as the evidence reads it; never one unplaced or on a job that is not live,
   -- eighth review: the judge's live set: story safety, 20261006040000)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = i.id::text
    AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE i.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || i.graph_message_id
    AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', i.id::text)
    AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) = i.received_at
    AND lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = lower(btrim(i.from_email)) AND b.job_id = p_job_id) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id);
  END IF;
  v_subject := nullif(btrim(i.subject), ''); v_body := i.body_preview;
  v_text := concat_ws(' ', v_subject, v_body);
  v_worded := btrim(coalesce(v_text, '')) <> '';
  v_at := i.received_at;
  v_customer := v_cmail IS NOT NULL AND lower(btrim(i.from_email)) = v_cmail;
  v_ours := lower(coalesce(i.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$';
 ELSE
  -- A record row: on this job; its time is when the record was made or sent.
  v_record := true; v_ours := true;
  -- v_close_at: when the record can close an item; null when it cannot (a
  -- document never sent, an invoice not issued, a booking nobody attended)
  IF v_table = 'job_documents' THEN
   SELECT d.job_id, coalesce(d.sent_at, d.created_at), d.sent_at, d.id::text, true INTO v_job, v_at, v_close_at, v_doc, v_found
   FROM public.job_documents d WHERE d.id = v_id;
  ELSIF v_table = 'xero_invoices' THEN
   -- paid_at: a payment item closes only on a PAID invoice, at its paid day (Perth
   -- midnight, as the timeline's paid line), never after now; an issued invoice
   -- not yet paid never closes a payment
   SELECT x.job_id, coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at),
    CASE WHEN upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID')
         THEN coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) END,
    CASE WHEN upper(coalesce(x.status, '')) = 'PAID' AND x.fully_paid_on IS NOT NULL
         THEN least((x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth'), now()) END, true
   INTO v_job, v_at, v_close_at, v_paid_at, v_found FROM public.xero_invoices x WHERE x.id = v_id;
  ELSIF v_table = 'job_assignments' THEN
   -- a booking closes on attendance: completed_at, else started_at, else a
   -- status-only completion at the end of its booked Perth day, or at this
   -- write's now while that is still ahead (never a close in the future); it is made
   -- (booking_made) while it stands, at its created time. Crew planning's
   -- confirmation is never read; an observer's mirror is never a booking.
   SELECT a.job_id, a.created_at,
    CASE WHEN coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' THEN NULL
         ELSE coalesce(a.completed_at, a.started_at,
          CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
               THEN least(((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END) END,
    CASE WHEN NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')
          AND lower(coalesce(a.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined') THEN a.created_at END,
    true INTO v_job, v_at, v_close_at, v_made_at, v_found
   FROM public.job_assignments a WHERE a.id = v_id;
  ELSIF v_table = 'job_events' THEN
   -- an app event closes only what it records (context_ledger_job_event_closes, by kind)
   SELECT je.job_id, je.created_at, je.created_at, je.event_type, nullif(btrim(je.detail_json ->> 'document_id'), ''), true
   INTO v_job, v_at, v_close_at, v_kind, v_doc, v_found
   FROM public.job_events je WHERE je.id = v_id;
  ELSE
   -- a system email closes only once it went out: sent, delivered or accepted with
   -- a sent time, timed then (a bounced, failed or queued email never closes)
   SELECT ee.job_id, coalesce(ee.sent_at, ee.created_at),
    CASE WHEN lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') THEN ee.sent_at END, ee.email_type, true
   INTO v_job, v_at, v_close_at, v_kind, v_found
   FROM public.email_events ee WHERE ee.id = v_id;
  END IF;
  IF NOT coalesce(v_found, false) THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  -- A document our system emailed (a quote, an invoice) reached the customer only
  -- when one of its emails went out (sent, delivered or accepted, with a sent
  -- time). The document and its app event ("quote sent", written when the send
  -- was tried) close no earlier than the first such email, and never while every
  -- one bounced or failed. A document with no system email keeps its own time,
  -- and one the customer viewed, accepted or declined plainly reached them.
  IF v_doc IS NOT NULL AND v_close_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = v_doc)
   AND NOT EXISTS (SELECT 1 FROM public.job_documents d WHERE d.id::text = v_doc
     AND (d.viewed_at IS NOT NULL OR d.accepted_at IS NOT NULL OR d.declined_at IS NOT NULL)) THEN
   v_close_at := greatest(v_close_at, (SELECT min(ee.sent_at) FROM public.email_events ee
    WHERE ee.metadata ->> 'document_id' = v_doc
     AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL));
   IF NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = v_doc
     AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL) THEN
    v_close_at := NULL;
   END IF;
  END IF;
  IF v_job IS DISTINCT FROM p_job_id THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id); END IF;
  IF v_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id); END IF;
 END IF;
 IF NOT v_record THEN
  v_close_at := v_at;
  IF v_worded AND v_norm = '' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_required', 'detail', v_table || ':' || v_id);
  END IF;
  IF v_norm <> '' AND position(v_norm IN public.context_ledger_text_norm(v_text)) = 0 THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_not_verbatim', 'detail', v_table || ':' || v_id);
  END IF;
  -- A quote is at least 12 characters or 3 words, unless it is the whole row
  -- (or its whole subject or body) because the row is shorter.
  IF v_norm <> '' AND length(v_norm) < 12 AND coalesce(array_length(regexp_split_to_array(v_norm, '\s+'), 1), 0) < 3
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_text)
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_body)
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_subject) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_short', 'detail', v_table || ':' || v_id);
  END IF;
 END IF;
 RETURN jsonb_build_object('ok', true, 'cite', jsonb_build_object('table', v_table, 'id', v_id::text, 'excerpt', v_excerpt),
  'at', v_at, 'close_at', v_close_at, 'made_at', v_made_at, 'paid_at', v_paid_at, 'kind', v_kind, 'customer_sender', v_customer, 'ours', v_ours, 'call_or_note', v_call_note,
  'internal_text', v_internal, 'record', v_record, 'worded', v_worded, 'automated', v_automated);
END $function$;
COMMENT ON FUNCTION public.context_ledger_cite(uuid, jsonb) IS
 'Context ledger store (20261006013000), story safety (20261006040000): an inbox_events mail is refused for a business_events copy only when the copy is on this job or (seventh review) on another live job, which decides where the mail belongs (as the evidence reads it; eighth review: live is the judge''s live set, never archived, complete, completed, cancelled, lost, a draft or holding), so every mail citation accepted before is still accepted and a mail whose copy sits unplaced or on a job that is not live (a bucket) can now be cited. A CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the evidence times it), and one the CRM dates more than 30 days before the job was created is refused (citation_not_admissible), as the evidence leaves it out; (sixth review) so is one whose CRM time is no longer kept (neither in context_crm_message_times nor the cache). Earlier: checks one {table, id, excerpt} citation for a job: an allowed table; a business_events row on this job that is ledger evidence (context_ledger_row_admissible: linked, not retracted, written as service_role, worded, a message); a call transcript counts as the customer''s only when its call (ghl:<id>) is stamped with the job''s customer; an inbox_events mail placed on the job, or from the client''s address and placed on no job when the client has no other job and the mail is from 30 days before the job on, with no business_events copy; a record row (job_documents, xero_invoices, job_assignments, job_events, email_events) on this job. A worded evidence row needs an excerpt that, quotes straightened and whitespace collapsed, is in its subject and text, and is at least 12 characters or 3 words unless it is the whole row, subject or body. close_at: when the row can close an item (a worded row: its time; a document: sent_at; an invoice: only AUTHORISED, SUBMITTED or PAID, and a payment only PAID, at its paid day (paid_at); a booking: attendance, completed_at, else started_at, else a status-only completion at the end of its booked Perth day or, while that is ahead, now; a system email (email_events): only sent, delivered or accepted with a sent time, at sent_at; an app event (job_events): its time, closing only the matter it records (context_ledger_job_event_closes on kind); a document our system emailed (job_documents, or a job_events row naming its document_id): no earlier than its first email sent, delivered or accepted with a sent time, never while every one bounced or failed; a system email closes only its own matter (context_ledger_email_closes on kind); null when it cannot); kind: an app event''s event_type or a system email''s email_type; made_at: a standing booking''s created time (it closes a booking_made item; not standing = cancelled, deleted, draft, disputed, declined). Refusal codes citation_shape, citation_table_not_allowed, citation_missing, citation_off_job, citation_not_admissible, excerpt_required, excerpt_not_verbatim, excerpt_too_long, excerpt_too_short. Service role only. Story card causes (20261014120000): a placed admissible message may quote its labelled forwarded correspondence, the same text the evidence reader receives; no placement or close-time rule changes.';

CREATE OR REPLACE FUNCTION public.context_ledger_check_item(p_job_id uuid, p_item jsonb, p_writer text, p_person uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_type text; v_status text; v_from text; v_to text; v_what text; v_about text; v_due date; v_basis text;
 v_open jsonb := '[]'; v_close jsonb := '[]'; c jsonb; chk jsonb; n integer := 0; v_opened_at timestamptz; v_closed_at timestamptz;
 v_any_customer boolean := false; v_any_us boolean := false; v_any_external boolean := false; v_due_ok boolean := false;
 v_first_customer boolean; v_first_us boolean; v_close_at timestamptz;
 v_key text; v_first text; v_facts jsonb := '[]'; f jsonb; v_supported date;
 v_cfacts jsonb := '[]'; v_reason text; v_someone integer := 0;
 v_hchk jsonb; v_held boolean := false; v_held_first boolean := false;
 roles constant text[] := ARRAY['us','crew','customer','supplier','insurer_builder','third_party','unknown'];
BEGIN
 IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'an item is a JSON object');
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'unknown field '
   || (SELECT min(k COLLATE "C") FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')));
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each(p_item) kv WHERE kv.key NOT IN ('opened_by','closed_by','needs_reply')
   AND jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'text fields must be strings or null');
 END IF;
 v_type := p_item ->> 'item_type'; v_status := p_item ->> 'status'; v_from := p_item ->> 'from_role';
 v_to := nullif(p_item ->> 'to_role', '');
 -- the ledger's own words carry no em or en dashes (they reach outbound text)
 v_what := btrim(replace(regexp_replace(coalesce(p_item ->> 'what', ''), '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-'));
 v_about := nullif(btrim(p_item ->> 'about_key'), ''); v_basis := coalesce(nullif(p_item ->> 'due_basis', ''), 'none');
 IF p_writer = 'model' AND coalesce(length(btrim(p_item ->> 'ref')), 0) NOT BETWEEN 1 AND 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'ref is 1 to 60 characters');
 END IF;
 IF v_type IS NULL OR v_type NOT IN ('commitment','request','claim','issue','constraint','dependency','agreement','event','phase_note') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'item_type');
 END IF;
 IF v_status IS NULL OR v_status NOT IN ('open','closed','declined','superseded','info')
  OR (v_type IN ('event','phase_note') AND v_status <> 'info')
  OR (v_type NOT IN ('event','phase_note','agreement') AND v_status = 'info')
  OR (p_writer = 'person' AND v_status NOT IN ('open','info')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'status ' || coalesce(v_status, 'null') || ' for ' || v_type);
 END IF;
 IF v_from IS NULL OR NOT v_from = ANY(roles) OR (v_to IS NOT NULL AND NOT v_to = ANY(roles)) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'from_role or to_role');
 END IF;
 IF length(v_what) NOT BETWEEN 1 AND 600 OR length(coalesce(p_item ->> 'from_name', '')) > 120
  OR length(coalesce(p_item ->> 'to_name', '')) > 120 OR length(coalesce(p_item ->> 'also_concerns', '')) > 200 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'what 1 to 600, names up to 120, also_concerns up to 200');
 END IF;
 IF v_about IS NOT NULL AND v_about !~ '^(invoice|quote|booking|payment|variation|materials|scope|access|preference|defect|approval|contact|other):[a-z0-9]+(-[a-z0-9]+){0,4}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'about_key ' || left(v_about, 60));
 END IF;
 IF v_about LIKE 'booking:%' AND v_about !~ '^booking:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'booking about_key is booking:yyyy-mm-dd');
 END IF;
 IF (p_item ->> 'modality') IS NOT NULL AND (p_item ->> 'modality') NOT IN ('requested','offered','agreed','declined','reported','confirmed')
  OR (v_type = 'agreement' AND (p_item ->> 'modality') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'modality');
 END IF;
 IF (p_item ->> 'phase') IS NOT NULL AND (p_item ->> 'phase') NOT IN ('enquiry','scope','quote','accepted','deposit','approvals','materials',
   'scheduled','install','complete','invoice','payment','rectification','makesafe','other')
  OR (v_type = 'phase_note' AND (p_item ->> 'phase') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'phase');
 END IF;
 IF (p_item ->> 'closes_on') IS NOT NULL AND (p_item ->> 'closes_on') NOT IN ('reply','call','quote_sent','invoice_issued','payment',
   'booking_made','visit','work_done','record','person','none')
  OR (p_item ->> 'blocks') IS NOT NULL AND (p_item ->> 'blocks') NOT IN ('quote','acceptance','deposit','booking','install','completion','payment','none')
  OR coalesce(jsonb_typeof(p_item -> 'needs_reply'), 'null') NOT IN ('boolean','null')
  OR v_basis NOT IN ('stated','none')
  OR length(coalesce(p_item ->> 'supersedes_key', '')) > 200 OR length(coalesce(p_item ->> 'supersedes_ref', '')) > 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'closes_on, blocks, needs_reply, due_basis or supersedes');
 END IF;
 IF (p_item ->> 'due_date') IS NOT NULL THEN
  IF (p_item ->> 'due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is yyyy-mm-dd');
  END IF;
  BEGIN v_due := (p_item ->> 'due_date')::date;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is not a date'); END;
 END IF;
 IF v_basis = 'stated' AND v_due IS NULL THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_basis stated needs a due_date');
 END IF;
 IF coalesce(jsonb_typeof(p_item -> 'opened_by'), 'null') NOT IN ('array','null')
  OR coalesce(jsonb_typeof(p_item -> 'closed_by'), 'null') NOT IN ('array','null')
  OR jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) > 25
  OR jsonb_array_length(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) > 25 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by and closed_by are arrays of at most 25');
 END IF;
 IF p_writer = 'model' AND jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by needs at least one citation');
 END IF;
 -- Opening citations.
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  -- (held notes, 20261015100000) a message placed on no job, held with this job among its
  -- candidates, may open or support an item here while the switch is on
  -- (context_ledger_held_cite); the item is then marked job not certain. Off, or not such a
  -- message: the citation check's own refusal stands, as before.
  IF NOT (chk ->> 'ok')::boolean AND chk ->> 'code' = 'citation_off_job' AND c ->> 'table' = 'business_events' THEN
   v_hchk := public.context_ledger_held_cite(p_job_id, c);
   IF coalesce(v_hchk ->> 'code', '') <> 'held_not_candidate' THEN chk := v_hchk; END IF;
  END IF;
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'opened_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  IF coalesce((chk ->> 'held')::boolean, false) THEN
   v_held := true;
   IF n = 1 THEN v_held_first := true; END IF;
  END IF;
  v_open := v_open || jsonb_build_array(chk -> 'cite');
  v_facts := v_facts || jsonb_build_array(chk);
  v_opened_at := least(v_opened_at, (chk ->> 'at')::timestamptz);
  IF n = 1 THEN  -- the speaker is whoever sent the first opening citation
   v_first_customer := (chk ->> 'customer_sender')::boolean;
   v_first_us := (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  END IF;
  v_any_customer := v_any_customer OR (chk ->> 'customer_sender')::boolean;
  v_any_us := v_any_us OR (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  v_any_external := v_any_external OR NOT (chk ->> 'internal_text')::boolean;
 END LOOP;
 -- A person's item with no citation cites the person and their note.
 IF jsonb_array_length(v_open) = 0 THEN
  v_open := jsonb_build_array(jsonb_build_object('table', 'person', 'id', p_person::text, 'excerpt', p_note));
  v_opened_at := now();
 END IF;
 n := 0;
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'closed_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  -- Only an issued or sent record closes: no draft invoice, unsent document or
  -- unattended booking; never the opening row itself; a request strictly after it.
  v_close_at := CASE WHEN chk #>> '{cite,table}' = 'job_assignments' AND (p_item ->> 'closes_on') = 'booking_made'
                     THEN (chk ->> 'made_at')::timestamptz
                     WHEN chk #>> '{cite,table}' = 'xero_invoices' AND (p_item ->> 'closes_on') = 'payment'
                     -- (ledger reader fixes, 20261007150000) at the end of its paid Perth day, whatever
                     -- the invoice's date: a request made the day it was paid is closed by it
                     THEN public.context_ledger_paid_close_at((chk ->> 'paid_at')::timestamptz) ELSE (chk ->> 'close_at')::timestamptz END;
  IF chk #>> '{cite,table}' = 'job_events' AND NOT public.context_ledger_job_event_closes(chk ->> 'kind', p_item ->> 'closes_on') THEN
   v_close_at := NULL;
  END IF;
  IF chk #>> '{cite,table}' = 'email_events' AND NOT public.context_ledger_email_closes(chk ->> 'kind', p_item ->> 'closes_on') THEN
   v_close_at := NULL;
  END IF;
  IF v_close_at IS NULL THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_not_issued', 'detail', 'closed_by[' || n || '] ' || (chk #>> '{cite,table}'));
  END IF;
  IF v_open @> jsonb_build_array(jsonb_build_object('table', chk #>> '{cite,table}', 'id', chk #>> '{cite,id}')) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_is_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  IF v_close_at < v_opened_at OR (v_type = 'request' AND v_close_at <= v_opened_at) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_before_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  v_close := v_close || jsonb_build_array(chk -> 'cite');
  v_cfacts := v_cfacts || jsonb_build_array(chk);
  v_closed_at := greatest(v_closed_at, v_close_at);
 END LOOP;
 IF v_status IN ('closed','declined') AND jsonb_array_length(v_close) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_without_evidence', 'detail', v_status || ' needs closed_by');
 END IF;
 IF v_status IN ('open','info') AND jsonb_array_length(v_close) > 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_by_on_open', 'detail', v_status || ' cannot carry closed_by');
 END IF;
 -- (held notes, 20261015100000) a held message (job not certain) opens or supports only an
 -- open item: what is owed. It never closes one (the closing citations above refuse it).
 IF v_held AND v_status <> 'open' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'held_not_open',
   'detail', 'a message held on no job (job not certain) may open or support only an open item');
 END IF;
 -- Who said it (the model only; a person's own item is their word).
 IF p_writer = 'model' THEN
  IF v_from = 'customer' AND NOT coalesce(v_first_customer, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_customer', 'detail', 'the first opening citation was not sent by this job''s customer');
  END IF;
  IF v_from = 'us' AND NOT coalesce(v_first_us, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_us', 'detail', 'the first opening citation is not ours, a call, a note or a record');
  END IF;
  IF v_to = 'customer' AND NOT v_any_external THEN
   RETURN jsonb_build_object('ok', false, 'code', 'internal_to_customer', 'detail', 'every opening citation is a crew or staff internal text');
  END IF;
  -- (ledger reader fixes, 20261007150000) An item whose words say a row is someone else's (its
  -- sender, caller or counterpart another person than this job's customer, or a label saying so:
  -- context_ledger_elsewhere_claim) stands only when no cited row, opening or closing, is this job's
  -- customer's own words, every cited row that is not a record or our own text, email or note (a
  -- call transcript holds both sides' words, so it is never ours alone) is someone else's by its own
  -- stamp (context_ledger_row_elsewhere: role_basis or call_not_customer), and at least one is: never
  -- on the reader's word or an extra citation, so the customer's own call is never put on someone
  -- else; a placement reason (call_on_other_job, names_other_job) names no person. A claim that a
  -- row concerns or belongs to another job is the reader's placement judgement (second review, 8 Oct).
  IF public.context_ledger_elsewhere_claim(v_what) THEN
   FOR f IN SELECT x FROM jsonb_array_elements(v_facts || v_cfacts) x LOOP
    IF coalesce((f ->> 'customer_sender')::boolean, false) THEN
     RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported', 'detail', 'what says a row is someone else''s; '
      || (f #>> '{cite,table}') || ':' || (f #>> '{cite,id}') || ' is this job''s customer''s own words');
    END IF;
    v_reason := public.context_ledger_row_elsewhere(p_job_id, f #>> '{cite,table}', (f #>> '{cite,id}')::uuid);
    IF starts_with(coalesce(v_reason, ''), 'role_basis:') OR v_reason = 'call_not_customer' THEN
     v_someone := v_someone + 1;
    ELSIF NOT (coalesce((f ->> 'record')::boolean, false)
      OR (coalesce((f ->> 'ours')::boolean, false) AND NOT EXISTS (SELECT 1 FROM public.business_events b
       WHERE f #>> '{cite,table}' = 'business_events' AND b.id = (f #>> '{cite,id}')::uuid AND b.event_type = 'call.transcript_completed'))) THEN
     RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported', 'detail', 'what says a row is someone else''s; the stamp of '
      || (f #>> '{cite,table}') || ':' || (f #>> '{cite,id}') || ' names no one else');
    END IF;
   END LOOP;
   IF v_someone = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported',
     'detail', 'what says a row is someone else''s; no cited row''s own stamp names another job''s customer or party or a lead');
   END IF;
  END IF;
 END IF;
 -- A due date only when an opening excerpt states it.
 IF v_due IS NOT NULL THEN
  FOR f IN SELECT x FROM jsonb_array_elements(v_facts) x LOOP
   IF NOT (f ->> 'record')::boolean AND NOT coalesce((f ->> 'automated')::boolean, false) AND coalesce(f #>> '{cite,excerpt}', '') <> '' THEN
    BEGIN
     v_supported := public.context_supported_due_date(f #>> '{cite,excerpt}', (f ->> 'at')::timestamptz);
    EXCEPTION WHEN OTHERS THEN v_supported := NULL;
    END;
    IF v_supported = v_due THEN v_due_ok := true; END IF;
   END IF;
  END LOOP;
  IF NOT v_due_ok OR v_basis <> 'stated' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'due_date_unsupported', 'detail', 'no opening excerpt states ' || v_due);
  END IF;
 END IF;
 v_first := v_open -> 0 ->> 'id';
 -- (held notes, 20261015100000) an item first opened by a held message is keyed by that message
 -- alone, so one held message opens at most one item of a type and matter on a job, whatever its
 -- words (a second is refused duplicate_item); every other item is keyed as before
 v_key := v_type || ':' || coalesce(v_about, 'none') || ':'
  || left(md5(CASE WHEN v_held_first THEN 'held:' || v_first ELSE v_first || lower(v_what) END), 12);
 RETURN jsonb_build_object('ok', true, 'item', jsonb_build_object('ref', p_item ->> 'ref', 'item_key', v_key, 'item_type', v_type,
  'status', v_status, 'from_role', v_from, 'from_name', nullif(btrim(p_item ->> 'from_name'), ''), 'to_role', v_to,
  'to_name', nullif(btrim(p_item ->> 'to_name'), ''), 'what', v_what, 'about_key', v_about, 'modality', p_item ->> 'modality',
  'phase', p_item ->> 'phase', 'due_date', v_due, 'due_basis', v_basis, 'opened_at', v_opened_at, 'opened_by', v_open,
  -- never a close time still to come (a record dated ahead closes at the check)
  'closed_at', CASE WHEN v_closed_at > now() THEN now() ELSE v_closed_at END, 'closed_by', CASE WHEN jsonb_array_length(v_close) > 0 THEN v_close END,
  'closes_on', p_item ->> 'closes_on', 'supersedes_key', nullif(btrim(p_item ->> 'supersedes_key'), ''),
  'supersedes_ref', nullif(btrim(p_item ->> 'supersedes_ref'), ''), 'blocks', p_item ->> 'blocks',
  'needs_reply', CASE WHEN jsonb_typeof(p_item -> 'needs_reply') = 'boolean' THEN (p_item ->> 'needs_reply')::boolean END, 'also_concerns', nullif(btrim(p_item ->> 'also_concerns'), ''))
  -- (held notes) only on an item a held message opened or supports
  || CASE WHEN v_held THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END);
END $function$;
COMMENT ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a model item whose words say a row is someone else''s (its sender, caller or counterpart another person than this job''s customer, or a label saying so: context_ledger_elsewhere_claim) is refused elsewhere_unsupported when a cited row, opening or closing, is this job''s customer''s own words (customer_sender), when a cited row that is not a record or our own text, email or note (a call transcript never counts as ours alone) is not someone else''s by its own stamp (context_ledger_row_elsewhere: role_basis or call_not_customer), or when none is; a claim that a row concerns or belongs to another job is the reader''s placement judgement and stands (second review, 8 Oct); a person''s own item is their word. A PAID invoice closes a payment item (closes_on payment) at the end of its paid Perth day, never after now (context_ledger_paid_close_at), whatever the invoice''s date, so a request made the day it was paid is closed by it. Earlier: checks one ledger item for a job and returns the row to insert or {ok false, code, detail}. Shape (types, roles, about_key vocabulary, modality, phase, status per type), every citation (context_ledger_cite), closed or declined needs closed_by and nothing open carries it; a closing citation must be able to close (close_at: no draft invoice, unsent document or unattended booking: closing_not_issued), may not be an opening citation (closing_is_opening) and is at or after the opening, strictly after for a request (closing_before_opening); speaker rules for the model on the first opening citation (customer: the job''s customer sent it; us: ours, a call, a note or a record; nothing only internal texts is to the customer), a due date only when an opening excerpt states it and that message is not automated (context_supported_due_date); what has em and en dashes replaced. opened_at and closed_at come from the cited rows, never the input, and closed_at is never later than now. item_key = type:about:first 12 hex of md5(first opening citation id || lower(what)). Service role only. Held notes (20261015100000): while feature_flags.context_held_notes_v1 is on, an opening citation the citation check refuses as off the job may instead be a message held on no job with this job among its candidates (context_ledger_held_cite); the item is then marked job not certain (job_certain false, certainty job_not_certain in the returned item; the store stamps context_ledger_items.job_not_certain), must be open (held_not_open otherwise), and, when the held message is its first opening citation, is keyed by that message alone (type:about:first 12 hex of md5(''held:'' || its id)), so one held message opens at most one item of a type and matter on a job (a second is refused duplicate_item by the write). A held message never closes an item. Off: every check is as before.';

CREATE OR REPLACE FUNCTION public.context_ledger_write(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_items jsonb, p_transitions jsonb, p_reader text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; v_items jsonb := coalesce(p_items, '[]'::jsonb);
 v_trans jsonb := coalesce(p_transitions, '[]'::jsonb); v_hash text; v_prior jsonb; v_by text; it jsonb; chk jsonb;
 cands jsonb[] := '{}'; refused jsonb := '[]'::jsonb; accepted jsonb := '[]'::jsonb; t_refused jsonb := '[]'::jsonb;
 t_accepted integer := 0; k integer; m integer; v_changed boolean; v_cand jsonb; v_other jsonb; v_key text; v_found boolean;
 v_rep_at timestamptz; v_result jsonb; refs text[] := '{}'; keys text[] := '{}'; v_id uuid; tr jsonb; li public.context_ledger_items;
 v_ev jsonb; v_ev_at timestamptz; v_code text; v_detail text; c jsonb; n integer; v_ok boolean;
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_generation_id IS NULL
  OR jsonb_typeof(v_items) <> 'array' OR jsonb_typeof(v_trans) <> 'array'
  OR jsonb_array_length(v_items) > 200 OR jsonb_array_length(v_trans) > 200
  OR p_reader IS NULL OR p_reader !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' THEN
  RAISE EXCEPTION 'context_ledger_write_invalid';
 END IF;
 v_by := 'model:' || p_reader;
 v_hash := encode(sha256(convert_to(jsonb_build_array(p_generation_id, v_items, v_trans, p_reader)::text, 'UTF8')), 'hex');
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = p_run_id FOR UPDATE;
 IF r.id IS NULL OR r.phase <> 'ledger' THEN RAISE EXCEPTION 'context_ledger_write_invalid'; END IF;
 -- A repeated request in the same run gets its first answer back, unchanged.
 SELECT w.result INTO v_prior FROM public.context_ledger_writes w WHERE w.run_id = p_run_id AND w.request_sha256 = v_hash;
 IF v_prior IS NOT NULL THEN RETURN v_prior || jsonb_build_object('replayed', true); END IF;
 IF r.lease_token IS DISTINCT FROM p_lease_token OR r.status <> 'running' OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 IF NOT public.automation_lane_enabled('extraction')
  OR coalesce((SELECT st.mode FROM public.context_ledger_settings st WHERE st.id), 'off') = 'off' THEN
  RETURN jsonb_build_object('outcome', 'off');
 END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = p_generation_id FOR UPDATE;
 IF g.id IS NULL OR g.job_id IS DISTINCT FROM r.job_id
  OR NOT ((g.status = 'building' AND g.run_id = p_run_id)
   OR (g.id = public.context_ledger_current_generation(r.job_id)
    AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations b WHERE b.run_id = p_run_id))) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch');
 END IF;
 IF g.reader <> p_reader THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reader_mismatch'); END IF;
 SELECT coalesce(array_agg(i.item_key), '{}') INTO keys FROM public.context_ledger_items i WHERE i.generation_id = g.id;

 -- Pass 1: each item on its own.
 FOR it IN SELECT x FROM jsonb_array_elements(v_items) x LOOP
  chk := public.context_ledger_check_item(r.job_id, it, 'model');
  IF NOT (chk ->> 'ok')::boolean THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', it ->> 'ref', 'code', chk ->> 'code', 'detail', chk ->> 'detail'));
   CONTINUE;
  END IF;
  v_cand := chk -> 'item';
  -- A person's correction stands: the model may not write the same matter (same
  -- type, same first opening citation) again, in an update or a rebuild.
  IF EXISTS (SELECT 1 FROM public.context_ledger_items pl JOIN public.context_ledger_generations pg ON pg.id = pl.generation_id
             WHERE pl.job_id = g.job_id AND pl.person_locked AND (pl.generation_id = g.id OR pg.status = 'live')
               AND pl.item_type = v_cand ->> 'item_type'
               AND pl.opened_by -> 0 ->> 'table' = v_cand -> 'opened_by' -> 0 ->> 'table'
               AND pl.opened_by -> 0 ->> 'id' = v_cand -> 'opened_by' -> 0 ->> 'id') THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'person_locked',
    'detail', 'a person corrected this matter'));
   CONTINUE;
  END IF;
  IF (v_cand ->> 'ref') = ANY(refs) THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'duplicate_ref', 'detail', 'ref used twice in one write'));
   CONTINUE;
  END IF;
  refs := refs || (v_cand ->> 'ref');
  IF (v_cand ->> 'item_key') = ANY(keys) THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'duplicate_item', 'detail', v_cand ->> 'item_key'));
   CONTINUE;
  END IF;
  keys := keys || (v_cand ->> 'item_key');
  cands := cands || v_cand;
 END LOOP;

 -- Pass 2: supersedes_ref names an item of this write.
 FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
  IF cands[k] ->> 'supersedes_ref' IS NOT NULL THEN
   v_key := NULL;
   FOR m IN 1 .. array_length(cands, 1) LOOP
    IF m <> k AND cands[m] ->> 'ref' = cands[k] ->> 'supersedes_ref' THEN v_key := cands[m] ->> 'item_key'; END IF;
   END LOOP;
   IF v_key IS NULL OR (cands[k] ->> 'supersedes_key' IS NOT NULL AND cands[k] ->> 'supersedes_key' <> v_key) THEN
    cands[k] := cands[k] || jsonb_build_object('refused', 'supersedes_unresolved');
   ELSE
    cands[k] := cands[k] || jsonb_build_object('supersedes_key', v_key);
   END IF;
  END IF;
 END LOOP;
 -- Pass 3, to a fixed point: a supersedes_key names an existing or accepted
 -- item; a superseded item has an accepted or existing replacement.
 LOOP
  v_changed := false;
  FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
   CONTINUE WHEN cands[k] ? 'refused';
   IF cands[k] ->> 'supersedes_key' IS NOT NULL THEN
    v_found := EXISTS (SELECT 1 FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = cands[k] ->> 'supersedes_key');
    FOR m IN 1 .. array_length(cands, 1) LOOP
     IF m <> k AND NOT cands[m] ? 'refused' AND cands[m] ->> 'item_key' = cands[k] ->> 'supersedes_key' THEN v_found := true; END IF;
    END LOOP;
    IF NOT v_found THEN cands[k] := cands[k] || jsonb_build_object('refused', 'supersedes_unresolved'); v_changed := true; CONTINUE; END IF;
   END IF;
   IF cands[k] ->> 'status' = 'superseded' THEN
    v_rep_at := NULL;
    SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i
    WHERE i.generation_id = g.id AND i.supersedes_key = cands[k] ->> 'item_key';
    FOR m IN 1 .. array_length(cands, 1) LOOP
     IF m <> k AND NOT cands[m] ? 'refused' AND cands[m] ->> 'supersedes_key' = cands[k] ->> 'item_key' THEN
      v_rep_at := least(v_rep_at, (cands[m] ->> 'opened_at')::timestamptz);
     END IF;
    END LOOP;
    IF v_rep_at IS NULL THEN
     cands[k] := cands[k] || jsonb_build_object('refused', 'superseded_without_replacement'); v_changed := true; CONTINUE;
    END IF;
    IF cands[k] ->> 'closed_at' IS NULL THEN
     IF v_rep_at < (cands[k] ->> 'opened_at')::timestamptz THEN
      cands[k] := cands[k] || jsonb_build_object('refused', 'closing_before_opening'); v_changed := true; CONTINUE;
     END IF;
     cands[k] := cands[k] || jsonb_build_object('closed_at', CASE WHEN v_rep_at > now() THEN now() ELSE v_rep_at END);
    END IF;
   END IF;
  END LOOP;
  EXIT WHEN NOT v_changed;
 END LOOP;

 -- Insert what stands, each item whole or not at all.
 FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
  v_cand := cands[k];
  IF v_cand ? 'refused' THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', v_cand ->> 'refused',
    'detail', coalesce(v_cand ->> 'supersedes_key', v_cand ->> 'supersedes_ref', v_cand ->> 'item_key')));
   CONTINUE;
  END IF;
  BEGIN
   INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, from_name, to_role, to_name,
    what, about_key, modality, phase, due_date, due_basis, opened_at, opened_by, closed_at, closed_by, closes_on, supersedes_key,
    blocks, needs_reply, also_concerns, written_by, person_locked)
   VALUES (g.id, g.job_id, v_cand ->> 'item_key', v_cand ->> 'item_type', v_cand ->> 'status', v_cand ->> 'from_role',
    v_cand ->> 'from_name', v_cand ->> 'to_role', v_cand ->> 'to_name', v_cand ->> 'what', v_cand ->> 'about_key',
    v_cand ->> 'modality', v_cand ->> 'phase', (v_cand ->> 'due_date')::date, v_cand ->> 'due_basis',
    (v_cand ->> 'opened_at')::timestamptz, v_cand -> 'opened_by', (v_cand ->> 'closed_at')::timestamptz,
    CASE WHEN jsonb_typeof(v_cand -> 'closed_by') = 'array' THEN v_cand -> 'closed_by' END, v_cand ->> 'closes_on',
    v_cand ->> 'supersedes_key', v_cand ->> 'blocks', (v_cand ->> 'needs_reply')::boolean, v_cand ->> 'also_concerns', v_by, false)
   RETURNING id INTO v_id;
   INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
   VALUES (v_id, g.id, g.job_id, NULL, v_cand ->> 'status', v_by,
    CASE WHEN v_cand ->> 'status' IN ('closed','declined') THEN v_cand -> 'closed_by' ELSE v_cand -> 'opened_by' END, 'written');
   accepted := accepted || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'item_key', v_cand ->> 'item_key'));
  EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR invalid_text_representation THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'invalid_shape', 'detail', left(SQLERRM, 200)));
  END;
 END LOOP;

 -- Transitions on items of this generation.
 FOR tr IN SELECT x FROM jsonb_array_elements(v_trans) x LOOP
  v_code := NULL; v_detail := NULL; v_ev := '[]'::jsonb; v_ev_at := NULL;
  IF jsonb_typeof(tr) <> 'object'
   OR EXISTS (SELECT 1 FROM jsonb_object_keys(tr) kk WHERE kk NOT IN ('item_key','to_status','evidence','reason'))
   OR jsonb_typeof(tr -> 'item_key') IS DISTINCT FROM 'string'
   OR coalesce(tr ->> 'to_status', '') NOT IN ('open','closed','declined','superseded','disputed')
   OR coalesce(jsonb_typeof(tr -> 'evidence'), 'null') NOT IN ('array','null')
   OR jsonb_array_length(coalesce(nullif(tr -> 'evidence', 'null'::jsonb), '[]')) > 25
   OR coalesce(jsonb_typeof(tr -> 'reason'), 'null') NOT IN ('string','null') OR length(coalesce(tr ->> 'reason', '')) > 600 THEN
   v_code := 'invalid_shape'; v_detail := 'a transition is {item_key, to_status, evidence, reason}';
  END IF;
  IF v_code IS NULL THEN
   SELECT * INTO li FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = tr ->> 'item_key' FOR UPDATE;
   IF li.id IS NULL THEN v_code := 'unknown_item';
   ELSIF li.person_locked THEN v_code := 'person_locked';
   ELSIF li.status = tr ->> 'to_status' THEN v_code := 'no_change';
   END IF;
  END IF;
  IF v_code IS NULL THEN
   n := 0;
   FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(tr -> 'evidence', 'null'::jsonb), '[]')) x LOOP
    n := n + 1;
    chk := public.context_ledger_cite(g.job_id, c);
    IF NOT (chk ->> 'ok')::boolean THEN v_code := chk ->> 'code'; v_detail := 'evidence[' || n || '] ' || coalesce(chk ->> 'detail', ''); EXIT; END IF;
    IF tr ->> 'to_status' IN ('closed', 'declined') THEN
     -- the same closing rules as an item's closed_by (a booking_made item closes on a made booking)
     IF chk #>> '{cite,table}' = 'job_assignments' AND li.closes_on = 'booking_made' THEN
      chk := chk || jsonb_build_object('close_at', chk -> 'made_at');
     END IF;
     IF chk #>> '{cite,table}' = 'xero_invoices' AND li.closes_on = 'payment' THEN
      -- (ledger reader fixes, 20261007150000) at the end of its paid Perth day, as an item's
      chk := chk || jsonb_build_object('close_at', public.context_ledger_paid_close_at((chk ->> 'paid_at')::timestamptz));
     END IF;
     IF chk #>> '{cite,table}' = 'job_events' AND NOT public.context_ledger_job_event_closes(chk ->> 'kind', li.closes_on) THEN
      chk := chk || jsonb_build_object('close_at', NULL::timestamptz);
     END IF;
     IF chk #>> '{cite,table}' = 'email_events' AND NOT public.context_ledger_email_closes(chk ->> 'kind', li.closes_on) THEN
      chk := chk || jsonb_build_object('close_at', NULL::timestamptz);
     END IF;
     IF chk ->> 'close_at' IS NULL THEN v_code := 'closing_not_issued'; v_detail := 'evidence[' || n || '] ' || (chk #>> '{cite,table}'); EXIT; END IF;
     IF li.opened_by @> jsonb_build_array(jsonb_build_object('table', chk #>> '{cite,table}', 'id', chk #>> '{cite,id}')) THEN
      v_code := 'closing_is_opening'; v_detail := 'evidence[' || n || ']'; EXIT;
     END IF;
     IF (chk ->> 'close_at')::timestamptz < li.opened_at OR (li.item_type = 'request' AND (chk ->> 'close_at')::timestamptz <= li.opened_at) THEN
      v_code := 'evidence_older_than_item'; v_detail := 'evidence[' || n || ']'; EXIT;
     END IF;
     v_ev_at := greatest(v_ev_at, (chk ->> 'close_at')::timestamptz);
    ELSE
     IF (chk ->> 'at')::timestamptz < li.opened_at THEN v_code := 'evidence_older_than_item'; v_detail := 'evidence[' || n || ']'; EXIT; END IF;
     v_ev_at := greatest(v_ev_at, (chk ->> 'at')::timestamptz);
    END IF;
    v_ev := v_ev || jsonb_build_array(chk -> 'cite');
   END LOOP;
  END IF;
  IF v_code IS NULL AND tr ->> 'to_status' <> 'superseded' AND jsonb_array_length(v_ev) = 0 THEN
   v_code := 'evidence_missing'; v_detail := tr ->> 'to_status' || ' needs evidence';
  END IF;
  IF v_code IS NULL AND tr ->> 'to_status' = 'superseded' THEN
   SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.supersedes_key = li.item_key;
   IF v_rep_at IS NULL THEN v_code := 'superseded_without_replacement';
   ELSIF coalesce(v_ev_at, v_rep_at) < li.opened_at THEN v_code := 'closing_before_opening';
   ELSE v_ev_at := coalesce(v_ev_at, v_rep_at);
   END IF;
  END IF;
  IF v_code IS NOT NULL THEN
   t_refused := t_refused || jsonb_build_array(jsonb_build_object('item_key', tr ->> 'item_key', 'code', v_code, 'detail', v_detail));
   CONTINUE;
  END IF;
  UPDATE public.context_ledger_items SET status = tr ->> 'to_status',
   closed_at = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') THEN CASE WHEN v_ev_at > now() THEN now() ELSE v_ev_at END END,
   closed_by = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') AND jsonb_array_length(v_ev) > 0 THEN v_ev END,
   updated_at = now()
  WHERE id = li.id;
  INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
  VALUES (li.id, g.id, g.job_id, li.status, tr ->> 'to_status', v_by, CASE WHEN jsonb_array_length(v_ev) > 0 THEN v_ev END, tr ->> 'reason');
  t_accepted := t_accepted + 1;
 END LOOP;

 v_result := jsonb_build_object('outcome', 'written', 'generation_id', g.id, 'accepted', accepted, 'refused', refused,
  'transitions_accepted', t_accepted, 'transitions_refused', t_refused);
 INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused,
  transitions_accepted, transitions_refused, result)
 VALUES (p_run_id, g.id, g.job_id, v_hash, jsonb_array_length(accepted), jsonb_array_length(refused), t_accepted,
  jsonb_array_length(t_refused), v_result);
 UPDATE public.context_ledger_generations SET updated_at = now() WHERE id = g.id;
 RETURN v_result;
END $function$;
COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a transition closing a payment item on a PAID invoice closes it at the end of the invoice''s paid Perth day, never after now (context_ledger_paid_close_at), as an item''s closed_by does; items pass the item check''s new elsewhere_unsupported rule. Earlier: writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only.';

DROP FUNCTION IF EXISTS public.context_ledger_obligation_closes(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_obligated_party(jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_obligation_payer_match(jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_obligation_job_facts(uuid);
DROP FUNCTION IF EXISTS public.context_ledger_invoice_facts(public.xero_invoices);
DROP FUNCTION IF EXISTS public.context_ledger_invoice_payer(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.context_ledger_obligation_class(text, text);
DROP FUNCTION IF EXISTS public.context_ledger_obligation_kind(text, text);
DROP FUNCTION IF EXISTS public.context_ledger_invoice_kind_of(text, text);
DROP FUNCTION IF EXISTS public.context_ledger_same_payer_close_on();
DROP TABLE IF EXISTS public.context_ledger_builder_contacts;
ALTER TABLE public.context_ledger_items DROP CONSTRAINT IF EXISTS context_ledger_items_certainty_check;
ALTER TABLE public.context_ledger_items DROP COLUMN IF EXISTS certainty;
ALTER TABLE public.context_ledger_items DROP COLUMN IF EXISTS obligation_ref;
ALTER TABLE public.context_ledger_items DROP COLUMN IF EXISTS obligated_party;
