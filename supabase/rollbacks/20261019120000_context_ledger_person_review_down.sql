-- Person review (18 Oct 2026) down.
-- Restores the four bodies this migration replaced, word for word, copies any stored
-- person_review into context_ledger_person_review_archive, then drops the column, the trigger,
-- the normaliser and the stored-shape check. Accepts this migration's bodies or the ones it
-- replaced (a second run, including after the column is already gone). Refuses any other body:
-- a later replacement has to roll this back while its own bodies are still live.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', ARRAY['3880b68edb0806ad5c5c448b24d54c15', 'af976e59b8e6f35612d6383042d6e38e']),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', ARRAY['a1391d76278839e1ad2ff0cfd08305cf', '3a9296d13a6543d2b4eecc11a5a469fb', '6da1007ff2a6331219f4d98f85749ca7']),
  ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', ARRAY['86870dff91163322bb98e1500f9648f3', '74c2b3fb592cc6a53ff5499170b9ef7a', '209d903df7a8732b4773dee0f0741593']),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', ARRAY['817453a22244213c2fd983f0dd4b6d66', '4e5cf782723cc108d161acfaeaada6ee', '09d28c282caf22c873f5673d7dd8073f'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_person_review_down_refused: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- The four earlier bodies, word for word.

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
COMMENT ON FUNCTION public.context_ledger_check_item(uuid,jsonb,text,uuid,text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a model item whose words say a row is someone else''s (its sender, caller or counterpart another person than this job''s customer, or a label saying so: context_ledger_elsewhere_claim) is refused elsewhere_unsupported when a cited row, opening or closing, is this job''s customer''s own words (customer_sender), when a cited row that is not a record or our own text, email or note (a call transcript never counts as ours alone) is not someone else''s by its own stamp (context_ledger_row_elsewhere: role_basis or call_not_customer), or when none is; a claim that a row concerns or belongs to another job is the reader''s placement judgement and stands (second review, 8 Oct); a person''s own item is their word. A PAID invoice closes a payment item (closes_on payment) at the end of its paid Perth day, never after now (context_ledger_paid_close_at), whatever the invoice''s date, so a request made the day it was paid is closed by it. Earlier: checks one ledger item for a job and returns the row to insert or {ok false, code, detail}. Shape (types, roles, about_key vocabulary, modality, phase, status per type), every citation (context_ledger_cite), closed or declined needs closed_by and nothing open carries it; a closing citation must be able to close (close_at: no draft invoice, unsent document or unattended booking: closing_not_issued), may not be an opening citation (closing_is_opening) and is at or after the opening, strictly after for a request (closing_before_opening); speaker rules for the model on the first opening citation (customer: the job''s customer sent it; us: ours, a call, a note or a record; nothing only internal texts is to the customer), a due date only when an opening excerpt states it and that message is not automated (context_supported_due_date); what has em and en dashes replaced. opened_at and closed_at come from the cited rows, never the input, and closed_at is never later than now. item_key = type:about:first 12 hex of md5(first opening citation id || lower(what)). Service role only. Held notes (20261015100000): while feature_flags.context_held_notes_v1 is on, an opening citation the citation check refuses as off the job may instead be a message held on no job with this job among its candidates (context_ledger_held_cite); the item is then marked job not certain (job_certain false, certainty job_not_certain in the returned item; the store stamps context_ledger_items.job_not_certain), must be open (held_not_open otherwise), and, when the held message is its first opening citation, is keyed by that message alone (type:about:first 12 hex of md5(''held:'' || its id)), so one held message opens at most one item of a type and matter on a job (a second is refused duplicate_item by the write). A held message never closes an item. Off: every check is as before.';

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
END $$;
COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a transition closing a payment item on a PAID invoice closes it at the end of the invoice''s paid Perth day, never after now (context_ledger_paid_close_at), as an item''s closed_by does; items pass the item check''s new elsewhere_unsupported rule. Earlier: writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_assemble(p_job jsonb, p_record jsonb, p_ledger jsonb, p_meta jsonb,
 p_as_of timestamptz, p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 WITH inp AS MATERIALIZED (
  SELECT x.*, CASE WHEN x.ins THEN 'the insured' WHEN x.bw THEN 'the job contact' ELSE 'the customer' END AS cust
  FROM (
  SELECT p_job AS job, coalesce(p_record, '{}'::jsonb) AS rec, coalesce(p_ledger, '{}'::jsonb) AS led,
         coalesce(p_meta, '{}'::jsonb) AS meta, p_as_of AS as_of, (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         p_since AS since,
         -- (eighth review) builder work: the builder is the customer
         coalesce(p_job ->> 'type' IN ('makesafe', 'repair', 'insurance'), false) AS bw,
         -- (ninth review) and the job's CRM contact (and client email) the insured's only when the
         -- make-safe details name the builder and the job's contact details sit on no other client's
         -- job (meta contact_shared.shared false): then the contact's messages are named the insured's
         -- and never change whose move on what the builder owes. A contact on another client's job is
         -- shared across clients, a builder's or an agent's (SWR-261488, SWMS-261065 and SWMS-261163:
         -- one builder-side contact on three clients' jobs), and with no builder named the client may
         -- be the customer (SWF-261111, SWF-261314: quoted to the client); either way, or when the
         -- meta does not say, the line calls its messages the job contact's and they may be about
         -- what the builder owes, so they hold the move as the customer's do
         (coalesce(p_job ->> 'type' IN ('makesafe', 'repair', 'insurance'), false)
          AND nullif(btrim(p_record -> 'facts' ->> 'builder'), '') IS NOT NULL
          AND coalesce((p_meta -> 'contact_shared' ->> 'shared')::boolean = false, false)) AS ins
  ) x
 ),
 -- (lead cutoff, 20261007010000) the lead rule's answer, passed in as record lead by the story
 -- read (context_lead_monitored_jobs): off when the job is a lead no longer followed up, still at
 -- quoted with no progress 28 days after the newer of its newest quote send and the customer's
 -- newest text, email or call, wherever it is placed (every customer contact this line names is
 -- one the rule counts). With no lead passed in (a caller of the pure assembler) the job is
 -- followed up. (Scoping pipeline, 20261009133000) A draft the rule does not monitor (state
 -- draft_quiet or draft_no_activity) is never off: its line is what it was, and only now.monitored
 -- says the rule does not monitor it. A lead's window is its job's own (context_lead_window_hours:
 -- 6 weeks on a patio job, else 4)
 ld AS (
  SELECT CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'monitored') = 'boolean'
               AND coalesce(inp.rec -> 'lead' ->> 'state', '') NOT LIKE 'draft\_%'
              THEN NOT (inp.rec -> 'lead' ->> 'monitored')::boolean
              ELSE false END AS off,
         CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'monitored') = 'boolean' THEN (inp.rec -> 'lead' ->> 'monitored')::boolean
              ELSE true END AS monitored,
         CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'cutoff_at') = 'string' THEN (inp.rec -> 'lead' ->> 'cutoff_at')::timestamptz END AS cutoff_at,
         public.context_lead_window_hours(inp.job ->> 'type') AS win_h
  FROM inp
 ),
 tl AS MATERIALIZED (
  SELECT t.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'timeline', '[]'::jsonb))
   AS t(at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric, party text, placement text,
        source_table text, source_id text, state text, made_at timestamptz)
 ),
 rl AS MATERIALIZED (
  SELECT l.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'loops', '[]'::jsonb))
   AS l(rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text, opened_at timestamptz,
        due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text, placement text)
 ),
 mo AS MATERIALIZED (
  SELECT m.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'money', '[]'::jsonb))
   AS m(party text, xero_contact_id text, invoiced numeric, paid numeric, credited numeric, owing numeric, overdue numeric,
        oldest_overdue_due date, drafts integer, draft_total numeric, invoices jsonb, job_value numeric, job_value_basis text,
        not_yet_invoiced numeric, supplier_bills jsonb)
 ),
 bk AS MATERIALIZED (  -- crew bookings (observer mirrors are not passed in)
  SELECT b.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'bookings', '[]'::jsonb))
   AS b(id text, scheduled_date date, status text, assignment_type text, crew_name text, created_at timestamptz,
        started_at timestamptz, completed_at timestamptz)
 ),
 qd AS MATERIALIZED (
  SELECT q.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'quotes', '[]'::jsonb))
   AS q(id text, quote_number text, version integer, sent_at timestamptz, accepted_at timestamptz, declined_at timestamptz,
        superseded_at timestamptz)
 ),
 cc AS MATERIALIZED (  -- records that may close a ledger item (closing evidence only)
  SELECT c.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'closing', '[]'::jsonb))
   AS c(closes_on text, about_key text, at timestamptz, t text, id text, what text)
 ),
 li AS MATERIALIZED (  -- ledger items of the generation shown, with the citation re-check result
                       -- (what with em and en dashes replaced, as the store now writes it)
  SELECT i.* FROM inp, jsonb_to_recordset((SELECT coalesce(jsonb_agg(x || jsonb_build_object('what',
            btrim(replace(regexp_replace(x->>'what', '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-')))), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(inp.led->'items', '[]'::jsonb)) x))
   AS i(item_key text, item_type text, status text, from_role text, from_name text, to_role text, to_name text, what text,
        about_key text, modality text, phase text, due_date date, opened_at timestamptz, opened_by jsonb, closed_at timestamptz,
        closed_by jsonb, closes_on text, supersedes_key text, blocks text, needs_reply boolean, written_by text,
        person_locked boolean, cites_ok boolean, cited jsonb)
 ),
 vis AS MATERIALIZED (SELECT li.* FROM li WHERE coalesce(li.cites_ok, true)),
 -- (story settled notes, 20261011120000) the newest ledger transition into each shown item's own
 -- status: when it closed, was declined, superseded or disputed, and the reader's reason. Only a
 -- move the reader judged counts: never the item's writing ("written": already in that status when
 -- written) or a rebuild copying it over ("carried forward from generation ..."), whose time is the
 -- write, not the event; a bare packet reference ("replaced by n6") is no reason (replaced_by names it)
 trn AS MATERIALIZED (
  SELECT DISTINCT ON (x ->> 'item_key' COLLATE "C") x ->> 'item_key' AS item_key, (x ->> 'at')::timestamptz AS at,
         CASE WHEN x ->> 'reason' ~ '^replaced by [a-z]*[0-9]+$' THEN NULL ELSE nullif(btrim(x ->> 'reason'), '') END AS reason,
         CASE WHEN jsonb_typeof(x -> 'evidence') = 'array' THEN x -> 'evidence' END AS evidence
  FROM inp CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(inp.led -> 'transitions') = 'array'
                                                        THEN inp.led -> 'transitions' ELSE '[]'::jsonb END) x
  JOIN vis v ON v.item_key = x ->> 'item_key' AND v.status = x ->> 'to_status'
  WHERE coalesce(x ->> 'reason', '') <> 'written' AND coalesce(x ->> 'reason', '') NOT LIKE 'carried forward from generation %'
  ORDER BY x ->> 'item_key' COLLATE "C", (x ->> 'at')::timestamptz DESC NULLS LAST, x ->> 'reason' COLLATE "C"
 ),
 -- (story settled notes) an issue or claim opened only on the customer's words: every row that
 -- opened it is the customer's (its own stamp, else the citation check's), so the story can say it
 -- is the customer's report, not yet checked, never work we owe as fact
 vcust AS (
  SELECT v.item_key FROM vis v
  WHERE v.item_type IN ('issue', 'claim') AND jsonb_typeof(v.opened_by) = 'array' AND jsonb_array_length(v.opened_by) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.opened_by) o
                    WHERE NOT coalesce(CASE WHEN jsonb_typeof(o -> 'customer') = 'boolean' THEN (o ->> 'customer')::boolean END,
                                       (SELECT bool_or((c ->> 'customer')::boolean) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.cited) = 'array'
                                                 THEN v.cited ELSE '[]'::jsonb END) c
                                        WHERE c ->> 'id' = o ->> 'id' AND jsonb_typeof(c -> 'customer') = 'boolean'),
                                       false))
 ),
 -- (story settled notes) an event the reader wrote from call logs alone (a call's provider status
 -- and duration, "no transcript is recorded"), once each call's transcript is on the job (meta
 -- call_transcripts, call row id to transcript id, from the story read): the transcript's own items
 -- say what was said, so the call-log event is not shown (SWF-261469: two "no transcript" events for
 -- calls whose transcripts landed minutes after the reader wrote them)
 evh AS (
  SELECT v.item_key FROM vis v, inp
  WHERE v.item_type = 'event' AND jsonb_typeof(inp.meta -> 'call_transcripts') = 'object'
    AND jsonb_typeof(v.opened_by) = 'array' AND jsonb_array_length(v.opened_by) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.opened_by) c
                    WHERE c ->> 'table' IS DISTINCT FROM 'business_events' OR NOT coalesce(inp.meta -> 'call_transcripts' ? (c ->> 'id'), false))
 ),
 led AS (  -- the generation shown (a JSON null generation is none), what its reader has not read yet,
           -- and the customer rows it has read (a candidate is judged only when its row is one)
  SELECT x.*,
         -- a finished reading is shown: live (promoted) or retired, or a shadow, which the
         -- story shows only when asked for it by id (the default view shows the live one),
         -- so a grade reads the line a promotion gives; a building or failed one never counts
         -- as read (story safety, 20261006040000, fourth review)
         (x.gen IS NOT NULL AND x.status IN ('live', 'retired', 'shadow')) AS live_read,
         -- and it has read every row on the job: none landed after it (an unknown count
         -- is not none). Only then may nothing open be an all-clear. (Eighth review) Nor while
         -- an item of its is hidden (a message it cites is no longer this job's evidence, or the
         -- citation check refuses it now): what it found is no longer whole until it is rebuilt
         -- (or, for a staff correction, a person checks it)
         (x.gen IS NOT NULL AND x.status IN ('live', 'retired', 'shadow')
          AND coalesce((inp.led->>'unread_rows')::integer = 0, false) AND x.hidden = 0) AS words_read,
         CASE WHEN x.gen IS NOT NULL THEN (inp.led->>'unread_rows')::integer END AS unread,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'unread_ids', '[]'::jsonb) END AS unread_ids,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'read_ids', '[]'::jsonb) END AS read_ids
  FROM inp, LATERAL (
   SELECT coalesce(nullif(inp.led->>'status', ''), 'none') AS status, nullif(inp.led->'generation', 'null'::jsonb) AS gen,
          (inp.led->'generation'->>'evidence_until')::timestamptz AS evidence_until,
          (SELECT count(*) FROM vis) AS items, (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true)) AS hidden,
          (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true) AND coalesce(li.person_locked, false)) AS hidden_locked) x
 ),
 -- money totals
 mt AS (
  SELECT coalesce(sum(mo.invoiced), 0) AS invoiced, coalesce(sum(mo.paid), 0) AS paid, coalesce(sum(mo.credited), 0) AS credited,
         coalesce(sum(mo.owing), 0) AS owing, coalesce(sum(mo.overdue), 0) AS overdue, min(mo.oldest_overdue_due) AS oldest_overdue,
         coalesce(sum(mo.drafts), 0) AS drafts, coalesce(sum(mo.draft_total), 0) AS draft_total,
         max(mo.job_value) AS job_value, max(mo.job_value_basis) AS job_value_basis, max(mo.not_yet_invoiced) AS nyi,
         count(*) FILTER (WHERE mo.party IS NOT NULL) AS parties,
         (SELECT m2.supplier_bills FROM mo m2 LIMIT 1) AS bills,
         -- the paying parties that owe now: with more than one, the first line names each
         count(*) FILTER (WHERE mo.party IS NOT NULL AND mo.owing > 0) AS parties_owing
  FROM mo
 ),
 -- every invoice owing now, by due date: the first line names each (up to three), and who
 -- owes it when that is not the customer (a neighbour or another payer: its payer role, or
 -- for a money row without one its R1, R2 or M1 loop's owner)
 oi AS (
  SELECT i ->> 'id' AS id, i ->> 'number' AS num, (i ->> 'owing')::numeric AS owing, (i ->> 'due_date')::date AS due,
         coalesce((i ->> 'overdue')::boolean, false) AS overdue, (i ->> 'days_overdue')::integer AS days, m.party,
         CASE WHEN i ->> 'payer_role' IN ('neighbour', 'strata', 'other_party', 'other_payer') THEN i ->> 'payer_role'
              WHEN i ->> 'payer_role' IS NULL
                   AND EXISTS (SELECT 1 FROM rl WHERE rl.source_table = 'xero_invoices' AND rl.source_id = i ->> 'id'
                                 AND rl.rule IN ('R1_overdue', 'R2_part_paid', 'M1_money_due') AND rl.owner = 'third_party')
              THEN 'third_party' END AS third,
         row_number() OVER (ORDER BY (i ->> 'due_date')::date NULLS LAST, i ->> 'number' COLLATE "C", i ->> 'id' COLLATE "C") AS o
  FROM mo m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.invoices, '[]'::jsonb)) i
  WHERE m.party IS NOT NULL AND jsonb_typeof(i -> 'owing') = 'number' AND (i ->> 'owing')::numeric > 0
 ),
 -- (sixth review) customer invoices placed on no job addressed to this job's own Xero contact,
 -- still owing (meta unplaced_invoices), and the words that name them in the first line and
 -- the money line
 uinv AS (
  SELECT i ->> 'id' AS id, i ->> 'number' AS num, (i ->> 'owing')::numeric AS owing, (i ->> 'due_date')::date AS due,
         (i ->> 'days_overdue')::integer AS days, x.o
  FROM inp, jsonb_array_elements(coalesce(inp.meta -> 'unplaced_invoices' -> 'items', '[]'::jsonb)) WITH ORDINALITY x(i, o)
  WHERE jsonb_typeof(i -> 'owing') = 'number' AND (i ->> 'owing')::numeric > 0
 ),
 uw AS (
  SELECT 'owing on ' || CASE WHEN count(*) = 1 THEN 'an invoice' ELSE 'invoices' END
         || ' placed on no job (addressed to this job''s Xero contact): '
         || string_agg(coalesce(u.num, 'an invoice without a number') || ' ' || to_char(u.owing, 'FM$999,999,990.00')
                       || CASE WHEN u.days IS NOT NULL AND u.due IS NOT NULL
                               THEN ' overdue since ' || public.context_job_story_day(u.due, inp.today) || ' (' || u.days || ' days)'
                               WHEN u.due IS NOT NULL THEN ' due ' || public.context_job_story_day(u.due, inp.today)
                               ELSE ', no due date in Xero' END, '; ' ORDER BY u.o) AS words
  FROM uinv u, inp
  GROUP BY inp.today
 ),
 -- (eighth review) the drafts shown as R3 checks (issued invoices may already bill their share:
 -- never our move): the first line and the money line say so, never a plain draft to issue
 -- (SWF-26545: issuing the DEP50 draft bills the customer the other payer's paid half again)
 dd AS (
  SELECT count(*) AS n, coalesce(sum(CASE WHEN jsonb_typeof(i -> 'total') = 'number' THEN (i ->> 'total')::numeric END), 0) AS total
  FROM mo m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.invoices, '[]'::jsonb)) i
  WHERE m.party IS NOT NULL AND i ->> 'status' = 'DRAFT'
    AND EXISTS (SELECT 1 FROM rl WHERE rl.rule = 'R3_draft' AND rl.shown_as = 'check' AND rl.source_id = i ->> 'id')
 ),
 -- a record disagrees with the job value (check C2): no amount left to invoice is stated as fact
 unconf AS (
  SELECT EXISTS (SELECT 1 FROM rl WHERE rl.rule = 'C2_value_mismatch') AS on_,
         EXISTS (SELECT 1 FROM rl WHERE rl.rule = 'R8_not_yet_invoiced' AND rl.amount IS NULL) AS r8
 ),
 -- evidence for the phase
 -- the newest standing crew booking up to today, and whether one is still ahead (a
 -- booking stands unless cancelled, deleted, draft, disputed or declined; crew
 -- planning's confirmation is never read)
 bkn AS (
  SELECT (SELECT to_jsonb(b) FROM bk b, inp WHERE b.scheduled_date <= inp.today
            AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
          ORDER BY b.scheduled_date DESC, b.id COLLATE "C" DESC LIMIT 1) AS nb,
         EXISTS (SELECT 1 FROM bk b, inp WHERE b.scheduled_date > inp.today
                   AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')) AS ahead
 ),
 -- Work is done only on a completion status (complete, completed, get_review,
 -- final_payment, invoiced: from when the job entered it), a completion record (a
 -- completion pack, a job marked completed, completed and invoiced) or a make-safe
 -- report or pack sent (story safety, 20261006040000). A booking marked complete with
 -- none ahead is attendance, never finished work on its own.
 ev AS (
  SELECT
   -- the newest standing booking attended with none ahead: completed, else started, else
   -- (a status-only completion) the end of the booked Perth day, or now while that is ahead
   (SELECT CASE WHEN NOT bkn.ahead AND bkn.nb IS NOT NULL
                 AND (lower(coalesce(bkn.nb->>'status', '')) IN ('complete', 'completed') OR bkn.nb->>'completed_at' IS NOT NULL)
            THEN (SELECT max(coalesce(b.completed_at, b.started_at,
                                      least(((b.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()))) FROM bk b
                  WHERE lower(coalesce(b.status, '')) IN ('complete', 'completed') OR b.completed_at IS NOT NULL) END FROM bkn) AS attended_at,
   (SELECT bkn.ahead FROM bkn) AS bk_ahead,
   -- a passed booking nobody marked started or complete
   (SELECT (bkn.nb->>'scheduled_date')::date FROM bkn, inp
    WHERE bkn.nb IS NOT NULL AND (bkn.nb->>'scheduled_date')::date < inp.today
      AND lower(coalesce(bkn.nb->>'status', '')) NOT IN ('complete', 'completed', 'in_progress')
      AND bkn.nb->>'completed_at' IS NULL AND bkn.nb->>'started_at' IS NULL) AS unattended_on,
   -- the newest standing booking before today with no attendance, when no later booking
   -- up to today was attended: the first line names it whatever the phase
   (SELECT b.scheduled_date FROM bk b, inp
    WHERE b.scheduled_date < inp.today AND b.completed_at IS NULL AND b.started_at IS NULL
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined', 'complete', 'completed', 'in_progress')
      AND NOT EXISTS (SELECT 1 FROM bk c WHERE c.scheduled_date > b.scheduled_date AND c.scheduled_date <= inp.today
                      AND (lower(coalesce(c.status, '')) IN ('complete', 'completed', 'in_progress') OR c.completed_at IS NOT NULL OR c.started_at IS NOT NULL))
    ORDER BY b.scheduled_date DESC, b.id COLLATE "C" DESC LIMIT 1) AS passed_unrecorded,
   -- the newest booked day up to today that was attended (started, in progress or complete)
   (SELECT max(b.scheduled_date) FROM bk b, inp WHERE b.scheduled_date <= inp.today
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
      AND (lower(coalesce(b.status, '')) IN ('complete', 'completed', 'in_progress') OR b.completed_at IS NOT NULL OR b.started_at IS NOT NULL)) AS attended_day,
   (SELECT min(coalesce(b.completed_at, b.started_at, b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth')) FROM bk b
    WHERE b.status IN ('complete', 'in_progress') OR b.completed_at IS NOT NULL OR b.started_at IS NOT NULL) AS started_at,
   (inp.rec->'facts'->>'report_sent_at')::timestamptz AS report_sent_at,
   -- completion: the earliest of a completion record, the report sent, and the time the
   -- job entered a completion status (its completed stamp, else its newest status change)
   least((inp.rec->'facts'->'completion'->>'at')::timestamptz, (inp.rec->'facts'->>'report_sent_at')::timestamptz,
         CASE WHEN inp.job->>'status' IN ('complete', 'completed', 'get_review', 'final_payment', 'invoiced')
              THEN coalesce((inp.rec->'facts'->>'status_completed_at')::timestamptz,
                            (SELECT max(t.at) FROM tl t WHERE t.kind IN ('status', 'rectification') AND t.time_basis = 'observed')) END) AS completed_at,
   (SELECT to_jsonb(b) FROM bk b WHERE b.scheduled_date >= inp.today
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined', 'complete', 'completed')
    ORDER BY b.scheduled_date, b.id COLLATE "C" LIMIT 1) AS next_bk,
   -- an accepted quote, else (seventh review) the job value's acceptance (the job row's, or a
   -- paid deposit invoice: facts.accepted), so a job its paid deposit accepted reads accepted
   -- since that payment, never a new enquiry (SWF-261372)
   coalesce((SELECT min(q.accepted_at) FROM qd q), (inp.rec->'facts'->'accepted'->>'at')::timestamptz) AS accepted_at,
   (SELECT min(q.sent_at) FROM qd q) AS first_sent,
   (SELECT max(q.sent_at) FROM qd q) AS last_sent,
   (SELECT min(t.at) FROM tl t WHERE t.kind = 'site_visit') AS scoped_at,
   (SELECT max(t.at) FROM tl t WHERE t.kind IN ('status', 'rectification') AND t.time_basis = 'observed') AS status_at,
   -- the newest quote the customer declined, with no quote sent after it
   (SELECT to_jsonb(q) FROM qd q WHERE q.declined_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM qd s WHERE s.sent_at > q.declined_at)
    ORDER BY q.declined_at DESC, q.id COLLATE "C" DESC LIMIT 1) AS declined,
   inp.job->>'status' AS status, inp.job->>'type' AS type, inp.today
  FROM inp
 ),
 ph0 AS (
  SELECT ev.*,
   CASE ev.status
    WHEN 'quoted' THEN 'quote' WHEN 'accepted' THEN 'accepted' WHEN 'partially_accepted' THEN 'accepted'
    WHEN 'awaiting_deposit' THEN 'deposit' WHEN 'deposit' THEN 'deposit' WHEN 'approvals' THEN 'approvals'
    WHEN 'order_materials' THEN 'materials' WHEN 'awaiting_supplier' THEN 'materials' WHEN 'schedule_install' THEN 'scheduled'
    WHEN 'scheduled' THEN 'scheduled' WHEN 'in_progress' THEN 'install' WHEN 'invoiced' THEN 'invoice'
    WHEN 'final_payment' THEN 'payment' WHEN 'get_review' THEN 'complete' WHEN 'complete' THEN 'complete'
    WHEN 'completed' THEN 'complete' WHEN 'rectification' THEN 'rectification' WHEN 'lead' THEN 'enquiry' WHEN 'new' THEN 'enquiry'
    -- (seventh review) processing on other work is at least accepted once the job is accepted
    WHEN 'processing' THEN CASE WHEN ev.type = 'makesafe' THEN 'makesafe' WHEN ev.accepted_at IS NOT NULL THEN 'accepted' ELSE 'other' END
    ELSE 'other' END AS status_phase,
   -- (sixth review) a job in rectification now has its work open again, whatever records
   -- say it was finished before: the final invoice is not due (SWP-26354)
   CASE WHEN ev.bk_ahead OR ev.status = 'rectification' THEN NULL ELSE ev.completed_at END AS work_done_at,
   (mt.owing > 0) AS owing, (coalesce(mt.nyi, 0) > 1) AS uninvoiced,
   -- R8 fired but the job value is unconfirmed: what is left to invoice is not known
   (SELECT unconf.on_ AND unconf.r8 FROM unconf) AS uninv_unconf,
   -- (sixth review) the work was opened again (a status change into rectification, or a
   -- make-safe re-attend) after it was recorded finished, and nothing records it finished
   -- since: the final invoice waits for that work (facts.reopened)
   (SELECT r FROM inp, LATERAL (SELECT inp.rec -> 'facts' -> 'reopened' AS r) x
    WHERE r IS NOT NULL AND jsonb_typeof(r) = 'object' AND (r ->> 'completed_since') IS NULL
      AND (r ->> 'at')::timestamptz > CASE WHEN ev.bk_ahead OR ev.status = 'rectification' THEN NULL ELSE ev.completed_at END) AS reopened
  FROM ev, mt
 ),
 ph AS (
  SELECT p.*,
   CASE
    WHEN p.status_phase = 'rectification' THEN 'rectification'
    WHEN p.started_at IS NOT NULL AND p.next_bk IS NOT NULL THEN 'install'
    WHEN p.unattended_on IS NOT NULL AND p.work_done_at IS NULL THEN 'install'
    WHEN p.work_done_at IS NOT NULL AND p.owing THEN 'payment'
    WHEN p.work_done_at IS NOT NULL AND (p.uninvoiced OR p.uninv_unconf) THEN 'invoice'
    WHEN p.work_done_at IS NOT NULL THEN 'complete'
    WHEN p.status_phase IN ('install', 'complete', 'invoice', 'payment') THEN p.status_phase
    WHEN p.type = 'makesafe' THEN 'makesafe'
    -- attended, but nothing records the work finished: still under way
    WHEN p.started_at IS NOT NULL THEN 'install'
    WHEN p.next_bk IS NOT NULL THEN 'scheduled'
    ELSE (SELECT x.ph FROM (VALUES
           (CASE WHEN p.accepted_at IS NOT NULL THEN 'accepted' WHEN p.first_sent IS NOT NULL THEN 'quote'
                 WHEN p.scoped_at IS NOT NULL THEN 'scope' ELSE 'enquiry' END), (p.status_phase)) x(ph)
          ORDER BY array_position(ARRAY['other','enquiry','scope','quote','accepted','deposit','approvals','materials','scheduled'], x.ph) DESC NULLS LAST
          LIMIT 1)
   END AS phase
  FROM ph0 p
 ),
 phs AS (
  SELECT ph.*,
   CASE
    WHEN ph.phase = 'install' THEN coalesce(ph.started_at, ph.unattended_on::timestamp AT TIME ZONE 'Australia/Perth')
    WHEN ph.phase IN ('payment', 'invoice', 'complete') AND ph.work_done_at IS NOT NULL THEN ph.work_done_at
    WHEN ph.phase = 'scheduled' AND ph.next_bk IS NOT NULL
     THEN CASE WHEN ph.status_phase = 'scheduled' THEN coalesce(ph.status_at, (ph.next_bk->>'created_at')::timestamptz)
               ELSE (ph.next_bk->>'created_at')::timestamptz END
    WHEN ph.phase = 'accepted' THEN coalesce(ph.accepted_at, ph.status_at)
    WHEN ph.phase = 'quote' THEN coalesce(ph.last_sent, ph.status_at)
    WHEN ph.phase = 'scope' THEN ph.scoped_at
    WHEN ph.phase = ph.status_phase THEN ph.status_at
   END AS phase_since_at
  FROM ph
 ),
 -- R5 / C11 candidates, and whether a visible open ledger item says a reply is owed
 cand AS (
  SELECT r.*, (SELECT v.item_key FROM vis v
               WHERE v.status = 'open' AND (coalesce(v.needs_reply, false) OR v.item_type = 'request')
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v.cited, v.opened_by)) c
                             WHERE (c->>'id' = r.source_id)
                                OR (coalesce((c->>'customer')::boolean, false) AND (c->>'at')::timestamptz >= r.opened_at))
               ORDER BY v.opened_at, v.item_key COLLATE "C" LIMIT 1) AS promoted_by
  FROM rl r WHERE r.shown_as = 'candidate'
 ),
 -- record loops shown as loops, merged per object (about_key), with promoted candidates. (Sixth
 -- review) A quote waiting (R7) is never a loop once the work is done: it is a check (checks)
 rec AS (
  SELECT r.rule, r.loop_key, r.owner, r.counterparty, r.what, r.why, r.opened_at, r.due_date, r.amount, r.about_key, r.closes_when,
         r.source_table, r.source_id, NULL::text AS promoted_by
  FROM rl r WHERE r.shown_as = 'loop'
    AND NOT (r.rule = 'R7_quote_waiting' AND (SELECT ph0.work_done_at IS NOT NULL FROM ph0))
  UNION ALL
  SELECT c.rule, c.loop_key, c.owner, c.counterparty, c.what, c.why, c.opened_at, c.due_date, c.amount, c.about_key, c.closes_when,
         c.source_table, c.source_id, c.promoted_by
  FROM cand c WHERE c.promoted_by IS NOT NULL
 ),
 recg AS (
  SELECT r.about_key,
         (array_agg(r.loop_key ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS key,
         (array_agg(r.rule ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS rule,
         string_agg(DISTINCT r.rule COLLATE "C", '+' ORDER BY r.rule COLLATE "C") AS rules,
         (array_agg(r.owner ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS owner,
         (array_agg(r.counterparty ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS counterparty,
         (array_agg(r.what ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS what,
         string_agg(r.why, '; ' ORDER BY r.rule COLLATE "C", r.loop_key COLLATE "C") AS why,
         min(r.opened_at) AS since, min(r.due_date) AS due, max(r.amount) AS amount,
         (array_agg(r.closes_when ORDER BY r.rule COLLATE "C", r.loop_key COLLATE "C"))[1] AS closes_when,
         jsonb_agg(DISTINCT jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites,
         array_agg(r.promoted_by) FILTER (WHERE r.promoted_by IS NOT NULL) AS promoted_by
  FROM rec r GROUP BY r.about_key
 ),
 -- open ledger items that are loops
 lop AS (
  SELECT v.* FROM vis v
  WHERE v.status = 'open'
    AND (v.item_type IN ('commitment', 'request', 'claim', 'issue', 'constraint', 'dependency')
         OR (v.item_type = 'agreement' AND v.modality IN ('requested', 'offered')))
 ),
 -- which ledger items attach to a record loop (same object, or the item that promoted a candidate)
 att AS (
  SELECT l.item_key, g.about_key AS loop_about
  FROM lop l JOIN recg g ON g.about_key = l.about_key OR l.item_key = ANY (coalesce(g.promoted_by, '{}'::text[]))
 ),
 lrole AS (
  SELECT l.*,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_role
    WHEN l.item_type = 'request' THEN coalesce(l.to_role, 'us')
    WHEN l.item_type = 'dependency' THEN CASE WHEN coalesce(l.to_role, 'third_party') IN ('us', 'crew') THEN 'third_party' ELSE l.to_role END
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN coalesce(l.to_role, 'customer') ELSE 'us' END
    ELSE 'us' END AS owner_role,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_name
    WHEN l.item_type = 'request' THEN l.to_name
    WHEN l.item_type = 'dependency' THEN l.to_name
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN l.to_name ELSE NULL END
   END AS owner_name,
   CASE
    WHEN l.item_type = 'commitment' THEN l.to_role
    WHEN l.item_type IN ('request', 'claim', 'issue', 'constraint') THEN l.from_role
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN 'us' ELSE l.from_role END
    ELSE 'us' END AS counter_role,
   (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(l.opened_by) c) AS cites,
   (SELECT c->>'excerpt' FROM jsonb_array_elements(l.opened_by) c LIMIT 1) AS excerpt,
   (SELECT jsonb_agg(jsonb_build_object('t', x.t, 'id', x.id, 'what', x.what) ORDER BY x.at, x.t COLLATE "C", x.id COLLATE "C")
    FROM cc x
    WHERE l.closes_on IN ('quote_sent', 'invoice_issued', 'payment', 'booking_made', 'visit') AND x.closes_on = l.closes_on
      AND x.at > l.opened_at
      -- exact object only: a slug (quote:rear-fence) never matches some other quote by prefix
      AND x.about_key = l.about_key) AS closing
  FROM lop l
 ),
 norm AS (  -- role words to the loop owner vocabulary
  SELECT r.*,
   CASE WHEN r.owner_role IN ('us', 'crew') THEN 'us' WHEN r.owner_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.owner_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS owner,
   CASE WHEN r.counter_role IN ('us', 'crew') THEN 'us' WHEN r.counter_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.counter_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS counterparty
  FROM lrole r
 ),
 loops0 AS (
  -- record loops (with attached ledger items)
  SELECT g.key, 'record'::text AS source, g.rules AS rule, g.owner, NULL::text AS owner_name, g.counterparty,
         g.what,
         concat_ws('; ', g.why, (SELECT string_agg(n.what || coalesce(' ("' || left(n.excerpt, 160) || '")', ''), '; ' ORDER BY n.opened_at, n.item_key COLLATE "C")
                                 FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key),
                   -- the balance falls due when the work is finished: until then it is never the next move
                   -- (sixth review) and while the work is open again: in rectification now, or
                   -- reopened (a status change into rectification, a make-safe re-attend) after it
                   -- was recorded finished, with no record it is finished since
                   CASE WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL AND ph0.status = 'rectification' FROM ph0)
                        THEN 'the job is in rectification, so the final invoice is not the next move until the work is finished again'
                        WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL FROM ph0)
                        THEN 'the final invoice falls due when the work is finished, so it is not the next move yet'
                        WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.reopened IS NOT NULL FROM ph0)
                        THEN (SELECT 'the work was opened again after it was recorded finished (' || lower(ph0.reopened ->> 'what') || ' '
                                     || public.context_job_story_day(((ph0.reopened ->> 'at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, ph0.today)
                                     || ') and nothing records it finished since, so the final invoice is not the next move yet' FROM ph0)
                        -- (fourth review) with the job value unconfirmed (check C2, no amount) what is
                        -- left to invoice is not known, so it is a check of the value, never a move
                        WHEN g.rule = 'R8_not_yet_invoiced' AND g.amount IS NULL
                        THEN 'the job value is unconfirmed (check C2), so what is left to invoice is a person''s check, never the next move' END) AS why,
         g.since, coalesce(g.due, (SELECT min(n.due_date) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key)) AS due,
         -- the record rule still fires, so the loop is open: closing evidence is shown on
         -- ledger items only. A final invoice before the work is done is not due yet; after
         -- it, with the job value unconfirmed (no amount), it is unconfirmed (story safety,
         -- fourth review): neither is ever the move, the first line's item or a loop due now.
         CASE WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL OR ph0.reopened IS NOT NULL FROM ph0) THEN 'not_due'
              WHEN g.rule = 'R8_not_yet_invoiced' AND g.amount IS NULL THEN 'unconfirmed' ELSE 'open' END AS status,
         g.closes_when,
         (SELECT max(n.blocks) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key WHERE n.blocks <> 'none') AS blocks,
         NULL::jsonb AS closing_evidence,
         (SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
          FROM (SELECT DISTINCT c FROM jsonb_array_elements(g.cites || coalesce((SELECT jsonb_agg(c2) FROM norm n
                JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key, jsonb_array_elements(n.cites) c2), '[]'::jsonb)) c) d) AS cites,
         g.about_key, g.amount,
         (g.rule IN ('R4_missed_call', 'R5_customer_wrote_last', 'C11_customer_mail_unanswered')) AS customer_waiting,
         (g.rule IN ('R1_overdue', 'M1_money_due', 'R2_part_paid', 'R3_draft', 'R8_not_yet_invoiced')) AS money,
         (g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL OR ph0.reopened IS NOT NULL FROM ph0)) AS not_due,
         -- held: not the move now (not due yet, or unconfirmed)
         (g.rule = 'R8_not_yet_invoiced' AND ((SELECT ph0.work_done_at IS NULL OR ph0.reopened IS NOT NULL FROM ph0) OR g.amount IS NULL)) AS held,
         false AS customer_reported
  FROM recg g
  UNION ALL
  -- ledger loops not attached to a record loop
  SELECT n.item_key, CASE WHEN n.written_by LIKE 'person:%' THEN 'person' ELSE 'ledger' END, n.item_type, n.owner, n.owner_name,
         n.counterparty, n.what, coalesce('"' || left(n.excerpt, 200) || '"', NULL), n.opened_at, n.due_date,
         CASE WHEN n.closing IS NOT NULL THEN 'closing_evidence' ELSE 'open' END,
         CASE n.closes_on WHEN 'reply' THEN 'A reply that answers it' WHEN 'call' THEN 'A call that deals with it'
              WHEN 'quote_sent' THEN 'The quote is sent' WHEN 'invoice_issued' THEN 'The invoice is issued'
              WHEN 'payment' THEN 'The payment is received' WHEN 'booking_made' THEN 'A booking is made'
              WHEN 'visit' THEN 'The visit happens' WHEN 'work_done' THEN 'The work is done' WHEN 'record' THEN 'A record shows it done'
              WHEN 'person' THEN 'A person closes it' ELSE 'Words or a record that show it done' END,
         nullif(n.blocks, 'none'), n.closing, coalesce(n.cites, '[]'::jsonb), n.about_key, NULL::numeric,
         (n.owner = 'us' AND n.counterparty = 'customer' AND (coalesce(n.needs_reply, false) OR n.item_type = 'request')),
         (n.blocks IN ('payment', 'deposit') OR n.about_key LIKE 'invoice:%' OR n.about_key LIKE 'payment:%'),
         false, false,
         -- (story settled notes) opened only on the customer's words
         EXISTS (SELECT 1 FROM vcust vc WHERE vc.item_key = n.item_key)
  FROM norm n WHERE NOT EXISTS (SELECT 1 FROM att a WHERE a.item_key = n.item_key)
 ),
 -- (story lead rank, 20261011100000) which open loops may lead the line. Every loop stays in the
 -- list as it was (nothing is closed, hidden or written); only its rank and whether it may be the
 -- top item change. A held loop never leads, as before. Of the open loops on one object (about_key)
 -- only the newest may lead: an older ask the customer followed up on the same object never leads
 -- over the follow-up. And a loop that blocks an earlier stage than a newer open loop blocks (quote,
 -- acceptance, deposit, booking, install, completion, payment) never leads: a pre-install query
 -- never leads over a newer completion dispute (SWF-261469: a 5 Oct letterbox ask, blocking install,
 -- led the line over the 9 to 11 Oct workmanship complaint and the independent report awaited).
 -- The newest open loop of all can always lead, so some loop always may.
 lstage AS (
  SELECT l.*, array_position(ARRAY['quote','acceptance','deposit','booking','install','completion','payment'], l.blocks) AS stage
  FROM loops0 l
 ),
 lcan AS (
  SELECT l.*,
   (NOT l.held
    AND NOT EXISTS (SELECT 1 FROM lstage m
                    WHERE NOT m.held AND l.about_key IS NOT NULL AND m.about_key = l.about_key
                      AND (coalesce(m.since, '-infinity'::timestamptz) > coalesce(l.since, '-infinity'::timestamptz)
                           OR (coalesce(m.since, '-infinity'::timestamptz) = coalesce(l.since, '-infinity'::timestamptz)
                               AND m.key COLLATE "C" > l.key COLLATE "C")))
    AND NOT EXISTS (SELECT 1 FROM lstage m
                    WHERE NOT m.held AND l.stage IS NOT NULL AND m.stage > l.stage
                      AND coalesce(m.since, '-infinity'::timestamptz) > coalesce(l.since, '-infinity'::timestamptz))) AS may_lead,
   -- overtaken: a newer open loop blocks a later stage, so this one blocks nothing now (it stays a
   -- loop, open, with its own blocks, and leaves now.blockers only)
   EXISTS (SELECT 1 FROM lstage m
           WHERE NOT m.held AND l.stage IS NOT NULL AND m.stage > l.stage
             AND coalesce(m.since, '-infinity'::timestamptz) > coalesce(l.since, '-infinity'::timestamptz)) AS overtaken
  FROM lstage l
 ),
 loops AS (
  SELECT l.*, (inp.today - (l.since AT TIME ZONE 'Australia/Perth')::date) AS age_days,
         row_number() OVER (ORDER BY
           -- (story lead rank) the loops that may lead first, then the rest, then the held ones
           CASE WHEN l.held THEN 2 WHEN l.may_lead THEN 0 ELSE 1 END,
           CASE WHEN l.held THEN 4 WHEN l.owner = 'us' AND l.customer_waiting THEN 0 WHEN l.money THEN 1 WHEN l.owner = 'us' THEN 2 ELSE 3 END,
           l.since NULLS LAST, l.key COLLATE "C") AS rank
  FROM lcan l, inp
 ),
 -- unpromoted R5 / C11 candidates, and whether the reading shown has read the row
 -- (the row is in its read set: admitted to its evidence and landed by its evidence_until);
 -- only a finished reading judges a row (a building or failed one shown on request never
 -- does: story safety, fourth review)
 wr AS (
  SELECT c.*, (led.live_read AND coalesce(led.read_ids ? c.source_id, false)) AS read_by_reader
  FROM cand c, led WHERE c.promoted_by IS NULL
 ),
 -- the customer wrote last and nobody has read it yet: the now line and whose move say so
 -- the newest unread candidate, and where its message sits (mail the old inbox placed
 -- on no job is said to be so)
 wl AS (SELECT w.opened_at AS at, w.placement, w.what, w.source_id FROM wr w WHERE NOT w.read_by_reader
        ORDER BY w.opened_at DESC, w.source_id COLLATE "C" DESC LIMIT 1),
 -- checks: record checks (and, sixth review, a quote waiting once the work is done), plus
 -- candidates nobody promoted
 checks AS (
  SELECT r.rule, r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites, r.opened_at
  FROM rl r WHERE r.shown_as = 'check'
     OR (r.shown_as = 'loop' AND r.rule = 'R7_quote_waiting' AND (SELECT ph0.work_done_at IS NOT NULL FROM ph0))
  UNION ALL
  SELECT c.rule,
         CASE WHEN c.read_by_reader
              THEN 'Customer wrote last; the reader judged no reply is needed. ' || c.what
              -- (owner's ruling, 6 Oct 2026: "not yet checked by the reader", never "not read yet")
              ELSE 'Customer wrote last; not yet checked by the reader. ' || c.what END,
         jsonb_build_array(jsonb_build_object('t', c.source_table, 'id', c.source_id)), c.opened_at
  FROM wr c
 ),
 -- (sixth review) the customer's newest message is off the job (placed on no job yet, or their
 -- mail withheld because they have another job) and newer than every customer message on it:
 -- no reading has checked it (a reading reads only the job's own rows), so even one that has
 -- read every row on the job gives no all-clear over it (fixture P, SWF-261305). (Eighth review)
 -- Also one on a job no reader reads (a bucket) or their email by address with no CRM contact
 -- (meta off_job unchecked_customer: SWP-26148's reply on SWF-PDF-BUCKET), where it sits named
 ofj AS (
  SELECT x.at, x.note FROM inp, LATERAL (VALUES
    ((inp.meta->'off_job'->>'unchecked_customer_at')::timestamptz,
     ' (' || coalesce(inp.meta->'off_job'->>'unchecked_customer_where', 'not placed on any job') || ')', 0),
    ((inp.meta->'unplaced'->>'newest_customer_at')::timestamptz, ' (not placed on any job)', 1),
    ((inp.meta->'withheld_mail'->>'newest_at')::timestamptz, ' (an email not placed on any job; it may be about another of their jobs)', 2)
  ) x(at, note, o)
  WHERE x.at IS NOT NULL AND x.at > coalesce((inp.rec->'contact'->'last_customer_message'->>'at')::timestamptz, '-infinity'::timestamptz)
    -- (lead cutoff, 20261007010000) a lead no longer followed up: the rule counted every message of
    -- the customer's there is, so one newer than the start of its 4 weeks (6 on a patio job: scoping
    -- pipeline, 20261009133000) is not theirs (mail from one of our own addresses entered as the
    -- client's) and is never named as theirs
    AND NOT coalesce((SELECT ld.off FROM ld) AND x.at > (SELECT ld.cutoff_at - make_interval(hours => ld.win_h) FROM ld), false)
  ORDER BY x.at DESC, x.o LIMIT 1
 ),
 -- (seventh review) and newer than the opening of the top loop the customer owes (the first due
 -- now): it may be about that item (SWF-26004: a complaint about the work in the admin bucket
 -- after the overdue invoice; SWF-261423: "I just paid it" in a call placed on no job), so whose
 -- move is unclear and the line names it. One from before that loop opened leaves its move
 -- standing (a quote whose off-job rows predate it still waits on the customer). (Eighth review)
 -- Only what its sender owes: the customer's own items, never a neighbour's or another payer's,
 -- and never on builder work while the sender (the CRM contact, the client email) is the insured
 -- and the builder owes (SWMS-261441: the insured's thank-you text never makes the builder's
 -- payment unclear); (ninth review) a contact shared across clients, or one the story cannot call
 -- the insured's, may be the builder's own, so its newer message holds the builder's move
 ofl AS (
  SELECT o.at, o.note FROM ofj o, inp
  WHERE NOT inp.ins
    AND o.at > (SELECT l.since FROM loops l WHERE l.owner = 'customer' AND NOT l.held ORDER BY l.rank LIMIT 1)
 ),
 -- (eighth review) the customer's newest message on the job (a text, an email, an answered call or
 -- a call recording: a voicemail among them; or their old-inbox email placed on no job) that no
 -- finished reading has read: it may hold a promise or request of ours (SWF-261481: staff agreed to
 -- cash on the day and a Wednesday install after the invoice; SWF-26091: the customer's voicemail
 -- about the rectification logged as a completed call; SWF-261053: a voicemail saying we promised
 -- to take the printed invoice to the other payer)
 ojc AS (
  SELECT (c ->> 'at')::timestamptz AS at, c ->> 'placed_on' AS placed_on,
         CASE WHEN c ->> 'placed_on' = 'none' THEN 'an email not placed on any job'
              WHEN c ->> 'channel' = 'sms' THEN 'a text' WHEN c ->> 'channel' = 'email' THEN 'an email'
              WHEN c ->> 'event_type' = 'call.transcript_completed' THEN 'a call recording'
              ELSE 'an answered call' END AS kind
  FROM inp, led, LATERAL (SELECT inp.rec -> 'contact' -> 'last_customer_message' AS c) x
  WHERE jsonb_typeof(x.c) = 'object' AND (x.c ->> 'at') IS NOT NULL
    AND NOT (led.live_read AND coalesce(led.read_ids ? (x.c ->> 'id'), false))
 ),
 -- ... and newer than the opening of the top loop the customer or another party owes on the job
 -- (an email placed on no job: what the customer owes, as off the job): whose move is unclear and
 -- the line names the message with our last reply, whatever we sent since. Never on builder work
 -- while the contact's messages are the insured's and the builder owes (ninth review: a contact
 -- shared across clients, or one not the insured's, holds the builder's move as the customer's do)
 ojl AS (
  SELECT o.at, o.kind FROM ojc o, inp
  WHERE NOT inp.ins
    AND o.at > (SELECT l.since FROM loops l WHERE NOT l.held
                  AND (l.owner = 'customer' OR (l.owner = 'third_party' AND o.placed_on IS DISTINCT FROM 'none'))
                ORDER BY l.rank LIMIT 1)
 ),
 -- whose move: ours when we owe something due now; unclear while the customer wrote last
 -- unread, or (seventh review) while their newest message is off the job and newer than what
 -- they owe, or (eighth review) while their newest message on the job is unread and newer than
 -- what they or another party owe; and until a live reading has read every row on the job (and
 -- none of its items is hidden), nothing open on record is never nobody's move (story safety,
 -- 20261006040000), nor while the customer's newest message is off the job (sixth review)
 wm0 AS (
  SELECT CASE
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'us' AND NOT l.held) THEN 'us'
          WHEN EXISTS (SELECT 1 FROM wl) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM ofl) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM ojl) THEN 'unknown'
          -- (fourth review) a quote the customer was in touch about since it was sent, in a way
          -- that does not close it (R7, owner unknown): it may be answered, so whose move is
          -- unclear, whatever else the customer or another party owes
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.rule = 'R7_quote_waiting' AND l.owner = 'unknown') THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'customer' AND NOT l.held) THEN 'customer'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'third_party' AND NOT l.held) THEN 'third_party'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE NOT l.held) THEN 'unknown'
          WHEN NOT (SELECT led.words_read FROM led) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM ofj) THEN 'unknown'
          ELSE 'nobody' END AS whose
 ),
 -- (lead cutoff, 20261007010000) a lead no longer followed up is nobody's move to chase and never
 -- the customer's (the owner's ruling, 7 Oct 2026): not_followed_up, whatever is open on it
 wm AS (SELECT CASE WHEN ld.off THEN 'not_followed_up' ELSE wm0.whose END AS whose FROM wm0, ld),
 -- the top loop is the first one due now (a final invoice before the work is finished, or
 -- one whose amount is unconfirmed, never is) of the party whose move it is, so the line
 -- never pairs one party's move with another's item (the customer's move with a
 -- neighbour's invoice, our move with another payer's); with whose move unclear, the item
 -- it is unclear on (owner unknown) first, else the first one due now. (Story lead rank,
 -- 20261011100000) within the party whose move it is, a loop that may lead comes first; the party
 -- comes before it, so the line still never pairs one party's move with another's item (when every
 -- loop of that party is one that may not lead, its best-ranked loop is still the top)
 top AS (SELECT l.* FROM loops l, wm0 wm WHERE NOT l.held
         ORDER BY CASE WHEN wm.whose IN ('us', 'customer', 'third_party') AND l.owner IS DISTINCT FROM wm.whose THEN 1 ELSE 0 END,
                  CASE WHEN l.may_lead THEN 0 ELSE 1 END,
                  CASE WHEN wm.whose = 'unknown' AND l.owner = 'unknown' THEN 0 ELSE 1 END, l.rank
         LIMIT 1),
 -- (story lead rank, 20261011100000) the latest agreed position: the newest agreement the reader
 -- found agreed and still standing (open or info, never superseded, declined, disputed or closed),
 -- made in the 14 days up to now and after every open loop that may lead of the party whose move it
 -- is (of every party while whose move is unclear) opened: nothing that party owes is newer than
 -- what was agreed. The first line says it right after the phase and next is it (unless a visit is
 -- booked), so what was last agreed governs what happens next over older open items (SWF-261469:
 -- the 11 Oct agreement to inspect after the independent report over the 9 and 10 Oct defect
 -- reports). An agreement carries no date of its own, so an older one (a January install date on a
 -- job rebooked since) is never said as the latest position. The top item, whose move and every
 -- loop are unchanged.
 agl AS (
  SELECT v.item_key, v.what, v.opened_at, v.due_date,
         (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c) AS cites
  FROM vis v, inp, wm0 wm
  WHERE v.item_type = 'agreement' AND v.modality = 'agreed' AND v.status IN ('open', 'info')
    AND v.opened_at <= inp.as_of AND v.opened_at > inp.as_of - interval '14 days'
    AND EXISTS (SELECT 1 FROM top)
    AND NOT EXISTS (SELECT 1 FROM loops l
                    WHERE l.may_lead AND (wm.whose NOT IN ('us', 'customer', 'third_party') OR l.owner = wm.whose)
                      AND coalesce(l.since, '-infinity'::timestamptz) >= v.opened_at)
  ORDER BY v.opened_at DESC, v.item_key COLLATE "C" DESC LIMIT 1
 ),
 -- (story settled notes, 20261011120000) the job reads installed per the messages: the phase is
 -- install on a passed booking nobody marked started or complete (no attendance), and an open
 -- completion-stage note (it blocks completion, or its phase is complete or rectification) was
 -- opened on or after that booked day: the words say the work happened, the crew never marked it
 -- (SWF-261469: "Install under way; attendance not recorded" over eleven defect reports about the
 -- installed fence). The phase stays install; only its words change.
 ipm AS (
  SELECT EXISTS (SELECT 1 FROM phs, vis v
                 WHERE phs.phase = 'install' AND phs.unattended_on IS NOT NULL AND phs.started_at IS NULL
                   AND v.status = 'open' AND (v.blocks = 'completion' OR v.phase IN ('complete', 'rectification'))
                   AND v.opened_at >= (phs.unattended_on::timestamp AT TIME ZONE 'Australia/Perth')) AS on_
 ),
 -- day words: Perth dates like "Wed 7 Oct" (year added when it is not the current year)
 nx AS (
  SELECT phs.next_bk AS b,
         CASE WHEN phs.next_bk IS NULL THEN NULL
              ELSE to_char((phs.next_bk->>'scheduled_date')::date, 'Dy FMDD Mon')
                   || CASE WHEN extract(year FROM (phs.next_bk->>'scheduled_date')::date) <> extract(year FROM phs.today)
                           THEN ' ' || extract(year FROM (phs.next_bk->>'scheduled_date')::date) ELSE '' END END AS day
  FROM phs
 ),
 -- the contact facts the line names while whose move is unclear: the newest customer
 -- message, our last reply, and an automated text sent since (each null when none). Story
 -- safety, fourth review: the newest of the job's own, this customer's messages placed on
 -- no job yet (meta unplaced) and their mail withheld because they have another job
 -- (meta withheld_mail), naming where it sits, so the line never says there is no customer
 -- message, or names a stale one, while a newer one waits off the job. (Eighth review) Also
 -- theirs and ours on their other jobs ("on job X"), on a bucket or holding job, and their
 -- email by address with no CRM contact (meta off_job); on builder work the contact's messages
 -- are the insured's, and named so, only when the contact is the insured's (ninth review: else the
 -- job contact's, never a person it may not be: SWR-261488's builder-side contact)
 cw AS (
  SELECT CASE WHEN inp.ins THEN 'the insured''s newest message ' WHEN inp.bw THEN 'the job contact''s newest message '
              ELSE 'newest customer message ' END
          || public.context_job_story_day((c.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || c.note AS cm,
         'our last reply ' || public.context_job_story_day((r.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || r.note AS rp,
         ' (an automated text went '
          || public.context_job_story_day(((inp.rec->'contact'->'last_to_customer'->'newer_automated'->>'at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, phs.today)
          || ')' AS auto
  FROM inp CROSS JOIN phs
  LEFT JOIN LATERAL (
   SELECT x.at, x.note FROM (VALUES
     ((inp.rec->'contact'->'last_customer_message'->>'at')::timestamptz,
      CASE WHEN inp.rec->'contact'->'last_customer_message'->>'placed_on' = 'none' THEN ' (an email not placed on any job)' ELSE '' END, 1),
     ((inp.meta->'off_job'->>'newest_customer_at')::timestamptz,
      ' (' || coalesce(inp.meta->'off_job'->>'newest_customer_where', 'not placed on any job') || ')', 0),
     ((inp.meta->'unplaced'->>'newest_customer_at')::timestamptz, ' (not placed on any job)', 2),
     ((inp.meta->'withheld_mail'->>'newest_at')::timestamptz, ' (an email not placed on any job; it may be about another of their jobs)', 3)
   ) x(at, note, o) WHERE x.at IS NOT NULL ORDER BY x.at DESC, x.o LIMIT 1) c ON true
  LEFT JOIN LATERAL (
   SELECT x.at, x.note FROM (VALUES
     ((inp.rec->'contact'->'last_to_customer'->>'at')::timestamptz, '', 1),
     ((inp.meta->'off_job'->>'newest_reply_at')::timestamptz,
      ' (' || coalesce(inp.meta->'off_job'->>'newest_reply_where', 'not placed on any job') || ')', 0),
     ((inp.meta->'unplaced'->>'newest_reply_at')::timestamptz, ' (not placed on any job)', 2)
   ) x(at, note, o) WHERE x.at IS NOT NULL ORDER BY x.at DESC, x.o LIMIT 1) r ON true
 ),
 nowp AS (
  SELECT phs.phase, phs.phase_since_at,
   -- phase words say where the job is, never whose move it is (the move words do);
   -- invoicing and payment words follow the money, not the status. A make-safe finished
   -- by its report pack says so, with the day the pack went.
   CASE WHEN phs.phase IN ('complete', 'invoice', 'payment') AND phs.work_done_at IS NOT NULL
             AND phs.work_done_at = phs.report_sent_at
        THEN 'Report pack sent to the builder ' || public.context_job_story_day((phs.report_sent_at AT TIME ZONE 'Australia/Perth')::date, phs.today)
             || CASE phs.phase WHEN 'payment' THEN CASE WHEN phs.owing THEN ', payment owing' ELSE ', final payment stage' END
                               WHEN 'invoice' THEN CASE WHEN phs.uninvoiced THEN ', not fully invoiced'
                                                        WHEN phs.uninv_unconf THEN ', what is left to invoice is unconfirmed' ELSE ', invoiced' END
                               ELSE ', work complete' END
        -- (story settled notes) installed per the messages, the booked day named in the attendance words
        -- (on builder work, attended: a make-safe or repair is not an install)
        WHEN phs.phase = 'install' AND ipm.on_
        THEN CASE WHEN phs.type IN ('makesafe', 'repair', 'insurance') THEN 'Attended per messages' ELSE 'Installed per messages' END
        ELSE
   CASE phs.phase
    WHEN 'enquiry' THEN 'New enquiry' WHEN 'scope' THEN 'Scoping' WHEN 'quote' THEN 'Quoted'
    WHEN 'accepted' THEN 'Accepted' WHEN 'deposit' THEN 'Deposit stage' WHEN 'approvals' THEN 'In approvals'
    WHEN 'materials' THEN 'Materials being ordered' WHEN 'scheduled' THEN 'Scheduled' WHEN 'install' THEN 'Install under way'
    WHEN 'complete' THEN 'Work complete'
    WHEN 'invoice' THEN CASE WHEN phs.uninvoiced AND phs.work_done_at IS NOT NULL THEN 'Work done, not fully invoiced'
                             WHEN phs.uninv_unconf AND phs.work_done_at IS NOT NULL THEN 'Work done, what is left to invoice is unconfirmed'
                             WHEN phs.uninvoiced THEN 'Not fully invoiced' ELSE 'Invoiced' END
    WHEN 'payment' THEN CASE WHEN phs.owing AND phs.work_done_at IS NOT NULL THEN 'Work done, payment owing'
                             WHEN phs.owing THEN 'Payment owing' ELSE 'Final payment stage' END
    WHEN 'rectification' THEN 'In rectification'
    WHEN 'makesafe' THEN 'Make-safe in progress' ELSE 'In progress' END
   || coalesce(' since ' || public.context_job_story_day((phs.phase_since_at AT TIME ZONE 'Australia/Perth')::date, phs.today), '')
   END AS phase_words,
   -- (story lead rank) the latest agreed position, cut at a word as the top item is
   (SELECT 'latest agreement ' || public.context_job_story_day((a.opened_at AT TIME ZONE 'Australia/Perth')::date, phs.today) || ': '
           || CASE WHEN length(w.w) <= 160 THEN w.w ELSE rtrim(left(w.w, 157 - position(' ' IN reverse(left(w.w, 157)))), ' ,;:') || '...' END
    FROM agl a, LATERAL (SELECT regexp_replace(rtrim(a.what, '. '), '\s+', ' ', 'g') AS w) w) AS agreed_words,
   CASE WHEN nx.b IS NOT NULL THEN 'next visit ' || coalesce(replace(nx.b->>'assignment_type', '_', ' ') || ' ', '') || 'booked ' || nx.day END AS next_words,
   -- a passed booking with no attendance recorded is named whatever the phase; a booking
   -- marked complete while nothing records the job finished says so; on builder work the
   -- attended day is named
   CASE WHEN phs.phase = 'install' AND phs.unattended_on IS NOT NULL
        THEN CASE WHEN ipm.on_ THEN 'attendance not marked for ' ELSE 'attendance not recorded for ' END
             || public.context_job_story_day(phs.unattended_on, phs.today)
        WHEN phs.passed_unrecorded IS NOT NULL
        THEN 'attendance not recorded for ' || public.context_job_story_day(phs.passed_unrecorded, phs.today)
        WHEN phs.phase = 'install' AND phs.work_done_at IS NULL AND phs.attended_at IS NOT NULL AND phs.attended_day IS NOT NULL
        THEN 'the ' || public.context_job_story_day(phs.attended_day, phs.today) || ' booking is marked complete; nothing records the job finished'
        WHEN phs.type IN ('makesafe', 'repair', 'insurance') AND phs.work_done_at IS NOT NULL AND phs.attended_day IS NOT NULL
        THEN 'attended ' || public.context_job_story_day(phs.attended_day, phs.today)
   END AS att_words,
   (SELECT CASE WHEN t.owner = 'us' THEN 'we owe: '
                WHEN t.owner = 'customer' AND t.money THEN 'the customer owes: '
                -- a quote waiting reads as waiting on the customer, never as money owed; while
                -- the customer wrote last unread it may already be answered
                WHEN t.owner = 'customer' THEN CASE WHEN EXISTS (SELECT 1 FROM wl) THEN 'open: ' ELSE 'waiting on the customer: ' END
                WHEN t.owner = 'third_party' AND t.money THEN 'another payer owes: '
                WHEN t.owner = 'third_party' THEN 'waiting on another party: ' ELSE 'open: ' END
           -- (fourth review) cut at a word, never mid-word, and long enough to name a contact
           || CASE WHEN length(w.w) <= 200 THEN w.w
                   ELSE rtrim(left(w.w, 197 - position(' ' IN reverse(left(w.w, 197)))), ' ,;:') || '...' END
    FROM top t, LATERAL (SELECT regexp_replace(t.what, '\s+', ' ', 'g') AS w) w) AS top_words,
   -- what is owed, each invoice by number and due date; who owes it ("owed by", never "from",
   -- which reads as a bill from them), with their role, whenever a neighbour or another payer
   -- owes it (whatever the move, so their invoice never reads as the customer's), and each
   -- payer when more than one owes; one invoice the top loop already names is left to it
   CASE WHEN mt.owing > 0 THEN 'owing ' || to_char(mt.owing, 'FM$999,999,990.00')
            || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue)' ELSE '' END
            || CASE WHEN (SELECT count(*) FROM oi) = 1
                         AND EXISTS (SELECT 1 FROM top t, oi WHERE t.cites @> jsonb_build_array(jsonb_build_object('t', 'xero_invoices', 'id', oi.id)))
                    THEN ''
                    ELSE coalesce(': ' || (SELECT string_agg(coalesce(oi.num, 'an invoice without a number') || ' ' || to_char(oi.owing, 'FM$999,999,990.00')
                                                  || CASE WHEN oi.third IS NOT NULL
                                                          THEN ' owed by ' || coalesce(oi.party, 'an unnamed contact')
                                                               || CASE oi.third WHEN 'neighbour' THEN ' (a neighbour paying part of this job)'
                                                                                WHEN 'strata' THEN ' (the strata, paying part of this job)'
                                                                                WHEN 'other_party' THEN ' (another party on this job)'
                                                                                ELSE ' (another payer, not this job''s customer)' END
                                                          WHEN mt.parties_owing > 1 THEN ' owed by ' || coalesce(oi.party, 'an unnamed contact') ELSE '' END
                                                  || CASE WHEN oi.overdue AND oi.due IS NOT NULL
                                                          THEN ' overdue since ' || public.context_job_story_day(oi.due, phs.today) || coalesce(' (' || oi.days || ' days)', '')
                                                          WHEN oi.due IS NOT NULL THEN ' due ' || public.context_job_story_day(oi.due, phs.today)
                                                          ELSE ', no due date in Xero' END, '; ' ORDER BY oi.o)
                                           FROM oi WHERE oi.o <= 3)
                                  || CASE WHEN (SELECT count(*) FROM oi) > 3 THEN '; and ' || ((SELECT count(*) FROM oi) - 3) || ' more' ELSE '' END, '') END
   END AS owing_words,
   -- (sixth review) what this job's own Xero contact owes on an invoice placed on no job (meta
   -- unplaced_invoices), each by number and due date, so a debt the job never received is
   -- never hidden behind its own invoices showing nothing owing (bda6e1de's INV-0290)
   (SELECT uw.words FROM uw) AS elsewhere_words,
   -- (eighth review) a draft shown as an R3 check may duplicate issued invoices: said so, never a
   -- plain draft to issue (SWF-26545, SWF-261423)
   CASE WHEN mt.drafts > 0 THEN mt.drafts || CASE WHEN mt.drafts = 1 THEN ' draft invoice' ELSE ' draft invoices' END || ' not issued'
             || CASE WHEN dd.n = 0 THEN ''
                     WHEN dd.n >= mt.drafts THEN CASE WHEN mt.drafts = 1 THEN ' (it may' ELSE ' (they may' END || ' duplicate issued invoices; check R3)'
                     ELSE ' (' || dd.n || ' of them may duplicate issued invoices; check R3)' END END AS draft_words,
   -- what is left to invoice is named only once the work is done, and only when the job
   -- value is confirmed
   CASE WHEN phs.work_done_at IS NOT NULL AND coalesce(mt.nyi, 0) > 1 THEN to_char(mt.nyi, 'FM$999,999,990.00') || ' not yet invoiced'
        WHEN phs.work_done_at IS NOT NULL AND phs.uninv_unconf THEN 'what is left to invoice is unconfirmed (check C2)' END AS nyi_words,
   CASE wm.whose WHEN 'us' THEN 'Our move' WHEN 'customer' THEN 'The customer''s move'
        WHEN 'third_party' THEN 'Waiting on another party'
        -- no live reading of every row: never an all-clear. The line says first that whose
        -- move is unclear, then what the records show: no record item open (or due yet), the
        -- messages not yet checked for promises or requests (a live reading that lags: how
        -- many newer rows it has not checked, every kind and ours included, so said), the
        -- newest customer message and our last reply; with neither on record it says so and
        -- claims nothing unchecked
        WHEN 'unknown' THEN CASE WHEN NOT led.words_read AND NOT EXISTS (SELECT 1 FROM loops l WHERE NOT l.held) AND NOT EXISTS (SELECT 1 FROM wl)
                                 THEN 'Whose move is unclear: no record item is ' || CASE WHEN EXISTS (SELECT 1 FROM loops l WHERE l.not_due) THEN 'due yet' ELSE 'open' END
                                      || CASE WHEN led.live_read AND coalesce(led.unread, 0) > 0
                                              THEN ', and ' || led.unread
                                                   || CASE WHEN led.unread = 1 THEN ' newer message, call, note or document (ours included) is'
                                                           ELSE ' newer messages, calls, notes or documents (ours included) are' END
                                                   || ' not yet checked for promises or requests; '
                                              -- (eighth review) a reading of every row with an item hidden (a
                                              -- message it cites is no longer this job's evidence): what it
                                              -- found is no longer whole (not_known says whether a rebuild or
                                              -- a person puts it right)
                                              WHEN led.live_read AND led.hidden > 0
                                              THEN ', and ' || led.hidden || CASE WHEN led.hidden = 1 THEN ' reader item is' ELSE ' reader items are' END
                                                   || ' hidden (a message it cites is no longer this job''s evidence); '
                                              WHEN cw.cm IS NULL AND cw.rp IS NULL THEN '; '
                                              ELSE ', and the messages are not yet checked for promises or requests; ' END
                                      || CASE WHEN cw.cm IS NULL AND cw.rp IS NULL
                                              THEN 'no customer message and no reply from us on record' || coalesce(cw.auto, '')
                                              ELSE coalesce(cw.cm, 'no customer message on record') || ', '
                                                   || coalesce(cw.rp, 'no reply from us on record' || coalesce(cw.auto, '')) END
                                 -- (sixth review) a reading that read every row on the job found
                                 -- nothing open, but the customer's newest message is off the job
                                 -- and was never its to read: named, where it sits, unchecked
                                 WHEN led.words_read AND NOT EXISTS (SELECT 1 FROM loops l WHERE NOT l.held) AND NOT EXISTS (SELECT 1 FROM wl)
                                      AND EXISTS (SELECT 1 FROM ofj)
                                 THEN 'Whose move is unclear: no record item is ' || CASE WHEN EXISTS (SELECT 1 FROM loops l WHERE l.not_due) THEN 'due yet' ELSE 'open' END
                                      || ' and the reader found nothing open in the job''s own messages, but ' || inp.cust || '''s newest message, '
                                      || (SELECT public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || o.note FROM ofj o)
                                      || ', is off the job and not yet checked by the reader'
                                 ELSE 'Whose move is unclear' END
        ELSE CASE WHEN nx.b IS NOT NULL THEN 'Nothing open until the visit' ELSE 'Nothing open on record' END END AS move_words,
   (SELECT inp.cust || ' wrote last on ' || public.context_job_story_day((wl.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
           || CASE WHEN wl.placement = 'not_placed' THEN ' (an email not placed on any job)' ELSE '' END
           -- (owner's ruling, 6 Oct 2026: "not yet checked by the reader", never "not read yet",
           -- which reads as staff not having read it)
           || '; not yet checked by the reader'
           -- the words themselves, so a pause, a decline or a new request shows in the first line
           || coalesce(': "' || CASE WHEN length(x.w) > 90 THEN left(x.w, 87) || '...' ELSE x.w END || '"', '')
           -- (eighth review) and their newer message off the job (ofj), where it sits, unchecked
           -- (SWP-261265: their text in the admin bucket 11 days after the one they wrote last on the job)
           || coalesce((SELECT '; ' || inp.cust || '''s newest message, ' || public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
                               || o.note || ', is off the job and not yet checked by the reader'
                        FROM ofj o WHERE o.at > wl.at), '')
    FROM wl, LATERAL (SELECT nullif(btrim(substring(wl.what FROM ': "(.*)"$')), '') AS w) x) AS wrote_words,
   -- (seventh review) the customer's newest message is off the job and newer than the item they
   -- owe (ofl), or (eighth review) their newest message on the job is unread and newer than what
   -- they or another party owe (ojl): the newer of the two named, where it sits (or what it is),
   -- unchecked, with our last reply (never beside a quote waiting whose own words already name the
   -- contact since it)
   (SELECT CASE WHEN o.off THEN inp.cust || '''s newest message, ' || public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
                                || o.note || ', is off the job and not yet checked by the reader'
                ELSE inp.cust || '''s newest message, ' || public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
                     || ' (' || o.note || '), is not yet checked by the reader' END
           || coalesce('; ' || cw.rp, '')
    FROM (SELECT f.at, f.note, true AS off FROM ofj f UNION ALL SELECT c.at, c.kind, false FROM ojc c) o
    WHERE (SELECT wm0.whose FROM wm0) = 'unknown' AND NOT EXISTS (SELECT 1 FROM wl) AND (EXISTS (SELECT 1 FROM ofl) OR EXISTS (SELECT 1 FROM ojl))
      AND NOT EXISTS (SELECT 1 FROM top t WHERE t.owner = 'unknown' AND position('R7_quote_waiting' IN t.rule) > 0)
    ORDER BY o.at DESC, o.off DESC LIMIT 1) AS off_words,
   -- the customer wrote after a future booking was made (check C6), unread: their words
   (SELECT inp.cust || ' wrote ' || public.context_job_story_day((c.opened_at AT TIME ZONE 'Australia/Perth')::date, phs.today)
           || ' after the booking was made: "' || CASE WHEN length(x.w) > 90 THEN left(x.w, 87) || '...' ELSE x.w END || '"'
    FROM rl c, LATERAL (SELECT nullif(btrim(substring(c.what FROM ': "(.*)"$')), '') AS w) x
    WHERE c.rule = 'C6_booking_after_customer_word' AND x.w IS NOT NULL
      AND NOT (led.live_read AND coalesce(led.read_ids ? c.source_id, false))
      AND c.source_id IS DISTINCT FROM (SELECT wl.source_id FROM wl)
    ORDER BY c.opened_at DESC, c.source_id COLLATE "C" DESC LIMIT 1) AS c6_words,
   -- a quote the customer declined, with no quote sent since
   CASE WHEN phs.declined IS NOT NULL
        THEN 'the customer declined quote ' || coalesce(phs.declined->>'quote_number', 'without a number')
             || coalesce(' v' || (phs.declined->>'version'), '') || ' on '
             || public.context_job_story_day(((phs.declined->>'declined_at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, phs.today) END AS decline_words,
   -- (lead cutoff, 20261007010000) a lead no longer followed up: said in place of whose move, with
   -- the item still open on it (cut at a word, as the move's item is), unless that is the quote
   -- waiting on the customer, which says the same in its own words
   CASE WHEN ld.off
        THEN 'Lead not followed up since '
             || coalesce(public.context_job_story_day((ld.cutoff_at AT TIME ZONE 'Australia/Perth')::date, phs.today), 'a day not known')
             || ': ' || (ld.win_h / 168)::text || ' weeks after the last quote or message with no progress'
             || coalesce((SELECT '; open: ' || CASE WHEN length(w.w) <= 200 THEN w.w
                                                 ELSE rtrim(left(w.w, 197 - position(' ' IN reverse(left(w.w, 197)))), ' ,;:') || '...' END
                          FROM top t, LATERAL (SELECT regexp_replace(regexp_replace(t.what, '\. Lead not followed up since [^:]*: [0-9]+ weeks after the last quote or message with no progress$', ''),
                                                                     '\s+', ' ', 'g') AS w) w
                          WHERE NOT (position('R7_quote_waiting' IN t.rule) > 0 AND t.owner = 'customer')), '') END AS lead_words
  FROM phs, nx, mt, wm, led, inp, cw, dd, ld, ipm
 ),
 nowl AS (
  SELECT n.*, (SELECT string_agg(upper(left(x.s, 1)) || substr(x.s, 2), '. ' ORDER BY x.o) FROM (VALUES
           (1, n.phase_words || coalesce(': ' || n.next_words, '') || coalesce('; ' || n.att_words, '')),
           (2, n.agreed_words),
           (3, nullif(concat_ws(', ', n.owing_words, n.elsewhere_words, n.draft_words, n.nyi_words), '')),
           (4, coalesce(n.lead_words, n.move_words || coalesce(', ' || n.top_words, ''))),
           (5, n.decline_words),
           (6, coalesce(n.wrote_words, n.off_words)),
           (7, n.c6_words)) x(o, s) WHERE x.s IS NOT NULL) AS line0
  FROM nowp n
 ),
 nowline AS (
  -- (no em or en dash ever reaches the line, whatever words it quotes)
  SELECT n.*, CASE WHEN length(n.l0) <= 399 THEN n.l0 || CASE WHEN n.l0 ~ '[.!?"]$' THEN '' ELSE '.' END
                   ELSE left(n.l0, 396 - position(' ' IN reverse(left(n.l0, 396)))) || '...' END AS line
  FROM (SELECT n.*, replace(replace(n.line0, chr(8212), ', '), chr(8211), '-') AS l0 FROM nowl n) n
 ),
 blockers AS (  -- in loop rank order, then the drafts by loop key
  SELECT l.what, l.cites, l.rank AS o, l.key AS k FROM loops l WHERE l.blocks IS NOT NULL
    -- (story lead rank) a loop a newer open loop overtook (it blocks an earlier stage) blocks
    -- nothing now: it stays in the loops, open, with its blocks
    AND NOT l.overtaken
  UNION ALL
  SELECT r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)), NULL::bigint, r.loop_key
  -- (sixth review) a draft that may duplicate issued invoices of its stage (R3 shown as a
  -- check) blocks nothing: it is never our move
  FROM rl r WHERE r.rule = 'R3_draft' AND r.shown_as IS DISTINCT FROM 'check'
 ),
 -- not known
 nk AS (
  SELECT x.what, x.why, x.ord FROM inp, led, LATERAL (VALUES
   (1, CASE WHEN coalesce((inp.meta->'lanes'->>'texts')::int, 0) = 0 THEN 'No texts are on record for this job.' END,
       'Texts reach a job only through its CRM contact or a job reference.'),
   (2, CASE WHEN coalesce((inp.meta->'lanes'->>'emails')::int, 0) = 0 THEN 'No emails are on record for this job.' END,
       'Emails reach a job by thread, sender or job reference.'),
   (3, CASE WHEN coalesce((inp.meta->'lanes'->>'calls')::int, 0) = 0 THEN 'No calls are on record for this job.' END,
       'Only calls logged by the phone system are captured.'),
   (4, CASE WHEN coalesce((inp.meta->'lanes'->>'documents')::int, 0) = 0 THEN 'No documents have been read into evidence for this job.' END,
       'Only documents whose text was extracted are evidence.'),
   (5, CASE WHEN (inp.meta->>'history_start')::timestamptz > (inp.job->>'created_at')::timestamptz + interval '2 days'
            THEN 'Message history on record starts ' || to_char(((inp.meta->>'history_start')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY')
                 || ', after the job began ' || to_char(((inp.job->>'created_at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY') || '.' END,
       'Earlier messages were not captured.'),
   (6, CASE WHEN led.gen IS NOT NULL AND coalesce(led.unread, 0) > 0
            THEN led.unread || CASE WHEN led.unread = 1 THEN ' newer message on this job has' ELSE ' newer messages on this job have' END
                 || ' not been read by the reader yet.' END,
       'The reader reads new evidence on its own schedule.'),
   (7, CASE WHEN coalesce((inp.meta->'unplaced'->>'count')::int, 0) > 0
            THEN (inp.meta->'unplaced'->>'count') || CASE WHEN (inp.meta->'unplaced'->>'count')::int = 1 THEN ' message' ELSE ' messages' END
                 || ' from this customer are not placed on any job yet.' END,
       'They may belong to this job; they wait in the placement queue.'),
   (7, CASE WHEN coalesce((inp.meta->'withheld_mail'->>'count')::int, 0) > 0
            THEN (inp.meta->'withheld_mail'->>'count') || CASE WHEN (inp.meta->'withheld_mail'->>'count')::int = 1
                 THEN ' email from this customer is not placed on any job; it may belong to another of their jobs.'
                 ELSE ' emails from this customer are not placed on any job; they may belong to another of their jobs.' END END,
       'This customer has more than one job, so mail the old inbox placed on no job is kept off each of them.'),
   (7, CASE WHEN coalesce((inp.meta->'mail_copy_elsewhere'->>'count')::int, 0) > 0
            THEN (inp.meta->'mail_copy_elsewhere'->>'count') || CASE WHEN (inp.meta->'mail_copy_elsewhere'->>'count')::int = 1
                 THEN ' email on this job is shown from the old inbox: its saved copy is on no job yet or on a job that is not live (archived, completed, cancelled, lost, a draft or holding).'
                 ELSE ' emails on this job are shown from the old inbox: their saved copies are on no job yet or on a job that is not live (archived, completed, cancelled, lost, a draft or holding).' END END,
       'A saved copy filed on a live job decides where an email belongs, and the email then leaves this job; until one is, the old inbox row stands in for it.'),
   (7, CASE WHEN coalesce((inp.meta->'time_unknown_texts'->>'count')::int, 0) > 0
            THEN (inp.meta->'time_unknown_texts'->>'count') || CASE WHEN (inp.meta->'time_unknown_texts'->>'count')::int = 1
                 THEN ' text on this job was loaded from the CRM''s cache and the CRM''s own time for it is no longer kept; it is not read as this customer''s words.'
                 ELSE ' texts on this job were loaded from the CRM''s cache and the CRM''s own time for them is no longer kept; they are not read as this customer''s words.' END END,
       'The cache keeps only each contact''s newest messages; a text that dropped out before its time was kept has only its load time, which may be weeks late.'),
   (7, CASE WHEN coalesce((inp.meta->'before_job_texts'->>'count')::int, 0) > 0
            THEN (inp.meta->'before_job_texts'->>'count') || CASE WHEN (inp.meta->'before_job_texts'->>'count')::int = 1
                 THEN ' text on this job is dated by the CRM more than 30 days before the job was created; it is not read as this customer''s words.'
                 ELSE ' texts on this job are dated by the CRM more than 30 days before the job was created; they are not read as this customer''s words.' END END,
       'The CRM contact may have been another person''s, or an earlier enquiry''s, at the time.'),
   (8, CASE WHEN EXISTS (SELECT 1 FROM rl r WHERE r.rule = 'C4_booking_attendance_unrecorded')
            THEN 'Attendance is not recorded for a booking that has passed.' END,
       'The crew did not mark it started or complete.'),
   (9, CASE WHEN led.status = 'none' THEN 'No reader has read this job''s messages yet, so promises, requests and agreements in the words are not shown.'
            WHEN led.status IN ('shadow', 'building') AND led.gen IS NULL THEN 'The reader''s ledger for this job is not live yet, so the words are not shown.' END,
       'The ledger is written by the reader and shown once live.'),
   (10, CASE WHEN led.hidden - led.hidden_locked > 0 THEN (led.hidden - led.hidden_locked)
             || CASE WHEN led.hidden - led.hidden_locked = 1 THEN ' reader item was' ELSE ' reader items were' END
             || ' hidden because messages it cited moved off this job; the story needs a rebuild.' END,
        'A ledger item is shown only while every message it cites is still on this job.'),
   (14, CASE WHEN led.hidden_locked > 0 THEN led.hidden_locked
             || CASE WHEN led.hidden_locked = 1 THEN ' staff correction cites a message' ELSE ' staff corrections cite messages' END
             || ' that moved off this job; a person needs to check '
             || CASE WHEN led.hidden_locked = 1 THEN 'it.' ELSE 'them.' END END,
        'A rebuild keeps staff corrections as they are, so only a person can fix this.'),
   (11, CASE WHEN coalesce((inp.meta->>'contact_missing')::boolean, false) THEN 'This job has no CRM contact, so texts and calls may not reach it.' END,
        'Texts and calls are placed by the CRM contact.'),
   -- (ninth review) on builder work, contact details shared with another client's job: why the
   -- line calls the contact's messages the job contact's, never the insured's
   (11, CASE WHEN inp.bw AND coalesce((inp.meta->'contact_shared'->>'shared')::boolean, false)
             THEN (SELECT 'This job''s ' || CASE WHEN cardinality(n.a) = 1 THEN n.a[1]
                                                 ELSE array_to_string(n.a[1:cardinality(n.a) - 1], ', ') || ' and ' || n.a[cardinality(n.a)] END
                          || CASE WHEN cardinality(n.a) > 1 THEN ' are' ELSE ' is' END
                          || ' also on ' || CASE WHEN coalesce((inp.meta->'contact_shared'->>'other_jobs')::int, 0) > 1
                                                 THEN (inp.meta->'contact_shared'->>'other_jobs') || ' jobs of other clients'
                                                 ELSE 'another client''s job' END
                          || ', so the messages the story names are not taken to be the insured''s: the first line calls them the job contact''s.'
                   FROM (SELECT array_agg(CASE b.v WHEN 'contact' THEN 'CRM contact' WHEN 'phone' THEN 'client phone' ELSE 'client email' END ORDER BY b.o) AS a
                         FROM jsonb_array_elements_text(coalesce(inp.meta->'contact_shared'->'by', '[]'::jsonb)) WITH ORDINALITY b(v, o)) n) END,
        'A contact shared across clients is likely a builder''s or an agent''s, not the homeowner''s.'),
   (12, CASE WHEN led.status = 'shadow' AND led.gen IS NOT NULL THEN 'This story shows a shadow reading that is not live yet.'
             WHEN led.gen IS NOT NULL AND led.gen->>'status' IN ('failed', 'retired', 'building')
             THEN 'This story shows a ' || (led.gen->>'status') || ' reading, not the live one.' END,
        'A shadow generation is checked before it is promoted; a failed, retired or unfinished one is never shown by default.'),
   (13, 'Phone calls that were not recorded are not here.', 'Only calls the phone system logged are captured.')
  ) x(ord, what, why)
  WHERE x.what IS NOT NULL
 ),
 -- who
 who AS (
  SELECT DISTINCT ON (lower(w.name), w.role) w.name, w.role, w.contact_ref, w.cites, w.ord FROM (
   -- on builder work (make-safe, repair, insurance) the builder is the customer and the
   -- homeowner the insured (story safety, 20261006040000); (ninth review) a CRM contact shared
   -- with another client's job (meta contact_shared) is never given as the insured's own
   SELECT inp.job->>'client_name' AS name, CASE WHEN inp.job->>'type' IN ('makesafe', 'repair', 'insurance') THEN 'insured' ELSE 'customer' END AS role,
          CASE WHEN inp.bw AND coalesce((inp.meta->'contact_shared'->>'shared')::boolean, false) THEN NULL ELSE inp.job->>'ghl_contact_id' END AS contact_ref,
          jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')) AS cites, 1 AS ord
   FROM inp WHERE nullif(btrim(inp.job->>'client_name'), '') IS NOT NULL
   UNION ALL
   SELECT m.party, CASE WHEN inp.job->>'type' IN ('makesafe', 'repair', 'insurance') THEN 'customer' ELSE 'payer' END, m.xero_contact_id,
          (SELECT jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i->>'id')) FROM jsonb_array_elements(m.invoices) i), 2
   FROM mo m, inp WHERE m.party IS NOT NULL  -- a payer has an issued invoice; drafts alone make nobody a payer
     AND (coalesce(m.invoiced, 0) > 0 OR coalesce(m.paid, 0) > 0 OR coalesce(m.credited, 0) > 0)
   UNION ALL
   -- the builder named on the make-safe details, before any invoice names them
   SELECT inp.rec->'facts'->>'builder', 'customer', NULL, jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')), 2
   FROM inp WHERE inp.job->>'type' IN ('makesafe', 'repair', 'insurance') AND nullif(btrim(inp.rec->'facts'->>'builder'), '') IS NOT NULL
   UNION ALL
   SELECT p->>'name', coalesce(p->>'role', 'party'), p->>'contact_ref', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', p->>'id')), 3
   FROM inp, jsonb_array_elements(coalesce(inp.rec->'facts'->'parties', '[]'::jsonb)) p WHERE nullif(btrim(p->>'name'), '') IS NOT NULL
   UNION ALL
   SELECT n.nm, n.rl, NULL, (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(n.ob) c), 4
   FROM (SELECT v.from_name AS nm, v.from_role AS rl, v.opened_by AS ob FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')
         UNION ALL SELECT v.to_name, v.to_role, v.opened_by FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')) n
   WHERE nullif(btrim(n.nm), '') IS NOT NULL
  ) w ORDER BY lower(w.name), w.role, w.ord, w.name COLLATE "C", w.contact_ref COLLATE "C", w.cites::text COLLATE "C"
 ),
 cm AS (
  SELECT
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND (v.due_date IS NULL OR (v.closed_at AT TIME ZONE 'Australia/Perth')::date <= v.due_date)) AS kept,
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND v.due_date IS NOT NULL AND (v.closed_at AT TIME ZONE 'Australia/Perth')::date > v.due_date) AS late,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND (v.due_date IS NULL OR v.due_date >= inp.today)) AS open_,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND v.due_date < inp.today) AS overdue
 ),
 tlout AS (
  SELECT t.*,
   CASE t.kind WHEN 'quote' THEN 'quote' WHEN 'invoice' THEN 'invoice' WHEN 'payment' THEN 'payment' WHEN 'credit' THEN 'payment'
        WHEN 'booking' THEN 'scheduled' WHEN 'attendance' THEN 'install' WHEN 'site_visit' THEN 'scope' WHEN 'first_contact' THEN 'enquiry'
        WHEN 'job_created' THEN 'enquiry' WHEN 'rectification' THEN 'rectification' WHEN 'makesafe' THEN 'makesafe' END AS phase
  FROM tl t WHERE t.kind <> 'booking_mirror'
 )
 SELECT jsonb_build_object(
  'version', 'job-story-v1',
  'job', (SELECT jsonb_build_object('id', inp.job->'id', 'job_number', inp.job->'job_number', 'type', inp.job->'type',
                 'status', inp.job->'status', 'client_name', inp.job->'client_name', 'site_suburb', inp.job->'site_suburb',
                 'created_at', inp.job->'created_at') FROM inp),
  'as_of', (SELECT inp.as_of FROM inp),
  'now', (SELECT jsonb_build_object(
            'line', n.line, 'phase', n.phase,
            'phase_since', (n.phase_since_at AT TIME ZONE 'Australia/Perth')::date,
            -- (story settled notes) the phase is install and the messages say the work happened
            'installed_per_messages', (SELECT ipm.on_ FROM ipm),
            'whose_move', (SELECT wm.whose FROM wm),
            -- (lead cutoff, 20261007010000) whether the job is followed up, and since when it is not
            -- (scoping pipeline, 20261009133000) the rule's own answer, a draft's among them
            'monitored', (SELECT ld.monitored FROM ld),
            'not_followed_up_since', (SELECT CASE WHEN ld.off THEN (ld.cutoff_at AT TIME ZONE 'Australia/Perth')::date END FROM ld),
            'next', CASE WHEN (SELECT nx.b FROM nx) IS NOT NULL
                         THEN (SELECT jsonb_build_object('what', 'Visit booked: ' || replace(coalesce(nx.b->>'assignment_type', 'visit'), '_', ' ')
                                                         || coalesce(' (' || nullif(btrim(nx.b->>'crew_name'), '') || ')', ''),
                                                         'when', nx.b->'scheduled_date', 'day', nx.day,
                                                         'cites', jsonb_build_array(jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id'))) FROM nx)
                         -- (story lead rank) the latest agreed position, when made after the top item opened
                         WHEN EXISTS (SELECT 1 FROM agl)
                         THEN (SELECT jsonb_build_object('what', a.what, 'when', a.due_date, 'cites', coalesce(a.cites, '[]'::jsonb), 'kind', 'agreement')
                               FROM agl a)
                         WHEN EXISTS (SELECT 1 FROM top)
                         THEN (SELECT jsonb_build_object('what', t.what, 'when', t.due, 'cites', t.cites) FROM top t) END,
            'latest_agreement', (SELECT jsonb_build_object('key', a.item_key, 'what', a.what, 'since', a.opened_at, 'cites', coalesce(a.cites, '[]'::jsonb))
                                 FROM agl a),
            'blockers', coalesce((SELECT jsonb_agg(jsonb_build_object('what', b.what, 'cites', b.cites) ORDER BY b.o NULLS LAST, b.k COLLATE "C")
                                  FROM blockers b), '[]'::jsonb),
            'cites', coalesce((SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
                       FROM (SELECT DISTINCT z.c FROM (
                       SELECT c FROM top t, jsonb_array_elements(t.cites) c
                       UNION ALL SELECT c FROM agl a, jsonb_array_elements(coalesce(a.cites, '[]'::jsonb)) c
                       UNION ALL SELECT jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id') FROM nx WHERE nx.b IS NOT NULL
                       UNION ALL SELECT jsonb_build_object('t', 'jobs', 'id', inp.job->>'id') FROM inp) z) d), '[]'::jsonb))
          FROM nowline n),
  'money', (SELECT jsonb_build_object(
             'line', CASE WHEN mt.invoiced = 0 AND mt.drafts = 0 THEN 'No invoices issued'
                          ELSE 'Invoiced ' || to_char(mt.invoiced, 'FM$999,999,990.00') || ', paid ' || to_char(mt.paid, 'FM$999,999,990.00')
                               || CASE WHEN mt.credited > 0 THEN ', credited ' || to_char(mt.credited, 'FM$999,999,990.00') ELSE '' END
                               || ', owing ' || to_char(mt.owing, 'FM$999,999,990.00') END
                     || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue since '
                                                     || to_char(mt.oldest_overdue, 'Dy FMDD Mon') || ')' ELSE '' END
                     || CASE WHEN mt.drafts > 0 THEN '; ' || mt.drafts || ' draft ' || CASE WHEN mt.drafts = 1 THEN 'invoice' ELSE 'invoices' END
                                                     || ' of ' || to_char(mt.draft_total, 'FM$999,999,990.00') || ' not issued'
                                                     -- (eighth review) one shown as an R3 check may duplicate issued invoices
                                                     || CASE WHEN dd.n = 0 THEN ''
                                                             WHEN dd.n >= mt.drafts THEN CASE WHEN mt.drafts = 1 THEN ' (it may' ELSE ' (they may' END
                                                                                         || ' duplicate issued invoices; check R3)'
                                                             ELSE ' (' || dd.n || ' of them, ' || to_char(dd.total, 'FM$999,999,990.00')
                                                                  || ', may duplicate issued invoices; check R3)' END
                                                ELSE '' END
                     || CASE WHEN coalesce(mt.nyi, 0) > 1 THEN '; ' || to_char(mt.nyi, 'FM$999,999,990.00') || ' of the job value not yet invoiced'
                             WHEN unconf.on_ AND unconf.r8 THEN '; the job value is unconfirmed (check C2), so what is left to invoice is not known'
                             ELSE '' END
                     || CASE WHEN mt.parties > 1 THEN '; ' || mt.parties || ' paying parties' ELSE '' END
                     -- (sixth review) never "owing $0.00" alone over a debt of this job's Xero
                     -- contact that sits on an invoice placed on no job
                     || coalesce('; ' || (SELECT uw.words FROM uw), '') || '.',
             'job_value', jsonb_build_object('amount', mt.job_value, 'basis', mt.job_value_basis),
             -- (sixth review) the invoices placed on no job addressed to this job's own Xero
             -- contact, still owing; never in owing above (they are not on this job)
             'placed_on_no_job', coalesce((SELECT jsonb_agg(jsonb_build_object('number', u.num, 'owing', u.owing, 'due_date', u.due,
                                   'days_overdue', u.days, 'cites', jsonb_build_array(jsonb_build_object('t', 'xero_invoices', 'id', u.id)))
                                   ORDER BY u.o) FROM uinv u), '[]'::jsonb),
             'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('party', m.party, 'xero_contact_id', m.xero_contact_id,
                          'invoiced', m.invoiced, 'paid', m.paid, 'credited', m.credited, 'owing', m.owing, 'overdue', m.overdue,
                          'oldest_overdue_due', m.oldest_overdue_due, 'drafts', m.drafts, 'draft_total', m.draft_total,
                          'invoices', m.invoices) ORDER BY m.owing DESC, m.party COLLATE "C", m.xero_contact_id COLLATE "C")
                          FROM mo m WHERE m.party IS NOT NULL), '[]'::jsonb),
             'not_yet_invoiced', CASE WHEN coalesce(mt.nyi, 0) > 1
                                      THEN jsonb_build_object('amount', mt.nyi, 'basis', 'job value (' || coalesce(mt.job_value_basis, 'unknown')
                                                              || ') minus issued customer invoices',
                                                              'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')))
                                      WHEN unconf.on_ AND unconf.r8
                                      THEN jsonb_build_object('amount', NULL, 'unconfirmed', true,
                                                              'basis', 'unconfirmed: another record disagrees with the job value (check C2)',
                                                              'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id'))) END,
             'supplier_bills', coalesce(mt.bills, '[]'::jsonb))
           FROM mt, inp, unconf, dd),
  'loops', coalesce((SELECT jsonb_agg(jsonb_build_object('key', l.key, 'source', l.source, 'rule', l.rule, 'about_key', l.about_key,
             'owner', l.owner, 'owner_name', l.owner_name, 'counterparty', l.counterparty, 'what', l.what, 'why', l.why, 'since', l.since,
             'due', l.due, 'age_days', l.age_days, 'status', l.status, 'closes_when', l.closes_when, 'blocks', l.blocks,
             'closing_evidence', l.closing_evidence, 'cites', l.cites, 'rank', l.rank,
             -- (story settled notes) an issue or claim opened only on the customer's words
             'customer_reported', l.customer_reported) ORDER BY l.rank) FROM loops l), '[]'::jsonb),
  'checks', coalesce((SELECT jsonb_agg(jsonb_build_object('rule', c.rule, 'what', c.what, 'cites', c.cites)
                              ORDER BY c.opened_at, c.rule COLLATE "C", c.cites::text COLLATE "C", c.what COLLATE "C")
                      FROM checks c), '[]'::jsonb),
  -- each line names its record and that record's state (and a booking when it was made),
  -- so nothing downstream reads them from the words
  'timeline', coalesce((SELECT jsonb_agg(jsonb_build_object('at', t.at, 'date', t.perth_date, 'kind', t.kind, 'what', t.what,
                         'amount', t.amount, 'phase', t.phase, 'source_table', t.source_table, 'source_id', t.source_id,
                         'state', t.state, 'made_at', t.made_at,
                         'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id)))
                         ORDER BY t.at, t.kind COLLATE "C", t.source_id COLLATE "C", t.what COLLATE "C") FROM tlout t), '[]'::jsonb),
  'phase_notes', coalesce((SELECT jsonb_agg(jsonb_build_object('phase', v.phase, 'what', v.what,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                   ORDER BY v.opened_at DESC, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'phase_note'
                   AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'agreements', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'modality', v.modality, 'since', v.opened_at,
                  'status', v.status, 'supersedes', v.supersedes_key,
                  'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                  ORDER BY v.opened_at DESC, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'agreement'), '[]'::jsonb),
  'events', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'at', v.opened_at,
              'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
              ORDER BY v.opened_at DESC, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'event'
              AND v.status NOT IN ('disputed', 'superseded', 'declined')
              AND NOT EXISTS (SELECT 1 FROM evh WHERE evh.item_key = v.item_key)), '[]'::jsonb),
  -- (story settled notes, 20261011120000) the notes the reader settled (closed, declined or
  -- superseded) and the ones it found disputed, newest first, each with its status, when and what
  -- settled it (the item's closing rows, else the transition's evidence; the reader's reason; the
  -- item that replaced it), so a cancelled visit, a corrected booking or our side of a dispute is
  -- never lost because nothing about it is open. Nothing is closed, opened or written here.
  'settled', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'type', v.item_type, 'what', v.what, 'about_key', v.about_key,
                'status', v.status, 'since', v.opened_at, 'closed_at', coalesce(v.closed_at, t.at),
                'closed_by', coalesce((SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id'))
                                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.closed_by) = 'array' AND jsonb_array_length(v.closed_by) > 0
                                                                      THEN v.closed_by ELSE coalesce(t.evidence, '[]'::jsonb) END) c), '[]'::jsonb),
                'reason', t.reason,
                'replaced_by', (SELECT s.item_key FROM vis s WHERE s.supersedes_key = v.item_key
                                ORDER BY s.opened_at DESC, s.item_key COLLATE "C" DESC LIMIT 1),
                'customer_reported', EXISTS (SELECT 1 FROM vcust vc WHERE vc.item_key = v.item_key),
                'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id'))
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.opened_by) = 'array' THEN v.opened_by ELSE '[]'::jsonb END) c))
                ORDER BY coalesce(v.closed_at, t.at) DESC NULLS LAST, v.opened_at DESC, v.item_key COLLATE "C")
              FROM vis v LEFT JOIN trn t ON t.item_key = v.item_key
              WHERE v.status IN ('closed', 'declined', 'superseded')), '[]'::jsonb),
  'disputed', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'type', v.item_type, 'what', v.what, 'about_key', v.about_key,
                'status', v.status, 'since', v.opened_at, 'disputed_at', t.at, 'why', t.reason,
                'customer_reported', EXISTS (SELECT 1 FROM vcust vc WHERE vc.item_key = v.item_key),
                'cites', (SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
                          FROM (SELECT DISTINCT jsonb_build_object('t', c->>'table', 'id', c->>'id') AS c
                                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.opened_by) = 'array' THEN v.opened_by ELSE '[]'::jsonb END
                                                          || coalesce(t.evidence, '[]'::jsonb)) c) d))
                ORDER BY coalesce(t.at, v.opened_at) DESC, v.opened_at DESC, v.item_key COLLATE "C")
              FROM vis v LEFT JOIN trn t ON t.item_key = v.item_key
              WHERE v.status = 'disputed'), '[]'::jsonb),
  'who', coalesce((SELECT jsonb_agg(jsonb_build_object('name', w.name, 'role', w.role, 'contact_ref', w.contact_ref, 'cites', w.cites)
                   ORDER BY w.ord, w.name COLLATE "C", w.role COLLATE "C") FROM who w), '[]'::jsonb),
  'last_exchange', (SELECT jsonb_build_object('customer_said', inp.rec->'contact'->'last_customer_message',
                     'we_told_customer', inp.rec->'contact'->'last_to_customer', 'internal', inp.rec->'contact'->'last_internal') FROM inp),
  'handling', (SELECT jsonb_build_object('customer_messages', coalesce((inp.rec->'contact'->>'customer_messages')::int, 0),
                'replies', coalesce((inp.rec->'contact'->>'replies')::int, 0),
                'median_reply_hours', (inp.rec->'contact'->>'median_reply_hours')::numeric,
                'unanswered', coalesce((inp.rec->'contact'->>'unanswered')::int, 0),
                -- left empty (null) until a live reading has read the words: none could be counted
                'commitments', CASE WHEN led.live_read
                                    THEN jsonb_build_object('kept', cm.kept, 'late', cm.late, 'open', cm.open_, 'overdue', cm.overdue) END)
               FROM inp, cm, led),
  'not_known', coalesce((SELECT jsonb_agg(jsonb_build_object('what', k.what, 'why', k.why) ORDER BY k.ord, k.what COLLATE "C") FROM nk k), '[]'::jsonb),
  'changes', (SELECT CASE WHEN inp.since IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(x.o ORDER BY x.at, x.o::text COLLATE "C") FROM (
               SELECT t.at, jsonb_build_object('at', t.at, 'kind', t.kind, 'what', t.what,
                      'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id))) AS o
               FROM tlout t WHERE t.at > inp.since AND t.at <= inp.as_of
               UNION ALL
               SELECT l.since, jsonb_build_object('at', l.since, 'kind', 'loop_opened', 'what', l.what, 'cites', l.cites)
               FROM loops l WHERE l.since > inp.since
               UNION ALL
               SELECT (x->>'at')::timestamptz, jsonb_build_object('at', x->'at', 'kind', 'ledger_' || coalesce(x->>'to_status', 'change'),
                      'what', coalesce(x->>'reason', 'Ledger item ' || coalesce(x->>'item_key', '') || ' moved to ' || coalesce(x->>'to_status', '?')),
                      'cites', coalesce(x->'evidence', '[]'::jsonb))
               FROM jsonb_array_elements(coalesce(inp.led->'transitions', '[]'::jsonb)) x WHERE (x->>'at')::timestamptz > inp.since
              ) x), '[]'::jsonb) END FROM inp),
  'meta', (SELECT jsonb_build_object(
             'ledger', jsonb_build_object('status', led.status, 'generation_id', led.gen->'id', 'evidence_until', led.gen->'evidence_until',
                         'reader', led.gen->'reader', 'items', led.items, 'hidden_items', led.hidden, 'unread_rows', led.unread,
                         'needs_rebuild', led.hidden - led.hidden_locked > 0,
                         'stale', led.hidden - led.hidden_locked > 0 OR coalesce(led.unread, 0) > 0),
             'sources', coalesce(inp.meta->'sources', '{}'::jsonb), 'evidence_rows', coalesce((inp.meta->>'evidence_rows')::int, 0),
             -- (story settled notes) call-log events not shown because each call's transcript is on the job
             'call_log_events_hidden', (SELECT count(*) FROM evh),
             -- (story settled notes) how many call logs on the job have their transcript on it (meta call_transcripts)
             'calls_with_transcript', (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(inp.meta -> 'call_transcripts') = 'object'
                                                                                 THEN inp.meta -> 'call_transcripts' ELSE '{}'::jsonb END)),
             'built_at', now())
           FROM inp, led)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009133000) (story lead rank, 20261011100000) (story settled notes, 20261011120000) agreements, events and phase notes are newest first (items of one instant still by item key in C order); settled lists the notes the reader closed, declined or superseded and disputed the ones it found disputed, newest first, each with its status, when it settled or was disputed (the item''s closed_at, else the newest ledger transition the reader judged into that status: never its writing or a rebuild''s carry-forward), what settled it (closed_by: the item''s closing rows, else that transition''s evidence; reason: the reader''s; replaced_by: the item that supersedes it) or why it is disputed, and customer_reported; an event citing only call logs whose transcripts are on the job (meta call_transcripts, call row id to transcript id, from the story read) is not shown (meta.call_log_events_hidden counts them; meta.calls_with_transcript counts the pairs passed in); every loop carries customer_reported, true only on an issue or claim every opening row of which is the customer''s (its own stamp, else the citation check''s); and a job at install on a passed booking nobody marked, with an open completion-stage note (blocks completion, or phase complete or rectification) opened on or after that day, reads "Installed per messages; attendance not marked for <day>" ("Attended per messages" on builder work: a make-safe, repair or insurance job) (now.installed_per_messages true; the phase stays install). Nothing is closed, opened or written, and every loop stays. Earlier (story lead rank) the open loops that may lead the line rank first and the top item is one of them within the party whose move it is: a held loop never leads; of the open loops on one object (about_key) only the newest may lead; a loop that blocks an earlier stage (quote, acceptance, deposit, booking, install, completion, payment) than a newer open loop blocks never leads. Every loop stays in the list with its status (nothing is closed, hidden or written), whose move is unchanged, and the party still comes first, so when every loop of the party whose move it is may not lead, its best-ranked loop is still the top; a loop overtaken by a newer open loop at a later stage leaves now.blockers (it stays a loop, open, with its blocks); and the newest standing agreement (modality agreed, status open or info), made in the 14 days up to as_of and after every open loop that may lead of the party whose move it is (of every party while that is unclear), is the latest agreed position: the first line says it right after the phase ("Latest agreement <day>: ...", cut at a word at 160 characters), next is it unless a visit is booked (kind agreement), now.latest_agreement names it and now.cites carries its citations. Earlier (scoping pipeline) only a lead the rule calls not followed up (record lead state not_followed_up, or a lead row with no state, as before) is off: a draft the rule does not monitor (state draft_quiet or draft_no_activity) keeps its line, whose move and the off-job messages it names, and now.monitored is the rule''s own answer (false for such a draft, true when no lead is passed in); the lead words and the start of the window the off-job check uses are the job''s own window (context_lead_window_hours: "6 weeks" on a patio job, else "4 weeks"). Earlier (lead cutoff) a lead no longer followed up (record lead, from context_lead_monitored_jobs: still at quoted with no progress 28 days after the newer of its newest quote send and the customer''s newest text, email or call, wherever it is placed, so every customer contact the line names is one the rule counts) is never the customer''s move: whose_move not_followed_up, and the first line says "Lead not followed up since <day>: 4 weeks after the last quote or message with no progress" in place of whose move, then the item still open on it unless that is the quote waiting on the customer (whose own words end the same); on such a lead an off-job message newer than the start of its 4 weeks (meta off_job, unplaced, withheld_mail) is never named as the customer''s, since the rule counted every one of theirs (such a message is mail from one of our own addresses entered as the client''s); now.monitored and now.not_followed_up_since say so (true and null when the record carries no lead, as for any caller of the pure assembler). Earlier (ninth review) on builder work the job''s CRM contact and client email are the insured''s only when the make-safe details name the builder (facts.builder) and meta contact_shared says none of the job''s contact details (CRM contact, client phone, client email) sits on another client''s job; otherwise (a contact shared across clients, a builder''s or an agent''s, no builder named, or the meta silent) the line calls their messages the job contact''s ("the job contact''s newest message", "the job contact wrote last"), they hold the builder''s move as the customer''s messages do, who gives the insured no shared contact, and not_known says the contact details are on another client''s job. Earlier (eighth review) an off-job message changes the move only of what its sender owes: the customer''s own items on private work, never a neighbour''s or another payer''s, and never on builder work while the job''s CRM contact and client email are the insured''s (the line names them "the insured") and the builder owes; the customer''s newest message on the job (a text, an email, an answered call or a call recording) that no finished reading has read makes whose move unclear over the top item they or another party owe from before it, named with our last reply; a reading with an item hidden gives no all-clear and says how many are hidden; the contact facts also take meta off_job (their rows on their other jobs and on bucket jobs, their email by address with no CRM contact), where each sits named; a newer message off the job is named after the customer wrote last; a draft shown as an R3 check is said in the first line and the money line to maybe duplicate issued invoices. Earlier (seventh review) whose move is unclear while the customer''s newest message is off the job and newer than the opening of the top item they or another party owe, and the line names that message, where it sits and that the reader has not checked it, with our last reply (one older than that item leaves its move standing); the phase reads a job the job value calls accepted (facts.accepted: the job row''s acceptance, an accepted quote or a paid deposit invoice) as at least accepted, since then, and processing on work other than a make-safe as accepted once it is; not_known says the mail shown from the old inbox has its saved copy on no job or on an archived or holding job (a copy on a live job takes the mail off this job). Earlier (sixth review) a job in rectification now has no work done (the final invoice is not due, said so), and the final invoice is not due either while work recorded finished was opened again since (facts.reopened: a status change into rectification or a make-safe re-attend, nothing recording it finished since); a quote waiting (R7) is a check once the work is done; a reading that has read every row on the job gives no all-clear while the customer''s newest message is off the job (meta unplaced newest_customer_at or withheld_mail newest_at newer than every customer message on the job): whose move is unknown and the line names that message, where it sits, and that the reader has not checked it; the first line and the money line name what this job''s own Xero contact owes on invoices placed on no job (meta unplaced_invoices; money.placed_on_no_job), never counting them in owing; not_known names texts whose CRM time is no longer kept. Earlier: until a finished reading shown (live or retired, or a shadow the story shows only when asked for it by id, so a grade reads the line a promotion gives; never a building or failed one) has read every row on the job (none unread), nothing open on record is never nobody''s move: whose_move unknown, the first line says "Whose move is unclear:" first, then that no record item is open (or due yet) and the messages are not yet checked for promises or requests (a reading that lags: how many newer messages, calls, notes or documents, ours included, it has not checked), with the newest customer message and our last reply, of the job''s own, this customer''s messages placed on no job yet and their withheld mail, naming where the newest sits (with neither anywhere it says so and claims nothing unchecked); with no finished reading handling.commitments is null, and only a finished reading judges a customer message; work is done only on a completion status, a completion record (facts.completion) or a report pack sent, never because the newest booking is complete; a final invoice (R8) before the work is done is not due (loop status not_due), and after it with the job value unconfirmed (C2, no amount) it is unconfirmed (status unconfirmed): either ranks last and is never the move or the first line''s item; a value another record disagrees with (C2) states no amount left to invoice; a quote the customer was in touch about since it was sent, in a way that does not close it (R7 owner unknown), makes whose move unclear and is the item the first line names; the first line''s item is cut at a word (200 characters); the customer''s unread words are "not yet checked by the reader"; the first line names each invoice owing with its due date, who owes it ("owed by") with their role whenever a neighbour or another payer owes it (whatever the move: its payer role, else its R1, R2 or M1 loop''s owner), and each payer when more than one owes, a passed booking with no attendance, a quote declined and the newest unread customer words (R5, C11, C6); the first line names the top loop of the party whose move it is, never another party''s (the customer''s move never names a neighbour''s invoice); a quote waiting reads as waiting on the customer; another party''s invoice reads as another payer owing; on builder work the builder is the customer and the homeowner the insured; not_known names mail shown from the old inbox and texts dated before the job. Earlier, story fixes: every text sort and tiebreak that reaches the output is in C (byte) order (who, money parties, loops and their rank, cites, checks, timeline, phase notes, agreements, events, not known, changes, blockers), so the story reads the same on every server whatever the input order. Earlier: the pure assembler of job-story-v1. Reads no table: job header, record parts (timeline, loops, money, contact, facts), ledger (generation, items with citation re-check result, transitions, its reader''s unread rows) and meta in; the cited story out. meta.ledger = {status, generation_id, evidence_until, reader, items, hidden_items, unread_rows, needs_rebuild, stale}. Inlinable (no SET). Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_ledger(p_job_id uuid, p_generation_id uuid DEFAULT NULL::uuid, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH g AS (  -- the generation asked for, else the one live at p_as_of (the newest promoted by then)
  SELECT x.* FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id
    AND CASE WHEN p_generation_id IS NOT NULL THEN x.id = p_generation_id
             ELSE x.status IN ('live', 'retired') AND x.promoted_at <= p_as_of END
  ORDER BY x.promoted_at DESC NULLS LAST, x.created_at DESC LIMIT 1
 ),
 other AS (  -- with no generation to show, say whether one is being built or waits in shadow
  SELECT x.status FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id AND x.status IN ('building', 'shadow') AND NOT EXISTS (SELECT 1 FROM g)
  ORDER BY x.created_at DESC LIMIT 1
 ),
 evr AS MATERIALIZED (  -- the store's own evidence against the shown generation's evidence_until:
                       -- read when it landed by then (nothing is read when no generation is shown);
                       -- (notes freshness, 20261009132000) unread by the ledger's one rule
  SELECT r.src_id, r.copy_of, r.direction, (g.evidence_until IS NOT NULL AND r.landed_at <= g.evidence_until) AS was_read,
         public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until) AS unread
  FROM g CROSS JOIN LATERAL public.context_ledger_evidence_rows(ARRAY[g.job_id], p_as_of) r
 ),
 unread AS (  -- what the shown generation's reader has not read; copies are listed by id
              -- but not counted as new messages; (notes freshness) an automated row (a workflow
              -- text, a crew or staff template) never makes the notes stale
  SELECT e.src_id, e.copy_of FROM evr e WHERE e.unread
 ),
 it0 AS (  -- replay: items written by p_as_of, each with its status then
  SELECT i.*, coalesce((SELECT t.to_status FROM public.context_ledger_transitions t WHERE t.item_id = i.id AND t.at <= p_as_of
                         ORDER BY t.at DESC, t.id DESC LIMIT 1), i.status) AS status_then
  FROM public.context_ledger_items i JOIN g ON g.id = i.generation_id
  WHERE i.created_at <= p_as_of
 ),
 -- (eighth review) the job, its client's address, and whether the client has another job (the
 -- citation check's rule for mail placed on no job)
 jb AS (
  SELECT j.created_at, lower(nullif(btrim(j.client_email), '')) AS cmail,
         (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(j.ghl_contact_id), '') AND o.id <> j.id)
          OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                     AND lower(btrim(o.client_email)) = lower(nullif(btrim(j.client_email), '')) AND o.id <> j.id)) AS repeat_client
  FROM public.jobs j WHERE j.id = p_job_id
 ),
 it AS (
  SELECT i.*,
   (SELECT jsonb_agg(jsonb_build_object('table', c->>'table', 'id', c->>'id', 'excerpt', c->>'excerpt',
            'at', coalesce(e.event_at, e.occurred_at),
            'ok', CASE
                       -- (eighth review) an old-inbox mail, as the citation check admits it now: placed
                       -- on this job, or from the client's address on no job (the client with no
                       -- other job, from 30 days before the job on), worded, no saved copy on this job
                       -- or on another live job, no email on this job from its sender at its instant
                       WHEN c->>'table' = 'inbox_events'
                       THEN coalesce(m.id IS NOT NULL AND m.received_at IS NOT NULL
                            AND (m.job_id = p_job_id
                                 OR (m.job_id IS NULL AND (SELECT jb.cmail FROM jb) IS NOT NULL AND lower(btrim(m.from_email)) = (SELECT jb.cmail FROM jb)
                                     AND NOT (SELECT jb.repeat_client FROM jb) AND m.received_at >= (SELECT jb.created_at FROM jb) - interval '30 days'))
                            AND coalesce(m.classification, '') NOT IN ('spam', 'newsletter')
                            AND coalesce(m.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
                            AND btrim(coalesce(m.subject, '') || coalesce(m.body_preview, '')) <> ''
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = m.id::text
                                             AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id
                                                  AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                  AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE m.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || m.graph_message_id
                                             AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id
                                                  AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                  AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
                                             AND b.payload @> jsonb_build_object('inbox_events_id', m.id::text)
                                             AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id
                                                  AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                  AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) = m.received_at
                                             AND lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = lower(btrim(m.from_email))
                                             AND b.job_id = p_job_id), false)
                       WHEN c->>'table' <> 'business_events' THEN true
                       -- (eighth review) never unknown: a cited row moved to no job, or with no
                       -- status, is not this job's evidence either (the judge already says so)
                       ELSE coalesce(e.id IS NOT NULL AND e.job_id = p_job_id AND public.context_linked_status(e.attribution_status)
                            AND e.metadata->>'retracted_at' IS NULL AND coalesce(e.metadata->>'retracted', 'false') <> 'true'
                            -- (eighth review) a CRM text loaded from the cache: its CRM time kept, and
                            -- not more than 30 days before the job was created
                            AND NOT (coalesce(e.source, '') = 'ghl_sms_cache_backfill'
                                     AND coalesce(ct.crm_at < (SELECT jb.created_at FROM jb) - interval '30 days', true)), false)
                            -- (held notes, 20261015100000) or a not-certain item's own opening
                            -- citation of a message still held for this job (context_ledger_held_citable)
                            OR hc.held
                       END,
            'customer', (e.metadata->'party_roles'->>'sender_role' = 'customer'))
            || CASE WHEN hc.held THEN jsonb_build_object('held', true) ELSE '{}'::jsonb END)
    FROM jsonb_array_elements(i.opened_by || CASE WHEN i.closed_at <= p_as_of THEN coalesce(i.closed_by, '[]'::jsonb) ELSE '[]'::jsonb END) c
    LEFT JOIN public.business_events e ON c->>'table' = 'business_events'
     AND e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END
    LEFT JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                   THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                          coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                              END AS crm_at) ct ON true
    -- (held notes) a held message the item was stored as opened by, still held for this job
    LEFT JOIN LATERAL (SELECT CASE WHEN i.job_not_certain AND e.id IS NOT NULL AND e.job_id IS NULL
                                    AND i.opened_by @> jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', e.id::text))
                                   THEN coalesce(public.context_ledger_held_citable(p_job_id, e.id, p_as_of), false)
                                   ELSE false END AS held) hc ON true
    LEFT JOIN public.inbox_events m ON c->>'table' = 'inbox_events'
     AND m.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END) AS cited
  FROM it0 i
 )
 SELECT jsonb_build_object(
  'status', coalesce((SELECT g.status FROM g), (SELECT other.status FROM other), 'none'),
  'generation', (SELECT jsonb_build_object('id', g.id, 'status', g.status, 'kind', g.kind, 'reader', g.reader, 'model', g.model,
                  'evidence_until', g.evidence_until, 'evidence_rows', g.evidence_rows, 'created_at', g.created_at,
                  'promoted_at', g.promoted_at) FROM g),
  'items', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', it.item_key, 'item_type', it.item_type, 'status', it.status_then,
              'from_role', it.from_role, 'from_name', it.from_name, 'to_role', it.to_role, 'to_name', it.to_name,
              -- (held notes) an item a held message still holds up says so in its own words
              'what', CASE WHEN it.held_now THEN 'Job not certain: ' || it.what ELSE it.what END,
              'about_key', it.about_key, 'modality', it.modality, 'phase', it.phase, 'due_date', it.due_date, 'opened_at', it.opened_at,
              'opened_by', it.opened_by,
              'closed_at', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_at END,
              'closed_by', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_by END,
              'closes_on', it.closes_on,
              'supersedes_key', it.supersedes_key, 'blocks', it.blocks, 'needs_reply', it.needs_reply, 'written_by', it.written_by,
              'person_locked', it.person_locked, 'cited', it.cited,
              'cites_ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(it.cited, '[]'::jsonb)) c WHERE NOT (c->>'ok')::boolean))
              -- (held notes, 20261015100000) only on an item a held message still holds up
              || CASE WHEN it.held_now THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END
              ORDER BY it.opened_at, it.item_key COLLATE "C")
            FROM (SELECT it.*, EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(it.cited, '[]'::jsonb)) c
                                       WHERE coalesce((c->>'held')::boolean, false)) AS held_now FROM it) it), '[]'::jsonb),
  'transitions', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', i.item_key, 'from_status', t.from_status,
                   'to_status', t.to_status, 'at', t.at, 'by', t.by, 'reason', t.reason, 'evidence', t.evidence) ORDER BY t.at, t.id)
                 FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id = t.item_id
                 JOIN g ON g.id = t.generation_id WHERE t.at <= p_as_of), '[]'::jsonb),
  'unread_rows', CASE WHEN EXISTS (SELECT 1 FROM g) THEN (SELECT count(*)::integer FROM unread u WHERE u.copy_of IS NULL) END,
  'unread_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(u.src_id::text ORDER BY u.src_id) FROM unread u), '[]'::jsonb) END,
  -- the inbound rows it has read: the story says the reader judged a customer message only for these
  'read_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(e.src_id::text ORDER BY e.src_id) FROM evr e
                    WHERE e.was_read AND e.direction = 'inbound'), '[]'::jsonb) END
 )
