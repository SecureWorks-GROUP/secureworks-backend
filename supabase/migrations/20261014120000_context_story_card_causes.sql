-- Story card causes, 14 Oct 2026. Based on SELECT pg_get_functiondef reads of production.
-- Changes definitions only. NO row changes, placements, rebuilds, flags, settings or sends.
-- held stays uncertain, non-citable and outside evidence_until. Money reads actual email
-- proof before calling a quote unsent; the existing R8 rule owns when a balance is held.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $guard$
DECLARE r record; h text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.context_ledger_packet(uuid,timestamp with time zone,timestamp with time zone)', ARRAY['b04863d6bd6f8ceaadb102532b8136a2','93ddf3979e8c0c3625c425a3934f4838']),
 ('public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)', ARRAY['72da3ec164693a91819016eace85e895','9ba28fe55db39844b2a9b83dc448eaad']),
 ('public.context_job_record_value(uuid[],timestamp with time zone)', ARRAY['ed329078f075719e650797926df6d3da','b21ec0726cc49af6c7275adc3bb8f50c']),
 ('public.context_job_story_held(uuid,timestamp with time zone)', ARRAY['e9e5db3d25199d2273eac53c4fbb1786','ed4eb54cdbc2e903f4c9f33b8bfee840']),
 ('public.context_ledger_evidence_rows(uuid[],timestamp with time zone)', ARRAY['2c3dbfef58572e08a630444692d61242','f660fe3e9484200448b451cfa5f33d64']),
 ('public.context_ledger_cite(uuid,jsonb)', ARRAY['c126255e2f405fa17341545146723fe0','44b8faee5207fa4a4604dbcb25cbfc12']),
 ('public.context_ledger_held_rows(uuid[],timestamp with time zone)', ARRAY['dcdfdb1d63e56dd4f85def29bc9b7c3e','df1971a701be94dec3900448b3b53c69'])
 ) v(sig, hashes) LOOP
  SELECT md5(p.prosrc) INTO h FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
  IF h IS NULL OR NOT h = ANY(r.hashes) THEN RAISE EXCEPTION 'story_card_causes_preimage_mismatch: % (%)', r.sig, h; END IF;
 END LOOP;
END $guard$;
DO $new_guard$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.context_job_quote_email_sends(uuid[],timestamptz)','d83c48f924f80208d40d4e02952e1069'),
 ('public.context_job_story_payment_terms(jsonb)','a278b4b93d4fe64a4aeccd9d7f678f95'),
 ('public.context_story_message_text(public.business_events)','52d664033c39b59f864ee25a7d72e9ef')
 ) v(sig, hash) LOOP
  IF to_regprocedure(r.sig) IS NOT NULL AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(r.sig)) <> r.hash THEN
   RAISE EXCEPTION 'story_card_causes_helper_mismatch: %', r.sig;
  END IF;
 END LOOP;
END $new_guard$;

CREATE OR REPLACE FUNCTION public.context_job_quote_email_sends(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(document_id uuid, job_id uuid, event_id uuid, sent_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
 -- A real captured sent email with its stored quote attachment, on this job and to its
 -- customer. A filename must name the whole quote number, or the whole job number with
 -- exactly one quote created on that Perth day. Never infer sending from a mention alone.
 SELECT DISTINCT ON (d.id) d.id, d.job_id, e.id, coalesce(e.event_at, e.occurred_at)
 FROM public.job_documents d
 JOIN public.jobs j ON j.id = d.job_id
 JOIN public.business_events e ON e.job_id = d.job_id AND e.channel = 'email' AND e.direction = 'outbound'
 JOIN public.context_email_attachments a ON a.business_event_id = e.id AND a.status = 'stored'
 WHERE d.job_id = ANY(p_job_ids) AND d.type ILIKE '%quote%' AND d.created_at <= p_as_of
  AND public.context_ledger_row_admissible(e)
  AND e.payload->>'folder_kind' = 'sent' AND e.payload->>'sender_kind' = 'ours'
  AND nullif(e.provider_message_id, '') IS NOT NULL
  AND coalesce(e.event_at, e.occurred_at) >= d.created_at
  AND coalesce(e.event_at, e.occurred_at) <= p_as_of
  AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= p_as_of
  AND a.created_at <= p_as_of
  AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.payload->'to') = 'array'
                   THEN e.payload->'to' ELSE '[]'::jsonb END) r(addr)
              WHERE lower(btrim(r.addr)) = lower(nullif(btrim(j.client_email), '')))
  AND (EXISTS (SELECT 1 FROM regexp_matches(upper(a.file_name), '(Q-[0-9]+)', 'g') tok
                WHERE tok[1] = upper(nullif(btrim(d.quote_number), '')))
       OR (a.file_name ~* '(^|[^a-z])quote([^a-z]|$)'
           AND EXISTS (SELECT 1 FROM regexp_matches(upper(a.file_name), '(SW[A-Z]{0,4}-[0-9]+)', 'g') tok
                       WHERE tok[1] = upper(j.job_number))
           AND (coalesce(e.event_at, e.occurred_at) AT TIME ZONE 'Australia/Perth')::date
                  = (d.created_at AT TIME ZONE 'Australia/Perth')::date
           AND 1 = (SELECT count(*) FROM public.job_documents q WHERE q.job_id = d.job_id
                     AND q.type ILIKE '%quote%' AND q.created_at <= p_as_of
                     AND (q.created_at AT TIME ZONE 'Australia/Perth')::date = (d.created_at AT TIME ZONE 'Australia/Perth')::date)))
  -- An older version is not revived by a later send: respect the next document and supersession.
  AND (d.superseded_at IS NULL OR coalesce(e.event_at, e.occurred_at) < d.superseded_at)
  AND NOT EXISTS (SELECT 1 FROM public.job_documents q WHERE q.job_id = d.job_id AND q.type ILIKE '%quote%'
                  AND q.created_at > d.created_at AND q.created_at <= coalesce(e.event_at, e.occurred_at))
 ORDER BY d.id, coalesce(e.event_at, e.occurred_at), e.id
$function$;
COMMENT ON FUNCTION public.context_job_quote_email_sends(uuid[],timestamptz) IS
 'Story card causes (20261014120000): actual sent quote evidence from a captured outbound email and its stored, named quote attachment. Exact quote token or one same-day quote with the whole job token; same job and customer recipient, no future captures, no later version. A read only; never stamps a document or changes money. Service role only.';
