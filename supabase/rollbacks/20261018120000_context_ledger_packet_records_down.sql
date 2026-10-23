-- Ledger packet records (20261018120000) down.
-- Restores context_ledger_packet to the 20261015100000 body, then drops the helpers.
-- No transaction wrapper: a caller that includes this file keeps the changes inside
-- its own transaction, and a standalone run commits each statement.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
 v_held jsonb; v_on boolean;
BEGIN
 v_as_of := coalesce(p_as_of, now());
 v_on := public.context_held_notes_on();
 SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, j.client_name, j.site_suburb, j.created_at,
  nullif(btrim(j.ghl_contact_id), '') AS ghl_contact_id, j.client_email, j.client_phone
 INTO jb FROM public.jobs j WHERE j.id = p_job_id;
 IF jb.id IS NULL THEN RAISE EXCEPTION 'context_ledger_packet_job_not_found'; END IF;
 v_job := jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
  'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
  'customer_contact_ref', jb.ghl_contact_id);
 -- Parties: the job's own client, then every other party on job_contacts
 -- (the owner row that repeats the job's client is not listed twice; its
 -- contact details join the client's). Each carries match_keys, so the reader
 -- can tell whether our message reached that party (never printed).
 SELECT array_agg(c.client_email), array_agg(c.client_phone), array_agg(nullif(btrim(c.ghl_contact_id), ''))
 INTO v_pe, v_pp, v_pc
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, ''));
 SELECT jsonb_build_array(jsonb_build_object('name', jb.client_name, 'role', 'customer', 'contact_ref', jb.ghl_contact_id, 'label', 'job_client',
   'match_keys', public.context_ledger_party_keys(ARRAY[jb.client_email] || v_pe, ARRAY[jb.client_phone] || v_pp,
    ARRAY[jb.ghl_contact_id] || v_pc)))
  -- A party's role: a neighbour (contact_type neighbour, neighbour_b and so on) is a
  -- third party, never the customer, labelled neighbour (and "pays a share" when
  -- its share or invoiced amount says so); the primary contact is the customer;
  -- any other keeps its contact_type, else unknown.
  || coalesce(jsonb_agg(jsonb_build_object('name', c.client_name,
   'role', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%' THEN 'third_party'
                WHEN coalesce(c.is_primary, false) OR lower(coalesce(c.contact_type, '')) = 'primary' THEN 'customer'
                ELSE coalesce(nullif(btrim(c.contact_type), ''), 'unknown') END,
   'contact_ref', coalesce(nullif(btrim(c.ghl_contact_id), ''), lower(nullif(btrim(c.client_email), ''))),
   'label', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%'
                 THEN 'neighbour' || CASE WHEN coalesce(c.share_percentage, 0) > 0 OR coalesce(c.amount_invoiced, 0) > 0
                                          THEN ', pays a share' ELSE '' END
                 ELSE coalesce(c.contact_label, c.contact_type) END,
   'match_keys', public.context_ledger_party_keys(ARRAY[c.client_email], ARRAY[c.client_phone], ARRAY[nullif(btrim(c.ghl_contact_id), '')]))
   ORDER BY c.is_primary DESC NULLS LAST, c.created_at, c.id), '[]'::jsonb)
 INTO v_parties
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND NOT (coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, '')));
 -- Evidence: copies left out. In update mode: the rows that landed after
 -- p_since; every already-read row after the earliest of them (so a late row,
 -- such as old mail placed on the job today, is read with what followed it);
 -- and the six rows before it. Each row says whether it was already read.
 WITH r AS (
  SELECT * FROM public.context_ledger_evidence_rows(ARRAY[p_job_id], v_as_of)
 ), u AS (
  SELECT * FROM r WHERE r.copy_of IS NULL
 ), firstnew AS (
  SELECT u.at, u.src_id FROM u WHERE p_since IS NOT NULL AND u.landed_at > p_since ORDER BY u.at, u.src_id LIMIT 1
 ), ctx AS (
  SELECT u.src_id FROM u, firstnew f
  WHERE (u.at, u.src_id) < (f.at, f.src_id) AND NOT (u.landed_at > p_since)
  ORDER BY u.at DESC, u.src_id DESC LIMIT 6
 ), sel AS (
  SELECT u.*, CASE WHEN u.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END AS lim
  FROM u WHERE p_since IS NULL OR u.landed_at > p_since OR u.src_id IN (SELECT ctx.src_id FROM ctx)
   OR EXISTS (SELECT 1 FROM firstnew f WHERE (u.at, u.src_id) > (f.at, f.src_id))
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at, 'recorded_at', sel.landed_at,
   'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction, 'sender_role', sel.sender_role,
   'recipient_role', sel.recipient_role, 'audience', sel.audience, 'counterpart_role', sel.counterpart_role,
   'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient, 'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject,
   'already_read', p_since IS NOT NULL AND sel.landed_at <= p_since, 'placed_on', sel.placed_on, 'has_transcript', sel.has_transcript,
   -- (ledger reader fixes, 20261007150000) a transcript says whose call it is as true, false or
   -- "unknown" (neither its call row on this job nor its own stamp on the job's contact decides),
   -- never a bare null, which readers took for "not this job's customer"; and each row says whether
   -- its own placement or role basis makes it someone else's (the item check's rule), and why
   'call_customer', CASE WHEN sel.kind = 'call.transcript_completed' THEN coalesce(to_jsonb(sel.call_customer), '"unknown"'::jsonb)
                         ELSE to_jsonb(sel.call_customer) END,
   'elsewhere', public.context_ledger_row_elsewhere(p_job_id, sel.src_table, sel.src_id),
   'text', left(sel.body, sel.lim)) ORDER BY sel.at, sel.src_id), '[]'::jsonb),
  count(*)::integer, (count(*) FILTER (WHERE length(sel.body) > sel.lim))::integer,
  (SELECT max(r.landed_at) FROM r), (SELECT count(*) FILTER (WHERE r.copy_of IS NOT NULL) FROM r)::integer
 INTO v_evidence, v_rows, v_truncated, v_until, v_dups FROM sel;
 -- Items the reader must know: in update mode the current generation's open,
 -- disputed and in-force items; otherwise the live generation's person-locked
 -- items (a rebuild must not write them again).
 IF p_since IS NOT NULL THEN
  v_gen := public.context_ledger_current_generation(p_job_id);
 ELSE
  SELECT g.id INTO v_gen FROM public.context_ledger_generations g WHERE g.job_id = p_job_id AND g.status = 'live';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_key', i.item_key, 'item_type', i.item_type, 'status', i.status, 'what', i.what,
   'about_key', i.about_key, 'phase', i.phase, 'from_role', i.from_role, 'to_role', i.to_role, 'opened_at', i.opened_at,
   'closes_on', i.closes_on, 'opened_by', i.opened_by, 'person_locked', i.person_locked)
   -- (held notes, 20261015100000) an item a held message still holds up is marked job not certain
   || CASE WHEN i.job_not_certain AND public.context_ledger_item_held_now(p_job_id, i.opened_by, v_as_of)
           THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END
   ORDER BY i.opened_at, i.item_key COLLATE "C"), '[]'::jsonb)
 INTO v_open FROM public.context_ledger_items i
 WHERE v_gen IS NOT NULL AND i.generation_id = v_gen
  AND CASE WHEN p_since IS NOT NULL THEN i.status IN ('open', 'disputed', 'info') ELSE i.person_locked END;
 -- (held messages, 20261012100000) The messages placed on no job that could be this job's
 -- (context_ledger_held_rows: the ladder left them unplaced with this job among their candidates,
 -- nearly always because the customer has several jobs). They are context for the reader, marked
 -- job not certain: never evidence rows, never counted, never citable (the citation check still
 -- refuses them as off the job), and their placement is not read as this job's. A rebuild is given
 -- the newest 40; an update the newest 40 that landed after p_since and, when there is one, the 6
 -- newest it was given before, to read them by. Oldest first; text capped at 6,000 characters for
 -- a transcript or document text and 3,000 otherwise, as for placed evidence; cuts are explicit.
 WITH h AS (
  SELECT * FROM public.context_ledger_held_rows(ARRAY[p_job_id], v_as_of)
 ), fresh AS (
  SELECT h.*, false AS already_read FROM h WHERE p_since IS NULL OR h.landed_at > p_since
  ORDER BY h.at DESC, h.src_id DESC LIMIT 40
 ), ctx AS (
  SELECT h.*, true AS already_read FROM h
  WHERE p_since IS NOT NULL AND NOT (h.landed_at > p_since) AND EXISTS (SELECT 1 FROM fresh)
  ORDER BY h.at DESC, h.src_id DESC LIMIT 6
 ), sel AS (
  SELECT * FROM fresh UNION ALL SELECT * FROM ctx
 )
 SELECT jsonb_build_object('certainty', 'job_not_certain',
  'total', (SELECT count(*) FROM h),
  'new', (SELECT count(*) FROM h WHERE p_since IS NULL OR h.landed_at > p_since),
  'not_shown', (SELECT count(*) FROM h) - (SELECT count(*) FROM sel),
  'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at,
     'recorded_at', sel.landed_at, 'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction,
     'sender_role', sel.sender_role, 'recipient_role', sel.recipient_role, 'audience', sel.audience,
     'counterpart_role', sel.counterpart_role, 'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient,
     'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject, 'already_read', sel.already_read,
     'placed_on', 'none', 'certainty', 'job_not_certain', 'from_this_customer', sel.same_contact,
     'held_rule', sel.held_rule, 'candidate_jobs', sel.candidate_jobs, 'other_jobs', to_jsonb(sel.other_jobs),
     'text', left(sel.body, CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END),
     'cut', length(sel.body) > CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END)
     -- (held notes, 20261015100000) with the switch on, whether the reader may cite it to open or
     -- support an open item marked job not certain: never when a copy of it is placed on a job
     -- (cite that copy) or its call is on another job
     || CASE WHEN v_on THEN jsonb_build_object('citable', NOT EXISTS (SELECT 1 FROM public.context_ledger_held_placed_copy(sel.src_id) pc
                                                                    WHERE pc.how = 'copy' OR pc.copy_job_id <> p_job_id))
             ELSE '{}'::jsonb END
     ORDER BY sel.at, sel.src_id) FROM sel), '[]'::jsonb))
  -- (held notes) with the switch on, the section says its rows may be cited, marked job not certain
  || CASE WHEN v_on THEN jsonb_build_object('citable', 'job_not_certain') ELSE '{}'::jsonb END
 INTO v_held;
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open,
  -- (ledger reader fixes, 20261007150000) the same client's and the same work order's other jobs,
  -- with what was quoted and billed there
  'siblings', public.context_ledger_siblings(p_job_id, v_as_of),
  -- (held messages, 20261012100000) the messages on no job that could be this job's, job not certain
  'held', v_held);