$function$;
COMMENT ON FUNCTION public.context_job_story_ledger(uuid,uuid,timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (notes freshness, 20261009132000) unread_rows and unread_ids read the ledger''s one rule (context_ledger_row_unread), as the judge, the due order and the go-live sweep do: a row of the store''s evidence that is not automated (a workflow text, a crew or staff template) and landed after the shown generation''s evidence_until, so an automated message alone never makes meta.ledger.stale true or puts the not-known line about newer messages on the card, and every other row the notes have not read does. Earlier (eighth review) each stored citation is re-checked by the citation check''s current rules (context_ledger_cite), so an item citing a row that is no longer this job''s evidence carries cites_ok false (the story hides it and asks for a rebuild; the judge raises citation_moved): a business_events row also needs, when it is a CRM text loaded from the cache (ghl_sms_cache_backfill), its CRM time kept and not more than 30 days before the job was created; an inbox_events mail must be placed on this job, or come from the client''s address on no job (the client with no other job, from 30 days before the job on), be worded, not spam, a newsletter or an auto-reply, with no saved copy on this job or on another live job (the judge''s live set: never archived, complete, completed, cancelled, lost, a draft or holding) by its source pointer, graph key or payload pointer, and no email on this job from its sender at its instant; and the check is never unknown (a cited row moved to no job, or with no attribution status, read as passing when the check came out null, is not this job''s evidence either, as the judge already said). Earlier, story fixes: items tie on opened_at by item_key in C (byte) order. Earlier: the ledger generation the story shows (the one live at p_as_of, or the one asked for in any status) with the items written by p_as_of, each at its status then, and the transitions by then; every business_events citation is re-checked (still on this job, linked, not retracted) and the item carries cites_ok. unread_rows: the store''s evidence (context_ledger_evidence_rows as of p_as_of, copies not counted) that landed after the shown generation''s evidence_until, so the story says how far its own reader has read; unread_ids: those rows and their copies by id; read_ids: the inbound evidence rows it has read (landed by its evidence_until), so a customer message is called judged only when the reader read it; all three null when no generation is shown. With no generation to show, status says building or shadow when one exists, else none. Service role only. Held notes (20261015100000): a not-certain item''s opening citation of a message still held for this job (context_ledger_held_citable as of p_as_of) is ok and carries held true; such an item carries job_certain false and certainty job_not_certain, and its what starts "Job not certain: ". When the message is later placed on this job the item reads as certain; placed on another job, the citation is not ok, the item is hidden and the judge asks for a rebuild, which drops it. No key changes for any other item.';

-- Keep the values. The column is about to go, and a second down finds it already gone.
DO $archive$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'context_ledger_items'
              AND column_name = 'person_review') THEN
  CREATE TABLE IF NOT EXISTS public.context_ledger_person_review_archive (
   item_id uuid PRIMARY KEY,
   job_id uuid NOT NULL,
   generation_id uuid NOT NULL,
   item_key text NOT NULL,
   person_review jsonb NOT NULL,
   archived_at timestamptz NOT NULL DEFAULT now()
  );
  EXECUTE $comment$COMMENT ON TABLE public.context_ledger_person_review_archive IS
   'Person review (20261018120000): person_review values copied off context_ledger_items before that column is dropped. A second down leaves the table and its rows. (person review, 20261018120000).'$comment$;
  INSERT INTO public.context_ledger_person_review_archive
   (item_id, job_id, generation_id, item_key, person_review)
  SELECT i.id, i.job_id, i.generation_id, i.item_key, i.person_review
  FROM public.context_ledger_items i
  WHERE i.person_review IS NOT NULL
  ON CONFLICT (item_id) DO NOTHING;
  EXECUTE 'REVOKE ALL ON TABLE public.context_ledger_person_review_archive FROM PUBLIC, anon, authenticated';
 END IF;
END $archive$;

DROP TRIGGER IF EXISTS context_ledger_items_person_review_guard ON public.context_ledger_items;
DROP FUNCTION IF EXISTS public.context_ledger_person_review_guard();
ALTER TABLE public.context_ledger_items DROP COLUMN IF EXISTS person_review;
DROP FUNCTION IF EXISTS public.context_ledger_person_review(jsonb, timestamptz);
DROP FUNCTION IF EXISTS public.context_ledger_person_review_ok(jsonb);
