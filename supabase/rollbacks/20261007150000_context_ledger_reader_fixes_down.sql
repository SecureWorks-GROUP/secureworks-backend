-- Rollback of 20261007150000_context_ledger_reader_fixes: the four ledger store bodies go back to
-- 20261006013000's word for word (context_ledger_packet, context_ledger_write,
-- context_ledger_check_item, context_ledger_call_customer, with their comments; CREATE OR REPLACE
-- keeps their grants), then the five helpers it added are dropped. No row is written or deleted:
-- what a reader wrote under these rules stays as written. Refuses while a later body has replaced
-- one of the four (roll that back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE problems text[] := '{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_call_customer(public.business_events)', ARRAY['cd1cda0bb5bd1c5405001a1d6b670d5f', '23f31463321396e3e5fde6329e32c60e']),
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', ARRAY['76de45b9ee5c823593fb4b3fded873e3', '52bd1db9fb4b75fedd6cbfc755e806b3']),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', ARRAY['6da1007ff2a6331219f4d98f85749ca7', '7afbf2bbe6d5688219e743fda88b5eb2']),
  ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', ARRAY['423469bdff01ae4029c155f6c73c078d', '86bed4277fb61ce4679e5cd476001555'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_reader_fixes_down_refused: %; a later body is live, roll that back first',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- The four bodies and comments as 20261006013000 wrote them, word for word.
CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamptz DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
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
   'call_customer', sel.call_customer,
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
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open);
END $$;
COMMENT ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) IS
 'Context ledger store (20261006013000): ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only.';

CREATE OR REPLACE FUNCTION public.context_ledger_write(p_run_id uuid, p_lease_token uuid, p_generation_id uuid,
 p_items jsonb, p_transitions jsonb, p_reader text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
      chk := chk || jsonb_build_object('close_at', chk -> 'paid_at');
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
END $$;
COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000): writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only.';

CREATE OR REPLACE FUNCTION public.context_ledger_check_item(p_job_id uuid, p_item jsonb, p_writer text, p_person uuid DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_type text; v_status text; v_from text; v_to text; v_what text; v_about text; v_due date; v_basis text;
 v_open jsonb := '[]'; v_close jsonb := '[]'; c jsonb; chk jsonb; n integer := 0; v_opened_at timestamptz; v_closed_at timestamptz;
 v_any_customer boolean := false; v_any_us boolean := false; v_any_external boolean := false; v_due_ok boolean := false;
 v_first_customer boolean; v_first_us boolean; v_close_at timestamptz;
 v_key text; v_first text; v_facts jsonb := '[]'; f jsonb; v_supported date;
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
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'opened_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
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
                     THEN (chk ->> 'paid_at')::timestamptz ELSE (chk ->> 'close_at')::timestamptz END;
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
  v_closed_at := greatest(v_closed_at, v_close_at);
 END LOOP;
 IF v_status IN ('closed','declined') AND jsonb_array_length(v_close) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_without_evidence', 'detail', v_status || ' needs closed_by');
 END IF;
 IF v_status IN ('open','info') AND jsonb_array_length(v_close) > 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_by_on_open', 'detail', v_status || ' cannot carry closed_by');
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
 v_key := v_type || ':' || coalesce(v_about, 'none') || ':' || left(md5(v_first || lower(v_what)), 12);
 RETURN jsonb_build_object('ok', true, 'item', jsonb_build_object('ref', p_item ->> 'ref', 'item_key', v_key, 'item_type', v_type,
  'status', v_status, 'from_role', v_from, 'from_name', nullif(btrim(p_item ->> 'from_name'), ''), 'to_role', v_to,
  'to_name', nullif(btrim(p_item ->> 'to_name'), ''), 'what', v_what, 'about_key', v_about, 'modality', p_item ->> 'modality',
  'phase', p_item ->> 'phase', 'due_date', v_due, 'due_basis', v_basis, 'opened_at', v_opened_at, 'opened_by', v_open,
  -- never a close time still to come (a record dated ahead closes at the check)
  'closed_at', CASE WHEN v_closed_at > now() THEN now() ELSE v_closed_at END, 'closed_by', CASE WHEN jsonb_array_length(v_close) > 0 THEN v_close END,
  'closes_on', p_item ->> 'closes_on', 'supersedes_key', nullif(btrim(p_item ->> 'supersedes_key'), ''),
  'supersedes_ref', nullif(btrim(p_item ->> 'supersedes_ref'), ''), 'blocks', p_item ->> 'blocks',
  'needs_reply', CASE WHEN jsonb_typeof(p_item -> 'needs_reply') = 'boolean' THEN (p_item ->> 'needs_reply')::boolean END, 'also_concerns', nullif(btrim(p_item ->> 'also_concerns'), '')));
END $$;
COMMENT ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) IS
 'Context ledger store (20261006013000): checks one ledger item for a job and returns the row to insert or {ok false, code, detail}. Shape (types, roles, about_key vocabulary, modality, phase, status per type), every citation (context_ledger_cite), closed or declined needs closed_by and nothing open carries it; a closing citation must be able to close (close_at: no draft invoice, unsent document or unattended booking: closing_not_issued), may not be an opening citation (closing_is_opening) and is at or after the opening, strictly after for a request (closing_before_opening); speaker rules for the model on the first opening citation (customer: the job''s customer sent it; us: ours, a call, a note or a record; nothing only internal texts is to the customer), a due date only when an opening excerpt states it and that message is not automated (context_supported_due_date); what has em and en dashes replaced. opened_at and closed_at come from the cited rows, never the input, and closed_at is never later than now. item_key = type:about:first 12 hex of md5(first opening citation id || lower(what)). Service role only.';

