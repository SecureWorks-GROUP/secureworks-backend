-- Undo 20261104050000_context_ledger_replaced_by: context_ledger_write is the 20261007150000 definition again, word for word with its comment
-- (md5 bfe7aa27a44451a235af4da10004f61a; body md5 6da1007ff2a6331219f4d98f85749ca7), so a transition naming the note it repeats (replaced_by) is invalid_shape
-- again; context_ledger_same_loop is dropped, then context_ledger_transitions.replaced_by_key and its check.
-- Refuses once any move has named a note (a retired copy would lose the note it repeats): keep those rows and recover
-- forward instead. Refuses while a later body has replaced context_ledger_write (roll that back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $down$
DECLARE
  v_def text; v_used boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.context_ledger_transitions'::regclass AND attname = 'replaced_by_key' AND NOT attisdropped) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.context_ledger_transitions WHERE replaced_by_key IS NOT NULL)' INTO v_used;
  END IF;
  IF v_used THEN
    RAISE EXCEPTION 'context_ledger_replaced_by_down_refused: a superseded move names the note it repeats; keep it and recover forward';
  END IF;
  SELECT pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure) INTO v_def;
  IF md5(v_def) = 'bfe7aa27a44451a235af4da10004f61a' THEN
    RAISE NOTICE 'context_ledger_write is already the old definition';
    RETURN;
  END IF;
  IF md5(v_def) <> 'af7c768f7ef2d3e8b45bb0706a485194' THEN
    RAISE EXCEPTION 'context_ledger_write is not the 20261104050000 definition (md5 %); roll the later one back first', md5(v_def);
  END IF;
  -- The exact definition before 20261104050000 (md5 bfe7aa27a44451a235af4da10004f61a), as pg_get_functiondef printed it.
  EXECUTE $old_def$CREATE OR REPLACE FUNCTION public.context_ledger_write(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_items jsonb, p_transitions jsonb, p_reader text)
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
END $function$$old_def$;
  SELECT pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure) INTO v_def;
  IF md5(v_def) <> 'bfe7aa27a44451a235af4da10004f61a' THEN
    RAISE EXCEPTION 'context_ledger_write after the undo is not the old definition (md5 %)', md5(v_def);
  END IF;
END
$down$;

COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a transition closing a payment item on a PAID invoice closes it at the end of the invoice''s paid Perth day, never after now (context_ledger_paid_close_at), as an item''s closed_by does; items pass the item check''s new elsewhere_unsupported rule. Earlier: writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only.';

DROP FUNCTION IF EXISTS public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items);
ALTER TABLE public.context_ledger_transitions DROP CONSTRAINT IF EXISTS context_ledger_transitions_replaced_by_key_check;
ALTER TABLE public.context_ledger_transitions DROP COLUMN IF EXISTS replaced_by_key;