END $function$;
COMMENT ON FUNCTION public.context_ledger_packet(uuid,timestamptz,timestamptz) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (held messages, 20261012100000) still ledger-packet-v1, with one field added: held {certainty job_not_certain, total, new, not_shown, rows}: the messages placed on no job that could be this job''s (context_ledger_held_rows: unplaced or waiting on the placement review with this job among their stored candidates, nearly always because the customer has several jobs; worded, a message kind, never retracted, a copy or status-only), as of the packet''s as_of. Context only, marked job not certain: never evidence rows, never in evidence_rows or evidence_until, never citable (the citation check still refuses them, citation_off_job), and nothing about their placement is changed or read as this job''s. total: all of them; new: those that landed after since (all on a rebuild); rows, oldest first: a rebuild''s newest 40, or an update''s newest 40 new ones and, when there is one, the 6 newest given before (already_read true); each row as an evidence row (table, id, at, recorded_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject) with placed_on none, certainty job_not_certain, from_this_customer (the row''s CRM contact is the job''s, or its sender address the job''s client email), held_rule (the placement rule that held it), candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and text (capped at 3,000 characters for a transcript or document text, 1,500 otherwise); not_shown: how many of total are not in rows. Earlier (ledger reader fixes) still ledger-packet-v1, with fields added: each transcript''s call_customer is true, false or the string unknown (neither its call row on this job nor its own stamp on the job''s contact decides), never a bare null; each evidence row carries elsewhere, the reason it is someone else''s (context_ledger_row_elsewhere: role_basis:<basis> when its own stamp names another job''s customer or party or a lead, call_not_customer when its call row''s on this job does, call_on_other_job, names_other_job:<number>) or null, never on the customer''s own words or a stamp naming our own people, a supplier, a builder, a council, a party on this job or nobody (second review, 8 Oct); only role_basis and call_not_customer carry an item that says a row is someone else''s (elsewhere_unsupported); and siblings (context_ledger_siblings as of the packet''s as_of): the same client''s and the same work order''s other jobs with their quotes sent and invoices issued, context only. Earlier: ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only. Story card causes (20261014120000): held text uses the same 6000/3000 limits as placed evidence with an explicit cut flag. Held notes (20261015100000): an open item a held message still holds up carries job_certain false and certainty job_not_certain; while the switch is on, held carries citable job_not_certain and each held row citable (false when a copy is placed on a job or its call is on another job). Off: unchanged.';

DROP FUNCTION IF EXISTS public.context_ledger_evidence_record_links(uuid, timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_comm_log_links(uuid, timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_record_link_about(text);
DROP FUNCTION IF EXISTS public.context_ledger_record_invoice_about(text);
DROP FUNCTION IF EXISTS public.context_ledger_record_uuid(text);
DROP FUNCTION IF EXISTS public.context_ledger_record_money(numeric);
DROP FUNCTION IF EXISTS public.context_ledger_record_trim(text);
DROP INDEX IF EXISTS public.communications_log_ledger_business_event_idx;
DROP INDEX IF EXISTS public.communications_log_ledger_inbox_event_idx;