REVOKE ALL ON FUNCTION public.context_job_quote_email_sends(uuid[],timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_quote_email_sends(uuid[],timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.context_job_story_payment_terms(p_story jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE
AS $function$
 -- Consume the existing R8 judgement, never invent another completion or money rule.
 SELECT CASE WHEN p_story #>> '{money,not_yet_invoiced,amount}' IS NOT NULL AND EXISTS (
   SELECT 1 FROM jsonb_array_elements(coalesce(p_story->'loops', '[]'::jsonb)) l
   WHERE l->>'rule' = 'R8_not_yet_invoiced' AND l->>'status' = 'not_due')
 THEN jsonb_set(jsonb_set(p_story, '{money,not_yet_invoiced}',
        (p_story #> '{money,not_yet_invoiced}') || jsonb_build_object('status', 'not_due', 'held', true,
          'basis', (p_story #>> '{money,not_yet_invoiced,basis}') || '; held until work is complete, not owed now')),
        '{money,line}', to_jsonb((p_story #>> '{money,line}') || ' The uninvoiced balance is held until work is complete, not owed now.'))
 ELSE p_story END
$function$;
COMMENT ON FUNCTION public.context_job_story_payment_terms(jsonb) IS
 'Story card causes (20261014120000): labels the known uninvoiced balance held/not_due when the existing R8 loop says not_due. Does not alter an amount, owing, overdue, a C2 refusal or the move. Pure, service role only.';
REVOKE ALL ON FUNCTION public.context_job_story_payment_terms(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_payment_terms(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.context_story_message_text(e public.business_events)
RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
 -- The forwarded body is evidence, never placement input. Its original headers remain
 -- quoted; receipt of a forwarded plan is not approval and is not the forwarder's words.
 SELECT public.context_event_text(e) || CASE WHEN e.channel = 'email'
   AND jsonb_typeof(e.payload->'forwarded_correspondence') = 'string'
   AND nullif(btrim(e.payload->>'forwarded_correspondence'), '') IS NOT NULL
 THEN E'\n\nForwarded correspondence (quoted content, not new words from the sender):\n'
      || left(e.payload->>'forwarded_correspondence', 20000)
      || CASE WHEN e.payload->>'forwarded_correspondence_truncated' = 'true'
              THEN E'\n[Forwarded correspondence was cut at capture.]' ELSE '' END
 ELSE '' END
$function$;
COMMENT ON FUNCTION public.context_story_message_text(public.business_events) IS
 'Story card causes (20261014120000): evidence text including separately labelled forwarded correspondence. The placement ladder still reads context_event_text, never this helper. Bound at 20000 forwarded characters; capture truncation declared. No HTML; the Outlook producer supplies text. Service role only.';
REVOKE ALL ON FUNCTION public.context_story_message_text(public.business_events) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_story_message_text(public.business_events) TO service_role;


CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
 v_held jsonb;
BEGIN
 v_as_of := coalesce(p_as_of, now());
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
   'closes_on', i.closes_on, 'opened_by', i.opened_by, 'person_locked', i.person_locked) ORDER BY i.opened_at, i.item_key COLLATE "C"), '[]'::jsonb)
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
     ORDER BY sel.at, sel.src_id) FROM sel), '[]'::jsonb))
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
COMMENT ON FUNCTION public.context_ledger_packet(uuid,timestamp with time zone,timestamp with time zone) IS 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (held messages, 20261012100000) still ledger-packet-v1, with one field added: held {certainty job_not_certain, total, new, not_shown, rows}: the messages placed on no job that could be this job''s (context_ledger_held_rows: unplaced or waiting on the placement review with this job among their stored candidates, nearly always because the customer has several jobs; worded, a message kind, never retracted, a copy or status-only), as of the packet''s as_of. Context only, marked job not certain: never evidence rows, never in evidence_rows or evidence_until, never citable (the citation check still refuses them, citation_off_job), and nothing about their placement is changed or read as this job''s. total: all of them; new: those that landed after since (all on a rebuild); rows, oldest first: a rebuild''s newest 40, or an update''s newest 40 new ones and, when there is one, the 6 newest given before (already_read true); each row as an evidence row (table, id, at, recorded_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject) with placed_on none, certainty job_not_certain, from_this_customer (the row''s CRM contact is the job''s, or its sender address the job''s client email), held_rule (the placement rule that held it), candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and text (capped at 3,000 characters for a transcript or document text, 1,500 otherwise); not_shown: how many of total are not in rows. Earlier (ledger reader fixes) still ledger-packet-v1, with fields added: each transcript''s call_customer is true, false or the string unknown (neither its call row on this job nor its own stamp on the job''s contact decides), never a bare null; each evidence row carries elsewhere, the reason it is someone else''s (context_ledger_row_elsewhere: role_basis:<basis> when its own stamp names another job''s customer or party or a lead, call_not_customer when its call row''s on this job does, call_on_other_job, names_other_job:<number>) or null, never on the customer''s own words or a stamp naming our own people, a supplier, a builder, a council, a party on this job or nobody (second review, 8 Oct); only role_basis and call_not_customer carry an item that says a row is someone else''s (elsewhere_unsupported); and siblings (context_ledger_siblings as of the packet''s as_of): the same client''s and the same work order''s other jobs with their quotes sent and invoices issued, context only. Earlier: ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only. Story card causes (20261014120000): held text uses the same 6000/3000 limits as placed evidence with an explicit cut flag.';

CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid, p_as_of timestamp with time zone DEFAULT now(), p_generation_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_record_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- (held messages, 20261012100000) the story, and with it the messages placed on no job that could be
 -- this job's (context_job_story_held), marked job not certain: only when there are any, so a job
 -- with none reads exactly as before, and never in the records-only read
 SELECT public.context_job_story_payment_terms(st.story) || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END
 FROM (SELECT public.context_job_story_assemble(
  (SELECT jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
          'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
          'ghl_contact_id', nullif(btrim(jb.ghl_contact_id), ''))
   FROM public.jobs jb WHERE jb.id = p_job_id),
  jsonb_build_object(
   'timeline', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.at, t.kind, t.source_id), '[]'::jsonb)
                FROM public.context_job_record_timeline(ARRAY[p_job_id], p_as_of) t),
   'loops', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.rule, l.source_id), '[]'::jsonb)
             FROM public.context_job_record_loops(ARRAY[p_job_id], p_as_of) l),
   'money', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.owing DESC, m.party), '[]'::jsonb)
             FROM public.context_job_record_money(ARRAY[p_job_id], p_as_of) m),
   'contact', (SELECT to_jsonb(c) FROM public.context_job_record_contact(ARRAY[p_job_id], p_as_of) c),
   'facts', public.context_job_story_facts(p_job_id, p_as_of),
   -- (lead cutoff, 20261007010000) the lead rule's answer for this job, which the assembler reads
   'lead', (SELECT to_jsonb(m) FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], p_as_of) m)),
  -- record_only: the records alone, for the reader's own prompt; the ledger is
  -- not read, so no item, attachment or ledger word reaches the output.
  CASE WHEN coalesce(p_record_only, false) THEN jsonb_build_object('status', 'omitted', 'items', '[]'::jsonb, 'transitions', '[]'::jsonb)
       ELSE public.context_job_story_ledger(p_job_id, p_generation_id, p_as_of) END,
  -- (story settled notes, 20261011120000) and each call log on the job whose transcript is on the job
  -- by p_as_of, call row id to transcript id (the evidence rows' has_transcript pairing: the
  -- transcript's payload.ghl_call_id or key ghltx:<id> names the call's ghl:<id>), so the assembler
  -- can leave out an event the reader wrote from the call log alone
  public.context_job_story_meta(p_job_id, p_as_of)
   || jsonb_build_object('call_transcripts', (SELECT coalesce(jsonb_object_agg(e.id::text, t.id::text), '{}'::jsonb)
        FROM public.business_events e
        CROSS JOIN LATERAL (SELECT t.id FROM public.business_events t
                            WHERE t.job_id = e.job_id AND t.event_type = 'call.transcript_completed'
                              AND public.context_linked_status(t.attribution_status)
                              AND (t.payload ->> 'ghl_call_id' = substr(e.provider_message_id, 5)
                                   OR t.provider_message_id = 'ghltx:' || substr(e.provider_message_id, 5))
                              AND greatest(coalesce(t.context_captured_at, t.recorded_at, t.occurred_at), t.attributed_at) <= p_as_of
                            ORDER BY t.id LIMIT 1) t
        WHERE e.job_id = p_job_id AND e.event_type <> 'call.transcript_completed'
          AND (e.channel = 'call' OR e.event_type IN ('client.call_logged', 'client.call_complete'))
          AND e.provider_message_id LIKE 'ghl:%' AND public.context_linked_status(e.attribution_status))),
  p_as_of, p_since) AS story
 WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id)) st
 CROSS JOIN LATERAL (SELECT CASE WHEN coalesce(p_record_only, false) THEN NULL
                                 ELSE public.context_job_story_held(p_job_id, p_as_of) END AS held) hm