CREATE OR REPLACE FUNCTION public.context_ledger_call_customer(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN e.event_type OPERATOR(pg_catalog.=) 'call.transcript_completed' THEN
  (SELECT pg_catalog.bool_or(coalesce(c.metadata OPERATOR(pg_catalog.#>>) '{party_roles,counterpart_role}' OPERATOR(pg_catalog.=) 'customer'
     AND c.metadata OPERATOR(pg_catalog.#>>) '{party_roles,basis}' OPERATOR(pg_catalog.=) 'job_customer', false))
   FROM public.business_events c
   WHERE c.job_id OPERATOR(pg_catalog.=) e.job_id
    AND c.event_type OPERATOR(pg_catalog.<>) 'call.transcript_completed'
    AND c.provider_message_id OPERATOR(pg_catalog.=) ('ghl:' OPERATOR(pg_catalog.||) coalesce(e.payload OPERATOR(pg_catalog.->>) 'ghl_call_id',
     CASE WHEN e.provider_message_id OPERATOR(pg_catalog.~~) 'ghltx:%' THEN pg_catalog.substr(e.provider_message_id, 7) END))) END
$$;
COMMENT ON FUNCTION public.context_ledger_call_customer(public.business_events) IS
 'Context ledger store (20261006013000): whether a call transcript is the customer''s words, on its call''s stamp: true when the linked call row on the same job (ghl:<payload.ghl_call_id>, else ghl:<id> from the transcript''s own key ghltx:<id>) is stamped counterpart_role customer with basis job_customer, false when a linked call row exists without that stamp, null when none is linked or the row is not a transcript. Read by context_ledger_cite and the packet (call_customer). A plain helper (no SET, not a definer, not inlined: it has a subquery). Service role only.';

-- The helpers, now read by nothing.
DROP FUNCTION IF EXISTS public.context_ledger_siblings(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.context_ledger_row_elsewhere(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.context_ledger_elsewhere_claim(text);
DROP FUNCTION IF EXISTS public.context_ledger_paid_close_at(timestamptz);
DROP FUNCTION IF EXISTS public.context_ledger_work_order_key(text);
