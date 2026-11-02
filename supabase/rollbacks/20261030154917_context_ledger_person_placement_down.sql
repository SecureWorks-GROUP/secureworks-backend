-- Restore exact preimages; never delete source or decision records.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE h text;
BEGIN
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure('public.context_ledger_cite(uuid,jsonb)'); IF h IS DISTINCT FROM '158d8e3ed8b26c56a6e71bcd86d7b2a8' THEN RAISE EXCEPTION 'reader_person_placement_rollback_preimage_mismatch: context_ledger_cite(uuid,jsonb)'; END IF;
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure('public.context_ledger_row_elsewhere(uuid,text,uuid)'); IF h IS DISTINCT FROM 'd9b1fb5e99a8aa730898a49c9c75ed56' THEN RAISE EXCEPTION 'reader_person_placement_rollback_preimage_mismatch: context_ledger_row_elsewhere(uuid,text,uuid)'; END IF;
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure('public.context_ledger_held_rows(uuid[],timestamp with time zone)'); IF h IS DISTINCT FROM 'a674d5e0854cc6d6cf54c068eed456fe' THEN RAISE EXCEPTION 'reader_person_placement_rollback_preimage_mismatch: context_ledger_held_rows(uuid[],timestamp with time zone)'; END IF;
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure('public.context_ledger_evidence_rows(uuid[],timestamp with time zone)'); IF h IS DISTINCT FROM '8f061ab0b150dbd505683da5f86bc8b6' THEN RAISE EXCEPTION 'reader_person_placement_rollback_preimage_mismatch: context_ledger_evidence_rows(uuid[],timestamp with time zone)'; END IF;
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
END $function$
;
COMMENT ON FUNCTION public.context_ledger_cite(uuid,jsonb) IS 'Context ledger store (20261006013000), story safety (20261006040000): an inbox_events mail is refused for a business_events copy only when the copy is on this job or (seventh review) on another live job, which decides where the mail belongs (as the evidence reads it; eighth review: live is the judge''s live set, never archived, complete, completed, cancelled, lost, a draft or holding), so every mail citation accepted before is still accepted and a mail whose copy sits unplaced or on a job that is not live (a bucket) can now be cited. A CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the evidence times it), and one the CRM dates more than 30 days before the job was created is refused (citation_not_admissible), as the evidence leaves it out; (sixth review) so is one whose CRM time is no longer kept (neither in context_crm_message_times nor the cache). Earlier: checks one {table, id, excerpt} citation for a job: an allowed table; a business_events row on this job that is ledger evidence (context_ledger_row_admissible: linked, not retracted, written as service_role, worded, a message); a call transcript counts as the customer''s only when its call (ghl:<id>) is stamped with the job''s customer; an inbox_events mail placed on the job, or from the client''s address and placed on no job when the client has no other job and the mail is from 30 days before the job on, with no business_events copy; a record row (job_documents, xero_invoices, job_assignments, job_events, email_events) on this job. A worded evidence row needs an excerpt that, quotes straightened and whitespace collapsed, is in its subject and text, and is at least 12 characters or 3 words unless it is the whole row, subject or body. close_at: when the row can close an item (a worded row: its time; a document: sent_at; an invoice: only AUTHORISED, SUBMITTED or PAID, and a payment only PAID, at its paid day (paid_at); a booking: attendance, completed_at, else started_at, else a status-only completion at the end of its booked Perth day or, while that is ahead, now; a system email (email_events): only sent, delivered or accepted with a sent time, at sent_at; an app event (job_events): its time, closing only the matter it records (context_ledger_job_event_closes on kind); a document our system emailed (job_documents, or a job_events row naming its document_id): no earlier than its first email sent, delivered or accepted with a sent time, never while every one bounced or failed; a system email closes only its own matter (context_ledger_email_closes on kind); null when it cannot); kind: an app event''s event_type or a system email''s email_type; made_at: a standing booking''s created time (it closes a booking_made item; not standing = cancelled, deleted, draft, disputed, declined). Refusal codes citation_shape, citation_table_not_allowed, citation_missing, citation_off_job, citation_not_admissible, excerpt_required, excerpt_not_verbatim, excerpt_too_long, excerpt_too_short. Service role only. Story card causes (20261014120000): a placed admissible message may quote its labelled forwarded correspondence, the same text the evidence reader receives; no placement or close-time rule changes.';
CREATE OR REPLACE FUNCTION public.context_ledger_row_elsewhere(p_job_id uuid, p_table text, p_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e public.business_events; i record; v_cmail text; v_text text; v_basis text; v_call text; v_call_job uuid;
 v_call_basis text; v_other text; v_this boolean;
 -- the stamps naming someone other than this job's customer who is not one of this job's people:
 -- another job's customer or party, or a lead (party roles v2 and v3, and their contact_ forms)
 v_others constant text[] := ARRAY['any_job_customer', 'contact_any_job_customer', 'any_job_party', 'contact_any_job_party',
  'lead', 'contact_lead'];
BEGIN
 IF p_job_id IS NULL OR p_id IS NULL THEN RETURN NULL; END IF;
 IF p_table = 'business_events' THEN
  SELECT * INTO e FROM public.business_events b WHERE b.id = p_id;
  IF e.id IS NULL OR e.job_id IS DISTINCT FROM p_job_id THEN RETURN NULL; END IF;
  v_basis := e.metadata #>> '{party_roles,basis}';
  IF e.event_type = 'call.transcript_completed' THEN
   -- the customer's own call is never someone else's (the citation check's customer_sender)
   IF public.context_ledger_call_customer(e) THEN RETURN NULL; END IF;
   v_call := coalesce(nullif(btrim(e.payload ->> 'ghl_call_id'), ''),
    CASE WHEN e.provider_message_id LIKE 'ghltx:%' THEN substr(e.provider_message_id, 7) END);
   IF v_call IS NOT NULL THEN
    -- its call row (one row holds a provider key): where it sits and whom it is stamped with
    SELECT c.job_id, c.metadata #>> '{party_roles,basis}' INTO v_call_job, v_call_basis FROM public.business_events c
    WHERE c.provider_message_id = 'ghl:' || v_call AND c.event_type <> 'call.transcript_completed';
   END IF;
  ELSIF (e.metadata #>> '{party_roles,sender_role}' = 'customer' AND v_basis = 'job_customer')
     OR (NOT coalesce(e.metadata ? 'party_roles', false) AND e.event_type LIKE 'client.%' AND e.direction = 'inbound') THEN
   RETURN NULL;  -- the customer's own words (the citation check's customer_sender)
  END IF;
  -- its own stamp names another job's customer or party, or a lead
  IF v_basis = ANY(v_others) THEN RETURN 'role_basis:' || v_basis; END IF;
  -- a transcript whose call row on this job is stamped so
  IF v_call_job = p_job_id AND v_call_basis = ANY(v_others) THEN RETURN 'call_not_customer'; END IF;
  -- a transcript whose call row sits on another job
  IF v_call_job IS NOT NULL AND v_call_job <> p_job_id THEN RETURN 'call_on_other_job'; END IF;
  v_text := concat_ws(' ', e.payload ->> 'subject', public.context_event_text(e));
 ELSIF p_table = 'inbox_events' THEN
  SELECT x.from_email, x.subject, x.body_preview INTO i FROM public.inbox_events x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- old-inbox mail from the job's client email is the customer's own; any other is someone else's
  -- only by its own words (its sender is stamped nowhere)
  SELECT lower(nullif(btrim(j.client_email), '')) INTO v_cmail FROM public.jobs j WHERE j.id = p_job_id;
  IF v_cmail IS NOT NULL AND lower(btrim(i.from_email)) = v_cmail THEN RETURN NULL; END IF;
  v_text := concat_ws(' ', i.subject, i.body_preview);
 ELSE
  RETURN NULL;  -- a record row is this job's own record
 END IF;
 -- its own words name another job's reference and none of this job's (the placement keys'
 -- references: job numbers, ACCREC invoice numbers, purchase order numbers; never a holding job)
 SELECT min(rj.job_number COLLATE "C") FILTER (WHERE r.job_id <> p_job_id), coalesce(bool_or(r.job_id = p_job_id), false)
 INTO v_other, v_this
 FROM public.context_ref_jobs(public.context_job_ref_tokens(v_text)) r JOIN public.jobs rj ON rj.id = r.job_id;
 IF v_other IS NOT NULL AND NOT v_this THEN RETURN 'names_other_job:' || left(v_other, 40); END IF;
 RETURN NULL;
END $function$
;
COMMENT ON FUNCTION public.context_ledger_row_elsewhere(uuid,text,uuid) IS 'Ledger reader fixes (20261007150000): whether a row is someone else''s, and why; null when nothing about the row says so. role_basis:<basis> (a business_events row whose own party_roles stamp names another job''s customer or party or a lead: any_job_customer, any_job_party, lead, or their contact_ forms); call_not_customer (a call transcript whose call row on this job is stamped so); call_on_other_job (a call transcript whose call row, ghl:<id>, sits on another job); names_other_job:<job number> (its own words name another job''s reference and none of this job''s, by the placement keys context_job_ref_tokens and context_ref_jobs, C order). Never the customer''s own words (a transcript context_ledger_call_customer calls the customer''s, an inbound row stamped the job''s customer, an unstamped inbound client row, old-inbox mail from the job''s client email); never by a stamp naming our own people, a supplier, a builder, a council, a party on this job or nobody (second review, 8 Oct); old-inbox mail only by its words; a record row, or a business_events row that is not this job''s, never. Only role_basis and call_not_customer name a person: read by context_ledger_check_item (a claim that a row is someone else''s stands only on them: elsewhere_unsupported) and by the packet (each evidence row''s elsewhere). Service role only.';
CREATE OR REPLACE FUNCTION public.context_ledger_evidence_rows(p_job_ids uuid[], p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(job_id uuid, src_table text, src_id uuid, at timestamp with time zone, landed_at timestamp with time zone, channel text, kind text, direction text, sender_role text, recipient_role text, audience text, counterpart_role text, role_basis text, sender text, recipient text, ours boolean, automated boolean, subject text, body text, placed_on text, has_transcript boolean, call_customer boolean, copy_of uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, nullif(btrim(jb.client_name), '') AS cname, jb.created_at,
   -- the client has another job (the same CRM contact or client email)
   (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
    OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)) AS repeat_client
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), be AS (
  SELECT e.job_id, 'business_events'::text AS src_table, e.id AS src_id,
   -- a CRM text loaded later from the CRM's cache is timed by the CRM's own time, as the
   -- story times it (story safety, 20261006040000); it landed when it was loaded
   coalesce(ct.crm_at, e.event_at, e.occurred_at) AS at,
   greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) AS landed_at,
   coalesce(e.channel, CASE WHEN e.event_type LIKE '%email%' THEN 'email' WHEN e.event_type LIKE '%call%' THEN 'call'
    WHEN e.event_type LIKE 'note.%' THEN 'note' ELSE 'sms' END) AS channel,
   e.event_type AS kind, e.direction,
   e.metadata #>> '{party_roles,sender_role}' AS sender_role,
   e.metadata #>> '{party_roles,recipient_role}' AS recipient_role,
   coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') AS audience,
   e.metadata #>> '{party_roles,counterpart_role}' AS counterpart_role,
   e.metadata #>> '{party_roles,basis}' AS role_basis,
   CASE WHEN e.metadata #>> '{party_roles,sender_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer' THEN j.cname
    ELSE coalesce((SELECT s.label FROM public.staff_ghl_users s
      WHERE s.ghl_user_id = coalesce(e.payload ->> 'sent_by_user', e.payload ->> 'by_user') LIMIT 1),
     nullif(btrim(coalesce(e.payload ->> 'from_name', e.payload ->> 'from', e.payload ->> 'from_email')), '')) END AS sender,
   CASE WHEN e.metadata #>> '{party_roles,recipient_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer' THEN j.cname
    ELSE nullif(btrim(coalesce(e.payload ->> 'to_name', e.payload ->> 'to', e.payload ->> 'to_email')), '') END AS recipient,
   public.context_event_is_ours(e) AS ours,
   (coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other') AS automated,
   nullif(btrim(e.payload ->> 'subject'), '') AS subject,
   public.context_story_message_text(e) AS body,
   'this_job'::text AS placed_on,
   -- A call log (not a transcript) says whether its transcript is on the job: the
   -- transcript names the call's GHL message id in payload.ghl_call_id (and in its
   -- key ghltx:<id>); the call row's key is ghl:<id>.
   CASE WHEN e.event_type <> 'call.transcript_completed'
         AND (e.channel = 'call' OR e.event_type IN ('client.call_logged', 'client.call_complete'))
    THEN coalesce(e.provider_message_id LIKE 'ghl:%' AND EXISTS (SELECT 1 FROM public.business_events t
     WHERE t.job_id = e.job_id AND t.event_type = 'call.transcript_completed' AND public.context_linked_status(t.attribution_status)
      AND (t.payload ->> 'ghl_call_id' = substr(e.provider_message_id, 5)
       OR t.provider_message_id = 'ghltx:' || substr(e.provider_message_id, 5))), false) END AS has_transcript,
   -- A transcript says whether its call makes it the customer's words (the cite's rule).
   public.context_ledger_call_customer(e) AS call_customer,
   lower(nullif(btrim(coalesce(e.payload ->> 'from', e.payload ->> 'from_email')), '')) AS sender_key
  FROM j JOIN public.business_events e ON e.job_id = j.id
  CROSS JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                         coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                             END AS crm_at) ct
  WHERE public.context_ledger_row_admissible(e)
   AND coalesce(ct.crm_at, e.event_at, e.occurred_at) <= p_as_of
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= p_as_of
   -- one the CRM dates more than 30 days before the job was created is from before the
   -- job's lead window: the CRM contact may have been another person's then, so it is not
   -- this job's evidence (the story never reads it as the customer's either); nor one whose
   -- CRM time is no longer known (sixth review: it may be from before the lead window, and
   -- its load time is not when it was sent)
   AND NOT coalesce(ct.crm_at < j.created_at - interval '30 days', false)
   AND NOT (e.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL)
 ), inbox_c AS (
  -- Legacy mail placed on the job, or from the client's own address and placed
  -- on no job. Mail the old matcher put on another job stays there: a repeat
  -- customer's mail about one job never enters every job of theirs. Unplaced
  -- mail is evidence only when the client has no other job (else it may be that
  -- job's), from 30 days before the job was created (the record layer's
  -- context_job_record_legacy_mail keeps the same rule).
  SELECT j.id AS job_id, i.id, i.received_at, i.processed_at, i.subject, i.body_preview, i.from_email, i.from_name,
   i.to_email, i.mailbox, i.graph_message_id, i.classification, j.cmail, j.cname, 'this_job'::text AS placed_on
  FROM j JOIN public.inbox_events i ON i.job_id = j.id
  UNION
  SELECT j.id, i.id, i.received_at, i.processed_at, i.subject, i.body_preview, i.from_email, i.from_name,
   i.to_email, i.mailbox, i.graph_message_id, i.classification, j.cmail, j.cname, 'none'::text
  FROM j JOIN public.inbox_events i ON j.cmail IS NOT NULL AND lower(btrim(i.from_email)) = j.cmail AND i.job_id IS NULL
  WHERE NOT j.repeat_client AND i.received_at >= j.created_at - interval '30 days'
 ), email_copy AS MATERIALIZED (
  -- An email row on the same job with the same sender at the same instant is the same mail.
  SELECT DISTINCT b.job_id, coalesce(b.event_at, b.occurred_at) AS at,
   lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) AS sender
  FROM public.business_events b
  WHERE b.channel = 'email' AND b.job_id = ANY(p_job_ids) AND coalesce(b.event_at, b.occurred_at) IN (SELECT ic.received_at FROM inbox_c ic)
 ), copies AS MATERIALIZED (
  -- Each mail's saved copies by where they sit (context_ledger_mail_copies): a mail kept
  -- here although a copy sits on no job or on a job that is not live joined this job's
  -- evidence no earlier than their joined_at (story safety, 20261006040000; eighth review: nor
  -- before that copy left a live job).
  SELECT x.mail_id, x.copy_job_id, x.joined_at FROM public.context_ledger_mail_copies(ARRAY(SELECT DISTINCT ic.id FROM inbox_c ic)) x
 ), inbox AS (
  SELECT c.job_id, 'inbox_events'::text AS src_table, c.id AS src_id, c.received_at AS at,
   -- when it joined this job's evidence: when it landed, or, kept here only because its copy
   -- sits elsewhere (on no job, or on a job that is not live), no earlier than that (a
   -- reading built before then never read it)
   greatest(coalesce(c.processed_at, c.received_at),
            (SELECT max(x.joined_at) FROM copies x WHERE x.mail_id = c.id AND x.copy_job_id IS DISTINCT FROM c.job_id)) AS landed_at,
   'email'::text AS channel, 'inbox.email_in'::text AS kind,
   'inbound'::text AS direction,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer'
    WHEN lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN 'staff' END AS sender_role,
   'staff'::text AS recipient_role,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer'
    WHEN lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN 'internal' END AS audience,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer' END AS counterpart_role,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'client_email' END AS role_basis,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN coalesce(c.cname, nullif(btrim(c.from_name), ''), c.from_email)
    ELSE coalesce(nullif(btrim(c.from_name), ''), c.from_email) END AS sender,
   coalesce(nullif(btrim(c.to_email), ''), c.mailbox) AS recipient,
   lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' AS ours,
   false AS automated,
   nullif(btrim(c.subject), '') AS subject,
   coalesce(nullif(btrim(c.body_preview), ''), btrim(c.subject)) AS body,
   c.placed_on, NULL::boolean AS has_transcript, NULL::boolean AS call_customer,
   lower(nullif(btrim(c.from_email), '')) AS sender_key
  FROM inbox_c c
  WHERE c.received_at IS NOT NULL AND c.received_at <= p_as_of
   AND coalesce(c.processed_at, c.received_at) <= p_as_of
   AND coalesce(c.classification, '') NOT IN ('spam', 'newsletter')
   AND coalesce(c.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
   AND btrim(coalesce(c.subject, '') || coalesce(c.body_preview, '')) <> ''
   -- A business_events copy on this job stands in for the mail (the reader reads the
   -- copy), and (seventh review) one on another live job decides where the mail belongs (the
   -- job conversation's rule R0: that job's reader reads it); a copy left unplaced or on a job
   -- that is not live (a bucket; eighth review: the judge's live set, so archived, complete,
   -- completed, cancelled, lost, a draft or holding, where no reader reads it) leaves the mail
   -- here, so each email reaches one job's reader once (story safety, 20261006040000).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = c.id::text
    AND (b.job_id = c.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE c.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || c.graph_message_id
    AND (b.job_id = c.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   -- An old-path copy names its inbox row only in the payload (containment, so
   -- the payload index answers it instead of a scan of every business_events row).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', c.id::text)
    AND (b.job_id = c.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   AND NOT EXISTS (SELECT 1 FROM email_copy m WHERE m.job_id = c.job_id AND m.at = c.received_at AND m.sender = lower(btrim(c.from_email)))
 ), allrows AS (
  SELECT * FROM be UNION ALL SELECT * FROM inbox
 ), keyed AS (
  SELECT a.*,
   lag(a.at) OVER w AS prev_at, lag(a.src_id) OVER w AS prev_id
  FROM allrows a
  WINDOW w AS (PARTITION BY a.job_id, a.channel, coalesce(a.direction, ''), coalesce(a.sender_key, ''),
   md5(lower(public.context_ledger_text_norm(a.body))) ORDER BY a.at, a.src_id)
 )
 SELECT k.job_id, k.src_table, k.src_id, k.at, k.landed_at, k.channel, k.kind, k.direction, k.sender_role, k.recipient_role,
  k.audience, k.counterpart_role, k.role_basis, k.sender, k.recipient, k.ours, k.automated, k.subject, k.body,
  k.placed_on, k.has_transcript, k.call_customer,
  CASE WHEN k.prev_at IS NOT NULL AND k.at - k.prev_at <= interval '120 seconds' THEN k.prev_id END AS copy_of
 FROM keyed k
 ORDER BY k.job_id, k.at, k.src_id
$function$
;
COMMENT ON FUNCTION public.context_ledger_evidence_rows(uuid[],timestamp with time zone) IS 'Context ledger store (20261006013000), story safety (20261006040000): a CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the story times it; landed_at stays its load), and one the CRM dates more than 30 days before the job was created (before its lead window) is left out: it is not this job''s evidence; (sixth review) so is one whose CRM time is no longer kept (its load time is not when it was sent). A legacy mail is left out for a business_events copy on the same job (source pointer, graph key, payload inbox_events_id, or an email from the same sender at the same instant), and (seventh review) for one on another live job (source pointer, graph key or payload inbox_events_id: that job''s reader reads it, as the job conversation''s rule R0 places it; eighth review: live is the judge''s live set, never archived, complete, completed, cancelled, lost, a draft or holding); a copy unplaced or on a job that is not live (a bucket) no longer hides it, so each email reaches one job''s reader once. Such a mail is in the evidence from its own landing, but its landed_at is when it joined the job''s evidence: no earlier than this rule''s first apply, its copies'' landing where they sit and (eighth review) the time a copy left a live job (context_ledger_mail_copies), so a reading built before then never counts it as read. Earlier: the admissible worded evidence of the given jobs as of an instant, oldest first: business_events rows passing context_ledger_row_admissible, plus legacy inbox_events mail placed on the job, or from the client''s address and placed on no job (placed_on this_job or none; mail placed on another job stays there; unplaced mail only when the client has no other job by CRM contact or client email, and from 30 days before the job was created), with no business_events copy (source pointer, graph key, payload inbox_events_id, or the same sender at the same instant), spam, newsletters and auto-replies left out. has_transcript on a call log: its transcript (payload.ghl_call_id or key ghltx:<id> naming the call''s ghl:<id>) is on the job. call_customer on a transcript: context_ledger_call_customer (its call''s customer stamp, the citation check''s rule). copy_of names the earlier row when this row is a copy (same channel, direction, sender address and words within 120 seconds); nothing is changed. Placement is read as it is now. Service role only. Story card causes (20261014120000): message body includes labelled forwarded correspondence through context_story_message_text. Admission, placement and landing time are unchanged.';
CREATE OR REPLACE FUNCTION public.context_ledger_held_rows(p_job_ids uuid[], p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(job_id uuid, src_table text, src_id uuid, at timestamp with time zone, landed_at timestamp with time zone, channel text, kind text, direction text, sender_role text, recipient_role text, audience text, counterpart_role text, role_basis text, sender text, recipient text, ours boolean, automated boolean, subject text, body text, held_rule text, held_status text, candidate_jobs integer, other_jobs text[], same_contact boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH j AS (
  SELECT jb.id, nullif(btrim(jb.ghl_contact_id), '') AS contact, lower(nullif(btrim(jb.client_email), '')) AS cmail,
   nullif(btrim(jb.client_name), '') AS cname, jb.created_at
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), h AS (
  SELECT j.id AS job_id, e.id AS src_id,
   -- a CRM text loaded later from the CRM's cache is timed by the CRM's own time, as the
   -- evidence rows time it; it landed when it was loaded
   coalesce(ct.crm_at, e.event_at, e.occurred_at) AS at,
   greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) AS landed_at,
   coalesce(e.channel, CASE WHEN e.event_type LIKE '%email%' THEN 'email' WHEN e.event_type LIKE '%call%' THEN 'call'
    WHEN e.event_type LIKE 'note.%' THEN 'note' ELSE 'sms' END) AS channel,
   e.event_type AS kind, e.direction,
   e.metadata #>> '{party_roles,sender_role}' AS sender_role,
   e.metadata #>> '{party_roles,recipient_role}' AS recipient_role,
   coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') AS audience,
   e.metadata #>> '{party_roles,counterpart_role}' AS counterpart_role,
   e.metadata #>> '{party_roles,basis}' AS role_basis,
   -- this job's customer's: the row's CRM contact is the job's, or its sender address the job's client email
   sc.same_contact,
   CASE WHEN sc.same_contact AND e.metadata #>> '{party_roles,sender_role}' = 'customer' THEN j.cname
    ELSE coalesce((SELECT s.label FROM public.staff_ghl_users s
      WHERE s.ghl_user_id = coalesce(e.payload ->> 'sent_by_user', e.payload ->> 'by_user') LIMIT 1),
     nullif(btrim(coalesce(e.payload ->> 'from_name', e.payload ->> 'from', e.payload ->> 'from_email')), '')) END AS sender,
   CASE WHEN sc.same_contact AND e.metadata #>> '{party_roles,recipient_role}' = 'customer' THEN j.cname
    ELSE nullif(btrim(coalesce(e.payload ->> 'to_name', e.payload ->> 'to', e.payload ->> 'to_email')), '') END AS recipient,
   public.context_event_is_ours(e) AS ours,
   (coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other') AS automated,
   nullif(btrim(e.payload ->> 'subject'), '') AS subject,
   public.context_story_message_text(e) AS body,
   nullif(btrim(e.metadata ->> 'placement_rule'), '') AS held_rule,
   e.attribution_status AS held_status,
   cardinality(e.candidate_job_ids) AS candidate_jobs,
   ARRAY(SELECT o.job_number FROM public.jobs o
         WHERE o.id = ANY(e.candidate_job_ids) AND o.id <> j.id AND o.job_number IS NOT NULL
         ORDER BY o.job_number COLLATE "C") AS other_jobs
  FROM j JOIN public.business_events e ON e.candidate_job_ids @> ARRAY[j.id]
  CROSS JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                         coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                             END AS crm_at) ct
  CROSS JOIN LATERAL (SELECT coalesce((j.contact IS NOT NULL AND e.contact_id = j.contact)
                              OR (j.cmail IS NOT NULL AND lower(btrim(coalesce(substring(e.payload ->> 'from', '<([^<>]*)>'),
                                    e.payload ->> 'from', e.payload ->> 'from_email'))) = j.cmail), false) AS same_contact) sc
  -- on no job, and held by the ladder with this job among its candidates
  WHERE e.job_id IS NULL AND e.attribution_status IN ('pending_luna', 'unplaced')
   -- the evidence rows' admission apart from placement: our own writer, worded, a message,
   -- timed, never retracted, never a marked copy, never status-only
   AND coalesce(e.metadata ->> 'written_as', 'service_role') = 'service_role'
   AND btrim(public.context_event_text(e)) <> ''
   AND coalesce(e.event_at, e.occurred_at) IS NOT NULL
   AND e.metadata #>> '{retracted_at}' IS NULL
   AND (e.metadata #>> '{retracted}' IS NULL OR e.metadata #>> '{retracted}' <> 'true')
   AND e.metadata #>> '{duplicate_of}' IS NULL
   AND NOT public.context_event_status_only(e)
   AND public.context_ledger_message_kind(e)
   AND coalesce(ct.crm_at, e.event_at, e.occurred_at) <= p_as_of
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= p_as_of
   -- the evidence rows' lead window rule for a CRM text loaded from the cache
   AND NOT coalesce(ct.crm_at < j.created_at - interval '30 days', false)
   AND NOT (e.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL)
 )
 SELECT h.job_id, 'business_events'::text, h.src_id, h.at, h.landed_at, h.channel, h.kind, h.direction, h.sender_role,
  h.recipient_role, h.audience, h.counterpart_role, h.role_basis, h.sender, h.recipient, h.ours, h.automated, h.subject, h.body,
  h.held_rule, h.held_status, h.candidate_jobs, h.other_jobs, h.same_contact
 FROM h
 ORDER BY h.job_id, h.at, h.src_id
$function$
;
COMMENT ON FUNCTION public.context_ledger_held_rows(uuid[],timestamptz) IS 'Held messages (20261012100000): for each given job, the messages placed on no job that could be that job''s, as of an instant, oldest first: business_events rows with no job, attribution status unplaced or pending_luna, whose stored candidate_job_ids contain the job (the placement ladder''s own candidates; nearly always the customer has several jobs and the message fits more than one). Admitted as the evidence rows are apart from placement: written as service_role, worded, a message kind, not status-only, timed, never retracted, never a marked copy (metadata.duplicate_of); a CRM text loaded later from the CRM''s cache is at the CRM''s own time, and one dated more than 30 days before the job was created, or whose CRM time is no longer kept, is left out. The same row is returned once for each candidate job asked for. Each: the evidence rows'' fields (at, landed_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject, body), held_rule (metadata.placement_rule, the rule that held it), held_status, candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and same_contact (the row''s CRM contact is the job''s, or its sender address the job''s client email: this job''s customer''s message). Nothing is placed, counted as the job''s or changed: these are never evidence rows, and context_ledger_cite still refuses one (citation_off_job). Read by context_ledger_packet (held) and context_job_story_held. Read by the index business_events_candidate_job_ids. Service role only. Story card causes (20261014120000): message body includes labelled forwarded correspondence through context_story_message_text. Candidates, certainty and admission are unchanged.';
DROP FUNCTION public.context_ledger_call_customer(public.business_events,uuid);
DROP FUNCTION public.context_ledger_reader_events(uuid[]);
DROP FUNCTION public.context_ledger_event_on_job(public.business_events,uuid);
DROP FUNCTION public.context_ledger_mail_copy_blocks(public.business_events,uuid,boolean);
DROP FUNCTION public.context_ledger_person_placement_enabled();