$function$;
COMMENT ON FUNCTION public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean) IS 'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) (held messages, 20261012100000) the story also carries held_messages (context_job_story_held as of p_as_of): the messages placed on no job that could be this job''s, nearly always because the customer has several jobs, each marked job not certain, newest first; the key is there only when the job has any (a job with none reads exactly as before) and never in the records-only read. They are shown, never counted as this job''s messages, never cited by a note, and their placement is not changed. Earlier (story settled notes) meta also carries call_transcripts: each call log on the job whose transcript is on the job by p_as_of (linked, landed by then; the transcript''s payload.ghl_call_id or key ghltx:<id> names the call''s ghl:<id>), call row id to transcript id, which the assembler reads to leave out an event written from the call log alone. Earlier (lead cutoff) the record part also carries lead (context_lead_monitored_jobs for the job as of p_as_of: monitored, state, quote_sent_at, customer_at, cutoff_at), which the assembler reads. Earlier: job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only. Story card causes (20261014120000): the known uninvoiced balance is explicitly held while R8 says not_due.';

CREATE OR REPLACE FUNCTION public.context_job_record_value(p_job_ids uuid[], p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(job_id uuid, value numeric, value_basis text, accepted boolean, accepted_at timestamp with time zone, accepted_by text, issued numeric, checks jsonb)
 LANGUAGE sql
 STABLE
AS $function$
 WITH j AS (
  SELECT jb.id, nullif(btrim(jb.deposit_invoice_id), '') AS dep_inv,
         CASE WHEN jb.accepted_at <= p_as_of THEN jb.accepted_at END AS job_acc,
         CASE WHEN jsonb_typeof(jb.pricing_json->'totalIncGST') = 'number' THEN (jb.pricing_json->>'totalIncGST')::numeric END AS price_inc,
         jb.quoted_value, jb.created_at,
         -- the job number as invoices name it (SW...-digits; another form names no job)
         upper(substring(coalesce(jb.job_number, '') FROM '^(SW[A-Za-z]{0,4}-[0-9]+)')) AS jnum,
         -- (sixth review) where the value came from, the job's kind of work, its own Xero
         -- contact, its client (CRM contact, client email) and its site
         nullif(btrim(jb.pricing_json ->> 'source'), '') AS psrc, jb.type::text AS jtype,
         nullif(btrim(jb.xero_contact_id), '') AS jxc, nullif(btrim(jb.ghl_contact_id), '') AS ccontact,
         lower(nullif(btrim(jb.client_email), '')) AS cmail, jb.site_address
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 jv AS (  -- job value exactly as the reference: price_inc, else quoted_value (zero counts as none)
  SELECT j.*,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN j.price_inc WHEN coalesce(j.quoted_value, 0) <> 0 THEN j.quoted_value END AS value,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN 'pricing_json.totalIncGST' WHEN coalesce(j.quoted_value, 0) <> 0 THEN 'jobs.quoted_value' END AS basis
  FROM j
 ),
 qs AS MATERIALIZED (SELECT * FROM public.context_job_quote_email_sends(p_job_ids, p_as_of)),
 qd AS (  -- quote documents as the reference reads them (type contains "quote"), stamps after p_as_of unset
  SELECT d.id, d.job_id, d.quote_number, d.version, d.created_at,
         coalesce(CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END,
                  (SELECT es.sent_at FROM qs es WHERE es.document_id = d.id)) AS sent_at,
         CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END AS accepted_at,
         CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END AS declined_at,
         CASE WHEN d.superseded_at <= p_as_of THEN d.superseded_at END AS superseded_at
  FROM public.job_documents d
  WHERE d.job_id = ANY (p_job_ids) AND d.type ILIKE '%quote%' AND d.created_at <= p_as_of
 ),
 si AS (  -- customer invoices by p_as_of (deleted and voided never count) and what their lines say
  SELECT x.id, x.job_id, x.invoice_number, nullif(btrim(x.xero_contact_id), '') AS xc, x.job_contact_id, x.total, x.created_at,
         upper(coalesce(x.status, 'NONE')) AS st,
         coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) AS at,
         (upper(coalesce(x.status, '')) = 'PAID' OR (upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED') AND coalesce(x.amount_paid, 0) > 0)) AS paid,
         coalesce((x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth'), (x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) AS paid_at,
         (upper(coalesce(x.reference, '')) ~ '-DEP[0-9]{0,3}(-[A-Z])?$' OR coalesce(ln.dep_word, false)
          OR x.xero_invoice_id = j.dep_inv OR x.id::text = j.dep_inv) AS deposit,
         (upper(coalesce(x.reference, '')) ~ '-(FINBAL|FIN|BAL)[0-9]{0,3}(-[A-Z])?$' OR coalesce(ln.final_word, false)) AS final,
         ln.base, coalesce(ln.pct, substring(upper(coalesce(x.reference, '')) FROM '-DEP([0-9]{1,3})(?:-[A-Z])?$')::numeric) AS pct
  FROM public.xero_invoices x JOIN j ON j.id = x.job_id
  LEFT JOIN LATERAL (
   SELECT bool_or(li ->> 'Description' ~* 'deposit') AS dep_word,
          bool_or(li ->> 'Description' ~* '^\s*(balance|final)') AS final_word,
          -- "Deposit (25% of $10,406.00 inc GST)": the line's own base
          (array_agg(replace((regexp_match(li ->> 'Description', '[0-9]{1,3}(?:\.[0-9]+)?% of \$([0-9][0-9,]*(?:\.[0-9]{1,2})?)'))[1], ',', '')::numeric)
            FILTER (WHERE li ->> 'Description' ~ '[0-9]{1,3}(\.[0-9]+)?% of \$[0-9]'))[1] AS base,
          -- "50% Deposit", "Deposit (50% ..."
          (array_agg(coalesce((regexp_match(li ->> 'Description', '([0-9]{1,3})\s*%\s*deposit', 'i'))[1],
                              (regexp_match(li ->> 'Description', 'deposit\s*\(\s*([0-9]{1,3})(?:\.[0-9]+)?\s*%', 'i'))[1])::numeric)
            FILTER (WHERE li ->> 'Description' ~* '([0-9]{1,3}\s*%\s*deposit|deposit\s*\(\s*[0-9]{1,3}(\.[0-9]+)?\s*%)'))[1] AS pct
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li) ln ON true
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
    AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(x.status, '')) NOT IN ('DELETED', 'VOIDED')
 ),
 acc AS (
  SELECT jv.*,
         (SELECT min(q.accepted_at) FROM qd q WHERE q.job_id = jv.id) AS quote_acc,
         (SELECT min(s.paid_at) FROM si s WHERE s.job_id = jv.id AND s.deposit AND s.paid AND s.paid_at <= p_as_of) AS dep_acc,
         (SELECT sum(coalesce(s.total, 0)) FROM si s WHERE s.job_id = jv.id AND s.st <> 'DRAFT') AS issued
  FROM jv
 ),
 v AS (
  SELECT a.*, (a.job_acc IS NOT NULL OR a.quote_acc IS NOT NULL OR a.dep_acc IS NOT NULL) AS accepted,
         coalesce(a.job_acc, a.quote_acc, a.dep_acc) AS acc_at,
         CASE WHEN a.job_acc IS NOT NULL THEN 'job' WHEN a.quote_acc IS NOT NULL THEN 'quote' WHEN a.dep_acc IS NOT NULL THEN 'deposit' END AS acc_by
  FROM acc a
 ),
 -- (story safety, fourth and sixth review) customer invoices placed elsewhere that may bill
 -- this job, recorded by p_as_of and made no earlier than 30 days before the job, read only
 -- while this job's own issued invoices fall short of its accepted value (when R8 would
 -- fire), so a job billed elsewhere never reads "not yet invoiced" as fact. Each is tied to
 -- the job one way (the first that holds):
 --  names: on no job or another job, its reference or lines name this job's number (base: a
 --         line naming this job that says it is a share, "50% of $748.01");
 --  contact (sixth review): on no job and addressed to this job's own Xero contact, so a job
 --         with no number is read too (bda6e1de, the rest of its quote billed to its own contact
 --         on an invoice never placed on it); never on builder work, where every job's contact is
 --         the builder (there an invoice must name the job). (Eighth review) Its own contact is its
 --         customer's, as the client story reads it: the job's, its primary party's, or one on its
 --         own invoices addressed to the customer (payer role customer); never a neighbour's, the
 --         strata's, another party's or another payer's (an agency paying part of a tenant's job
 --         holds invoices for its other properties);
 --  neighbour (eighth review): on no job and addressed to a neighbour paying part of this job (a
 --         job_contacts party, by its Xero contact): their share may sit there under a mistyped
 --         reference, so what is left to invoice is not known; named as theirs, never as this
 --         job's own contact's;
 --  site (sixth review): on this client's other job (CRM contact or client email) of the same
 --         kind at the same site address, a duplicate record of it (SWP-25005's work billed and
 --         paid on SWP-26041, its invoices naming the quote, never the job).
 w AS (SELECT v.* FROM v WHERE v.accepted AND v.value IS NOT NULL AND v.value - coalesce(v.issued, 0) > 1),
 wx AS (  -- this job's own Xero contacts: its customer's (eighth review)
  SELECT DISTINCT w.id AS job_id, z.x
  FROM w CROSS JOIN LATERAL (
   SELECT w.jxc AS x
   UNION SELECT nullif(btrim(c.xero_contact_id), '') FROM public.job_contacts c
    WHERE c.job_id = w.id AND c.removed_at IS NULL AND (coalesce(c.is_primary, false) OR coalesce(c.contact_type, '') = 'primary')
   UNION SELECT s.xc FROM si s
    WHERE s.job_id = w.id AND public.context_job_record_payer_role(s.job_id, w.jtype, w.jxc, s.xc, s.job_contact_id) = 'customer') z
  WHERE z.x IS NOT NULL AND w.jtype NOT IN ('makesafe', 'repair', 'insurance')
 ),
 wn AS (  -- (eighth review) the neighbours paying part of this job, by their Xero contacts
  SELECT DISTINCT w.id AS job_id, nullif(btrim(c.xero_contact_id), '') AS x
  FROM w JOIN public.job_contacts c ON c.job_id = w.id AND c.removed_at IS NULL
  WHERE coalesce(c.contact_type, '') ILIKE 'neighbour%' AND NOT coalesce(c.is_primary, false)
    AND nullif(btrim(c.xero_contact_id), '') IS NOT NULL AND w.jtype NOT IN ('makesafe', 'repair', 'insurance')
 ),
 ws AS (  -- this client's other jobs of the same kind at the same site address
  SELECT w.id AS job_id, o.id AS other_id
  FROM w JOIN public.jobs o ON o.id <> w.id AND o.type::text = w.jtype
   AND ((w.ccontact IS NOT NULL AND o.ghl_contact_id = w.ccontact)
        OR (w.cmail IS NOT NULL AND o.client_email IS NOT NULL AND lower(btrim(o.client_email)) = w.cmail))
  WHERE public.context_address_key(o.site_address) = public.context_address_key(w.site_address)
     OR nullif(lower(regexp_replace(coalesce(o.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
        = nullif(lower(regexp_replace(coalesce(w.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
 ),
 ex AS (
  SELECT y.* FROM (
   SELECT w.id AS job_id, x.id, x.invoice_number, upper(coalesce(x.status, '')) AS st, x.total, x.amount_due, x.contact_name,
          coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) AS at,
          (SELECT o.job_number FROM public.jobs o WHERE o.id = x.job_id) AS on_job, nm.base,
          CASE WHEN nm.names THEN 'names'
               WHEN x.job_id IS NULL AND EXISTS (SELECT 1 FROM wx WHERE wx.job_id = w.id AND wx.x = nullif(btrim(x.xero_contact_id), '')) THEN 'contact'
               WHEN x.job_id IS NULL AND EXISTS (SELECT 1 FROM wn WHERE wn.job_id = w.id AND wn.x = nullif(btrim(x.xero_contact_id), '')) THEN 'neighbour'
               WHEN EXISTS (SELECT 1 FROM ws WHERE ws.job_id = w.id AND ws.other_id = x.job_id) THEN 'site' END AS tie
   FROM w
   CROSS JOIN LATERAL (
    SELECT x.* FROM public.xero_invoices x
    WHERE x.job_id IS DISTINCT FROM w.id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
      AND upper(coalesce(x.status, '')) IN ('DRAFT', 'AUTHORISED', 'SUBMITTED', 'PAID')
      AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
      AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) >= w.created_at - interval '30 days') x
   CROSS JOIN LATERAL (
    SELECT bool_or(true) AS names,
           (array_agg(replace((regexp_match(t.d, '[0-9]{1,3}(?:\.[0-9]+)?% of \$([0-9][0-9,]*(?:\.[0-9]{1,2})?)'))[1], ',', '')::numeric ORDER BY t.o)
             FILTER (WHERE t.d ~ '[0-9]{1,3}(\.[0-9]+)?% of \$[0-9]'))[1] AS base
    FROM (SELECT x.reference AS d, 0 AS o
          UNION ALL
          SELECT li ->> 'Description', 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li) t
    -- the whole job number, never a longer one it begins (SWF-2699 is not SWF-26997)
    WHERE w.jnum IS NOT NULL AND strpos(upper(t.d), w.jnum) > 0
      AND EXISTS (SELECT 1 FROM regexp_matches(t.d, '(SW[A-Z]{0,4}-[0-9]+)', 'gi') r WHERE upper(r[1]) = w.jnum)) nm
  ) y
  WHERE y.tie IS NOT NULL
 ),
 c AS (
  -- (972) an accepted quote's value differs from the job value
  SELECT q.job_id, 1 AS p, jsonb_build_object('table', 'job_documents', 'id', q.document_id::text, 'at', q.accepted_at,
          'amount', q.accepted_value - v.value,
          'what', 'Accepted quote value ' || to_char(q.accepted_value, 'FM$999,999,990.00') || ' differs from the job value '
                  || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM (SELECT qd.job_id, (array_agg(qd.id ORDER BY qd.accepted_at DESC))[1] AS document_id, max(qd.accepted_at) AS accepted_at,
               sum(qv.value_inc_gst) AS accepted_value, count(qv.value_inc_gst) AS valued, count(*) AS n
        FROM qd
        LEFT JOIN LATERAL (SELECT x.value_inc_gst FROM public.job_quote_values(qd.job_id) x WHERE x.document_id = qd.id LIMIT 1) qv ON true
        WHERE qd.accepted_at IS NOT NULL GROUP BY qd.job_id) q
  JOIN v ON v.id = q.job_id
  WHERE q.valued = q.n AND v.value IS NOT NULL AND abs(q.accepted_value - v.value) > 1
  UNION ALL
  -- (972) issued invoices exceed the job value
  SELECT v.id, 2, jsonb_build_object('table', 'jobs', 'id', v.id::text, 'at', p_as_of, 'amount', s.issued - v.value,
          'what', 'Issued invoices ' || to_char(s.issued, 'FM$999,999,990.00') || ' exceed the job value ' || to_char(v.value, 'FM$999,999,990.00')
                  || ' (' || v.basis || ')')
  FROM v JOIN LATERAL (SELECT sum(coalesce(x.total, 0)) AS issued FROM si x
                       WHERE x.job_id = v.id AND x.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) s ON true
  WHERE v.value IS NOT NULL AND s.issued > v.value + 1
  UNION ALL
  -- an issued invoice's line names its own base: "Deposit (20% of $12,000.00 inc GST)"; on an
  -- invoice placed elsewhere, a line naming this job ("Remainder of quote SWF-26368 (50% of
  -- $748.01 inc GST)" on another job's invoice; story safety, fourth review)
  SELECT z.job_id, z.p, z.o FROM (
  SELECT DISTINCT ON (s.job_id) s.job_id, 3 AS p, jsonb_build_object('table', 'xero_invoices', 'id', s.id::text, 'at', s.at, 'amount', s.base - v.value,
          'what', 'Invoice ' || coalesce(s.invoice_number, 'without a number')
                  || CASE WHEN s.placed IS NULL THEN ' says it is a share of ' ELSE ' (' || s.placed || ') says this job is a share of ' END
                  || to_char(s.base, 'FM$999,999,990.00') || '; the job value is ' || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM (SELECT s.job_id, s.id, s.invoice_number, s.at, s.st, s.base, NULL::text AS placed FROM si s
        UNION ALL
        SELECT e.job_id, e.id, e.invoice_number, e.at, e.st, e.base, coalesce('placed on job ' || e.on_job, 'placed on no job') FROM ex e) s
  JOIN v ON v.id = s.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND s.base IS NOT NULL AND abs(s.base - v.value) > 1
  ORDER BY s.job_id, s.at DESC, s.id) z
  UNION ALL
  -- a deposit's percentage, where no line names the base: every issued deposit invoice
  -- at that percentage, added up, is that share of the price (one paying contact only)
  SELECT z.job_id, z.p, z.o FROM (
  SELECT DISTINCT ON (g.job_id) g.job_id, 4 AS p, jsonb_build_object('table', 'xero_invoices', 'id', g.newest_id::text, 'at', g.at,
          'amount', round(g.implied - v.value, 2),
          'what', 'Deposit invoice ' || coalesce(g.newest_number, 'without a number') || ' is ' || rtrim(to_char(g.pct, 'FM990.99'), '.')
                  || '% of the price, which makes the price ' || to_char(g.implied, 'FM$999,999,990.00') || '; the job value is '
                  || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM (SELECT s.job_id, s.pct, round(sum(coalesce(s.total, 0)) / (s.pct / 100), 2) AS implied,
               (array_agg(s.id ORDER BY s.at DESC, s.id))[1] AS newest_id,
               (array_agg(s.invoice_number ORDER BY s.at DESC, s.id))[1] AS newest_number, max(s.at) AS at
        FROM si s
        WHERE s.deposit AND s.base IS NULL AND s.pct > 0 AND s.pct <= 100 AND s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
          AND (SELECT count(DISTINCT x.xc) FROM si x WHERE x.job_id = s.job_id AND x.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) <= 1
        GROUP BY s.job_id, s.pct) g
  JOIN v ON v.id = g.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND abs(g.implied - v.value) > 1
  ORDER BY g.job_id, g.at DESC, g.pct) z
  UNION ALL
  -- the newest sent quote still standing (none accepted) is valued differently
  SELECT q.job_id, 5, jsonb_build_object('table', 'job_documents', 'id', q.id::text, 'at', q.sent_at, 'amount', qv.value_inc_gst - v.value,
          'what', 'The newest sent quote ' || coalesce(q.quote_number, 'without a number') || coalesce(' v' || q.version, '') || ' is '
                  || to_char(qv.value_inc_gst, 'FM$999,999,990.00') || '; the job value is ' || to_char(v.value, 'FM$999,999,990.00')
                  || ' (' || v.basis || ')')
  FROM (SELECT DISTINCT ON (d.job_id) d.* FROM qd d WHERE d.sent_at IS NOT NULL ORDER BY d.job_id, d.sent_at DESC, d.created_at, d.id) q
  JOIN v ON v.id = q.job_id
  CROSS JOIN LATERAL (SELECT x.value_inc_gst FROM public.job_quote_values(q.job_id) x WHERE x.document_id = q.id LIMIT 1) qv
  WHERE v.accepted AND v.value IS NOT NULL AND q.superseded_at IS NULL AND q.declined_at IS NULL AND q.accepted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM qd a WHERE a.job_id = q.job_id AND a.accepted_at IS NOT NULL)
    AND qv.value_inc_gst IS NOT NULL AND abs(qv.value_inc_gst - v.value) > 1
  UNION ALL
  -- a final or balance invoice is issued and the invoices still fall short of the value
  SELECT z.job_id, z.p, z.o FROM (
  SELECT DISTINCT ON (s.job_id) s.job_id, 6 AS p, jsonb_build_object('table', 'xero_invoices', 'id', s.id::text, 'at', s.at,
          'amount', v.issued - v.value,
          'what', 'Final invoice ' || coalesce(s.invoice_number, 'without a number') || ' is issued and the issued invoices total '
                  || to_char(v.issued, 'FM$999,999,990.00') || ', ' || to_char(v.value - v.issued, 'FM$999,999,990.00')
                  || ' less than the job value ' || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM si s JOIN v ON v.id = s.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND s.final AND s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
    AND v.value - coalesce(v.issued, 0) > 1
  ORDER BY s.job_id, s.at DESC, s.id) z
  UNION ALL
  -- the job has quotes and the app records none sent: the value is a quote's the app
  -- has no record of sending (it may have gone another way: an accepted and paid job can
  -- carry it, so the words never say the quote was not sent)
  SELECT q.job_id, 7, jsonb_build_object('table', 'job_documents', 'id', q.id::text, 'at', q.created_at, 'amount', NULL,
          'what', 'The job value ' || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ') comes from quote '
                  || coalesce(q.quote_number, 'without a number') || coalesce(' v' || q.version, '')
                  || '; the app has no record of this quote being sent')
  FROM (SELECT DISTINCT ON (d.job_id) d.* FROM qd d ORDER BY d.job_id, d.created_at DESC, d.id) q
  JOIN v ON v.id = q.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qd s WHERE s.job_id = q.job_id AND s.sent_at IS NOT NULL)
  UNION ALL
  -- (story safety, fourth and sixth review) an invoice placed elsewhere ties to this job
  -- (ex: it names the job, is on no job addressed to the job's own Xero contact, or is on
  -- this client's other job of the same kind at the same site address) while its own issued
  -- invoices fall short of the value: it may bill this job, so what is left to invoice is
  -- not known (SWF-26997's builder invoice placed on no job; SWF-26368's remainder billed on
  -- a sibling job; bda6e1de's remainder to its own contact on no job; SWP-25005 billed on
  -- its duplicate record SWP-26041)
  SELECT e.job_id, 8, jsonb_build_object('table', 'xero_invoices', 'id', e.id::text, 'at', e.at, 'amount', e.total,
          'what', CASE WHEN e.st = 'DRAFT' THEN 'Draft invoice ' ELSE 'Invoice ' END || coalesce(e.invoice_number, 'without a number')
                  || ' (' || to_char(coalesce(e.total, 0), 'FM$999,999,990.00') || ', ' || lower(e.st)
                  || CASE e.tie
                      WHEN 'names' THEN ') names this job but is placed ' || coalesce('on job ' || e.on_job, 'on no job')
                      WHEN 'contact' THEN CASE WHEN e.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(e.amount_due, 0) > 0
                                               THEN ', ' || to_char(e.amount_due, 'FM$999,999,990.00') || ' owing' ELSE '' END
                                          || ') is addressed to this job''s Xero contact but is placed on no job'
                      -- (eighth review) a neighbour's, named as theirs
                      WHEN 'neighbour' THEN CASE WHEN e.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(e.amount_due, 0) > 0
                                                 THEN ', ' || to_char(e.amount_due, 'FM$999,999,990.00') || ' owing' ELSE '' END
                                            || ') is addressed to ' || coalesce(nullif(btrim(e.contact_name), ''), 'a neighbour')
                                            || ', a neighbour paying part of this job, but is placed on no job'
                      ELSE ') is on job ' || coalesce(e.on_job, 'without a number')
                           || ', this client''s other job of this kind at the same site address' END
                  || '; this job''s own issued invoices total '
                  || to_char(coalesce(v.issued, 0), 'FM$999,999,990.00') || ' against the job value ' || to_char(v.value, 'FM$999,999,990.00')
                  || ' (' || v.basis || ')')
  FROM ex e JOIN v ON v.id = e.job_id
  UNION ALL
  -- (story safety, sixth review) the value was set from the CRM (pricing_json.source ghl: an
  -- opportunity's value; $1,000.00 is the import's placeholder, 477 jobs carry it) and nothing
  -- on the job backs it, no quote and no issued invoice line naming it as its base: what is
  -- left to invoice is not known (bda6e1de: a $1,000.00 value, the rest of a real quote billed
  -- elsewhere)
  SELECT w.id, 9, jsonb_build_object('table', 'jobs', 'id', w.id::text, 'at', w.created_at, 'amount', NULL,
          'what', 'The job value ' || to_char(w.value, 'FM$999,999,990.00') || ' (' || w.basis || ') '
                  || CASE WHEN w.psrc = 'ghl' THEN 'was set from the CRM (pricing_json.source ghl)'
                          ELSE 'is $1,000.00, the CRM import''s placeholder' END
                  || ' and no quote on the job backs it')
  FROM w
  WHERE (w.psrc = 'ghl' OR w.value = 1000)
    AND NOT EXISTS (SELECT 1 FROM qd q WHERE q.job_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM si s WHERE s.job_id = w.id AND s.base IS NOT NULL AND abs(s.base - w.value) <= 1)
 )
 SELECT v.id AS job_id, v.value, v.basis AS value_basis, v.accepted, v.acc_at AS accepted_at, v.acc_by AS accepted_by,
        coalesce(v.issued, 0) AS issued,
        coalesce((SELECT jsonb_agg(c.o || jsonb_build_object('kind', c.p) ORDER BY c.p, c.o ->> 'id' COLLATE "C") FROM c WHERE c.job_id = v.id),
                 '[]'::jsonb) AS checks
 FROM v
$function$;
COMMENT ON FUNCTION public.context_job_record_value(uuid[],timestamp with time zone) IS 'Story safety (20261006040000): per job the value (pricing_json.totalIncGST, else jobs.quoted_value; zero is none), whether it is accepted (the job row''s acceptance, an accepted quote, or a paid deposit invoice: reference DEP<n>, a line about a deposit or the job''s deposit invoice, PAID or with a payment, by p_as_of), when and by which, the issued customer invoices, and checks: each way the records disagree with the value (kind 1 the accepted quote and kind 2 invoices above the value, as 972 had them; on an accepted job also kind 3 an invoice line''s own base, or a line naming this job on an invoice placed on no job or on another job, kind 4 a deposit''s percentage with one paying contact, kind 5 the newest sent quote still standing, kind 6 a final invoice issued below the value, kind 7 a value from a quote the app has no record of sending, worded so: it may have gone another way, kind 8 a customer invoice (draft or issued) placed elsewhere while this job''s own issued invoices fall short of the value: on no job or another job whose reference or lines name this job''s number, or (sixth review) on no job addressed to this job''s own Xero contact (eighth review: its customer''s, as the client story reads it: the job''s, its primary party''s, or one on its own invoices addressed to the customer; never a neighbour''s, the strata''s, another party''s or another payer''s; never on builder work, where every job''s contact is the builder), or (eighth review) on no job addressed to a neighbour paying part of this job (a job_contacts party by its Xero contact: their share may sit there; named as theirs), or on this client''s other job (CRM contact or client email) of the same kind at the same site address; kind 9 (sixth review) a value set from the CRM, pricing_json.source ghl or the import''s $1,000.00 placeholder, that no quote on the job and no issued invoice line naming it as its base backs, while the issued invoices fall short of it), each {table, id, at, amount, what, kind}. Any check makes the value unconfirmed. Read by the record loops (R8, C2) and the money rows. Service role only. Story card causes (20261014120000): a captured sent email with its exact stored quote attachment also proves sent_at through context_job_quote_email_sends; no document or invoice is updated.';

CREATE OR REPLACE FUNCTION public.context_job_story_held(p_job_id uuid, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH h AS (
  SELECT r.*, row_number() OVER (ORDER BY r.at DESC, r.src_id DESC) AS n
  FROM public.context_ledger_held_rows(ARRAY[p_job_id], p_as_of) r
 )
 SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
   'label', CASE WHEN bool_and(h.same_contact) THEN 'From this customer, job not certain'
                 ELSE 'May be about this job, job not certain' END,
   'certainty', 'job_not_certain',
   'count', count(*),
   'shown', count(*) FILTER (WHERE h.n <= 25),
   'newest_at', max(h.at), 'oldest_at', min(h.at),
   -- the newest the customer sent (not ours, not automated), so a waiting question is not missed
   'newest_customer_at', max(h.at) FILTER (WHERE h.same_contact AND h.direction = 'inbound' AND NOT h.ours AND NOT h.automated),
   'other_jobs', (SELECT coalesce(jsonb_agg(o.x ORDER BY o.x COLLATE "C"), '[]'::jsonb)
                  FROM (SELECT DISTINCT unnest(h2.other_jobs) AS x FROM h h2) o),
   'why', 'These messages are placed on no job, because each fits more than one job or its match was not certain. '
          || 'Each is shown on every job it could belong to. None is counted as this job''s message and no note cites one.',
   'items', jsonb_agg(jsonb_build_object(
      't', h.src_table, 'id', h.src_id, 'at', h.at, 'channel', h.channel, 'kind', h.kind, 'direction', h.direction,
      'from', h.sender, 'from_role', h.sender_role, 'ours', h.ours, 'automated', h.automated, 'subject', h.subject,
      'text', left(h.body, CASE WHEN h.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END),
      'cut', length(h.body) > CASE WHEN h.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END,
      'job_certain', false,
      'label', CASE WHEN h.same_contact THEN 'from this customer, job not certain' ELSE 'may be about this job, job not certain' END,
      'from_this_customer', h.same_contact,
      'held_rule', h.held_rule,
      'held_because', CASE h.held_rule
        WHEN 'review_several' THEN 'the customer has several jobs'
        WHEN 'review_recent_other_job' THEN 'the customer has another recent job'
        WHEN 'review_aftercare' THEN 'it arrived after the job was finished'
        WHEN 'review_identity_conflict' THEN 'the contact details fit more than one person'
        WHEN 'site_address_several' THEN 'the address fits several jobs'
        WHEN 'site_address_loose' THEN 'the address match is not exact'
        WHEN 'multi_ref' THEN 'it names several jobs'
        ELSE 'the job is not certain' END,
      'candidate_jobs', h.candidate_jobs, 'other_jobs', to_jsonb(h.other_jobs))
      ORDER BY h.at DESC, h.src_id DESC) FILTER (WHERE h.n <= 25))
 END
 FROM h
$function$;
COMMENT ON FUNCTION public.context_job_story_held(uuid,timestamp with time zone) IS 'Held messages (20261012100000): the story''s held_messages for one job as of an instant, or null when the job has none: {label, certainty job_not_certain, count, shown, newest_at, oldest_at, newest_customer_at, other_jobs, why, items} over context_ledger_held_rows (the messages placed on no job that could be this job''s). label: "From this customer, job not certain" when every one is this job''s customer''s (same_contact), else "May be about this job, job not certain". count: all of them; items: the newest 25, newest first, each {t, id, at, channel, kind, direction, from, from_role, ours, automated, subject, text (400 characters) and cut, job_certain false, label, from_this_customer, held_rule, held_because (the rule in words), candidate_jobs, other_jobs}; shown: how many items; newest_customer_at: the newest inbound one from this job''s customer that is not ours or automated; other_jobs: every other job number any of them could belong to, C order. Shown only: none is counted as the job''s message, cited by a note or placed. Read by context_job_story. Service role only. Story card causes (20261014120000): held text uses 6000 characters for transcripts/documents and 3000 otherwise, with cut; certainty unchanged.';

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
$function$;
COMMENT ON FUNCTION public.context_ledger_evidence_rows(uuid[],timestamp with time zone) IS 'Context ledger store (20261006013000), story safety (20261006040000): a CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the story times it; landed_at stays its load), and one the CRM dates more than 30 days before the job was created (before its lead window) is left out: it is not this job''s evidence; (sixth review) so is one whose CRM time is no longer kept (its load time is not when it was sent). A legacy mail is left out for a business_events copy on the same job (source pointer, graph key, payload inbox_events_id, or an email from the same sender at the same instant), and (seventh review) for one on another live job (source pointer, graph key or payload inbox_events_id: that job''s reader reads it, as the job conversation''s rule R0 places it; eighth review: live is the judge''s live set, never archived, complete, completed, cancelled, lost, a draft or holding); a copy unplaced or on a job that is not live (a bucket) no longer hides it, so each email reaches one job''s reader once. Such a mail is in the evidence from its own landing, but its landed_at is when it joined the job''s evidence: no earlier than this rule''s first apply, its copies'' landing where they sit and (eighth review) the time a copy left a live job (context_ledger_mail_copies), so a reading built before then never counts it as read. Earlier: the admissible worded evidence of the given jobs as of an instant, oldest first: business_events rows passing context_ledger_row_admissible, plus legacy inbox_events mail placed on the job, or from the client''s address and placed on no job (placed_on this_job or none; mail placed on another job stays there; unplaced mail only when the client has no other job by CRM contact or client email, and from 30 days before the job was created), with no business_events copy (source pointer, graph key, payload inbox_events_id, or the same sender at the same instant), spam, newsletters and auto-replies left out. has_transcript on a call log: its transcript (payload.ghl_call_id or key ghltx:<id> naming the call''s ghl:<id>) is on the job. call_customer on a transcript: context_ledger_call_customer (its call''s customer stamp, the citation check''s rule). copy_of names the earlier row when this row is a copy (same channel, direction, sender address and words within 120 seconds); nothing is changed. Placement is read as it is now. Service role only. Story card causes (20261014120000): message body includes labelled forwarded correspondence through context_story_message_text. Admission, placement and landing time are unchanged.';

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
COMMENT ON FUNCTION public.context_ledger_cite(uuid,jsonb) IS 'Context ledger store (20261006013000), story safety (20261006040000): an inbox_events mail is refused for a business_events copy only when the copy is on this job or (seventh review) on another live job, which decides where the mail belongs (as the evidence reads it; eighth review: live is the judge''s live set, never archived, complete, completed, cancelled, lost, a draft or holding), so every mail citation accepted before is still accepted and a mail whose copy sits unplaced or on a job that is not live (a bucket) can now be cited. A CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the evidence times it), and one the CRM dates more than 30 days before the job was created is refused (citation_not_admissible), as the evidence leaves it out; (sixth review) so is one whose CRM time is no longer kept (neither in context_crm_message_times nor the cache). Earlier: checks one {table, id, excerpt} citation for a job: an allowed table; a business_events row on this job that is ledger evidence (context_ledger_row_admissible: linked, not retracted, written as service_role, worded, a message); a call transcript counts as the customer''s only when its call (ghl:<id>) is stamped with the job''s customer; an inbox_events mail placed on the job, or from the client''s address and placed on no job when the client has no other job and the mail is from 30 days before the job on, with no business_events copy; a record row (job_documents, xero_invoices, job_assignments, job_events, email_events) on this job. A worded evidence row needs an excerpt that, quotes straightened and whitespace collapsed, is in its subject and text, and is at least 12 characters or 3 words unless it is the whole row, subject or body. close_at: when the row can close an item (a worded row: its time; a document: sent_at; an invoice: only AUTHORISED, SUBMITTED or PAID, and a payment only PAID, at its paid day (paid_at); a booking: attendance, completed_at, else started_at, else a status-only completion at the end of its booked Perth day or, while that is ahead, now; a system email (email_events): only sent, delivered or accepted with a sent time, at sent_at; an app event (job_events): its time, closing only the matter it records (context_ledger_job_event_closes on kind); a document our system emailed (job_documents, or a job_events row naming its document_id): no earlier than its first email sent, delivered or accepted with a sent time, never while every one bounced or failed; a system email closes only its own matter (context_ledger_email_closes on kind); null when it cannot); kind: an app event''s event_type or a system email''s email_type; made_at: a standing booking''s created time (it closes a booking_made item; not standing = cancelled, deleted, draft, disputed, declined). Refusal codes citation_shape, citation_table_not_allowed, citation_missing, citation_off_job, citation_not_admissible, excerpt_required, excerpt_not_verbatim, excerpt_too_long, excerpt_too_short. Service role only. Story card causes (20261014120000): a placed admissible message may quote its labelled forwarded correspondence, the same text the evidence reader receives; no placement or close-time rule changes.';

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
$function$;
COMMENT ON FUNCTION public.context_ledger_held_rows(uuid[],timestamp with time zone) IS 'Held messages (20261012100000): for each given job, the messages placed on no job that could be that job''s, as of an instant, oldest first: business_events rows with no job, attribution status unplaced or pending_luna, whose stored candidate_job_ids contain the job (the placement ladder''s own candidates; nearly always the customer has several jobs and the message fits more than one). Admitted as the evidence rows are apart from placement: written as service_role, worded, a message kind, not status-only, timed, never retracted, never a marked copy (metadata.duplicate_of); a CRM text loaded later from the CRM''s cache is at the CRM''s own time, and one dated more than 30 days before the job was created, or whose CRM time is no longer kept, is left out. The same row is returned once for each candidate job asked for. Each: the evidence rows'' fields (at, landed_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject, body), held_rule (metadata.placement_rule, the rule that held it), held_status, candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and same_contact (the row''s CRM contact is the job''s, or its sender address the job''s client email: this job''s customer''s message). Nothing is placed, counted as the job''s or changed: these are never evidence rows, and context_ledger_cite still refuses one (citation_off_job). Read by context_ledger_packet (held) and context_job_story_held. Read by the index business_events_candidate_job_ids. Service role only. Story card causes (20261014120000): message body includes labelled forwarded correspondence through context_story_message_text. Candidates, certainty and admission are unchanged.';
