-- Item 16b contract: the tray's files are asked for once, within the caps, and only the ones Emails to sort shows;
-- the read-back says what the reader made of each file, by its own id or by the same bytes on another email. Every
-- fixture write is rolled back. Fixture words only.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.t_job(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.jobs(id, org_id, status, type, job_number, created_at)
  VALUES (j, '00000000-0000-0000-0000-000000000001', 'scheduled', 'patio', p_number, now() - interval '30 days');
  RETURN j;
END $$;
-- A captured event (an inbound email, on a job or on no job, or a reader's words), as the requests contract makes one.
CREATE FUNCTION pg_temp.t_event(p_key text, p_job uuid, p_at timestamptz, p_payload jsonb) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.business_events(event_type, source, entity_type, entity_id, job_id, match_method, event_at,
    provider_message_id, channel, direction, payload, metadata)
  VALUES ('supplier.email_in', 'outlook-mail-capture', CASE WHEN p_job IS NULL THEN 'email' ELSE 'job' END,
    coalesce(p_job::text, 'x'), p_job, CASE WHEN p_job IS NOT NULL THEN 'direct_job_id' END, p_at,
    'email:<' || p_key || '@tray16b>', 'email', 'inbound', p_payload, '{"capture_mode":"live"}')
  RETURNING id
$$;
-- An email and its tray row.
CREATE FUNCTION pg_temp.t_email(p_key text, p_state text, p_desk boolean, p_job uuid DEFAULT NULL,
  p_at timestamptz DEFAULT now() - interval '1 hour') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE ev uuid := pg_temp.t_event(p_key, p_job, p_at, jsonb_build_object('body', 'Docket attached.'));
BEGIN
  INSERT INTO public.dispatch_v2_supplier_emails(org_id, state, provider_message_id, received_at, order_desk)
  VALUES ('00000000-0000-0000-0000-000000000001', p_state, 'email:<' || p_key || '@tray16b>', p_at, p_desk);
  RETURN ev;
END $$;
CREATE FUNCTION pg_temp.t_att(p_event uuid, p_key text, p_name text, p_type text DEFAULT 'application/pdf',
  p_size bigint DEFAULT 150000, p_sha text DEFAULT NULL, p_status text DEFAULT 'stored') RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.context_email_attachments(provider_message_id, attachment_key, business_event_id, file_name,
    content_type, size_bytes, sha256, storage_bucket, storage_path, status)
  VALUES ('email:<' || p_key || '@tray16b>', md5(p_key) || md5(p_name), p_event, p_name, p_type, p_size,
    CASE WHEN p_status = 'stored' THEN coalesce(p_sha, md5(p_key || p_name) || md5(p_name || p_key)) END,
    CASE WHEN p_status = 'stored' THEN 'context-email-attachments' END,
    CASE WHEN p_status = 'stored' THEN 't/' || p_key || '/' || p_name END, p_status)
  RETURNING id
$$;
CREATE FUNCTION pg_temp.t_requested(p_id uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM public.context_document_text_requests q
                  WHERE q.source_kind = 'email_attachment' AND q.source_id = p_id
                    AND q.requested_by = 'dispatch tray (item 16b)')
$$;

-- 0. Shape: both functions are SECURITY DEFINER with a fixed search_path, and only service_role may run them.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.dispatch_v2_tray_pdf_read_request(integer)', 'public.dispatch_v2_tray_pdf_reads(uuid[])'] LOOP
    IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION '16b: % is missing', f; END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION '16b: % is not SECURITY DEFINER', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(f)
                    AND array_to_string(p.proconfig, ',') LIKE 'search_path=%') THEN
      RAISE EXCEPTION '16b: % has no fixed search_path', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '16b: % is open to anon or authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION '16b: service_role cannot run %', f;
    END IF;
  END LOOP;
END $$;

-- 1. Filing: only the kept PDFs and pictures Emails to sort shows, on no job, once per set of bytes, newest first.
BEGIN;
DO $$
DECLARE
  job uuid := pg_temp.t_job('SWP-9161');
  a_desk uuid; a_guess uuid; a_accounts uuid; a_matched uuid; a_on_job uuid; a_word uuid; a_big uuid;
  a_not_kept uuid; a_twin1 uuid; a_twin2 uuid; a_twin3 uuid; a_read uuid; a_done uuid; e uuid; n integer;
  twin text := repeat('b', 64);
BEGIN
  e := pg_temp.t_email('desk', 'unmatched', true);            a_desk := pg_temp.t_att(e, 'desk', 'docket.pdf');
  e := pg_temp.t_email('guess', 'needs_confirmation', false); a_guess := pg_temp.t_att(e, 'guess', 'photo.jpg', 'image/jpeg');
  e := pg_temp.t_email('accounts', 'unmatched', false);       a_accounts := pg_temp.t_att(e, 'accounts', 'statement.pdf');
  e := pg_temp.t_email('matched', 'matched', true);           a_matched := pg_temp.t_att(e, 'matched', 'conf.pdf');
  e := pg_temp.t_email('onjob', 'unmatched', true, job);      a_on_job := pg_temp.t_att(e, 'onjob', 'onjob.pdf');
  e := pg_temp.t_email('word', 'unmatched', true);            a_word := pg_temp.t_att(e, 'word', 'order.docx', 'application/msword');
  e := pg_temp.t_email('big', 'unmatched', true);             a_big := pg_temp.t_att(e, 'big', 'big.pdf', 'application/pdf', 6000000);
  e := pg_temp.t_email('notkept', 'unmatched', true);         a_not_kept := pg_temp.t_att(e, 'notkept', 'huge.pdf', 'application/pdf', 30000000, NULL, 'skipped_too_large');
  e := pg_temp.t_email('twin1', 'unmatched', true, NULL, now() - interval '3 hours');
  a_twin1 := pg_temp.t_att(e, 'twin1', 'scan.pdf', 'application/pdf', 150000, twin);
  e := pg_temp.t_email('twin2', 'unmatched', true, NULL, now() - interval '2 hours');
  a_twin2 := pg_temp.t_att(e, 'twin2', 'scan.pdf', 'application/pdf', 150000, twin);
  -- Already read once (on no job): not asked for again.
  e := pg_temp.t_email('read', 'unmatched', true);            a_read := pg_temp.t_att(e, 'read', 'read.pdf');
  INSERT INTO public.context_document_texts(source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, attempts, finished_at)
  VALUES ('email_attachment', a_read, NULL, md5('read'), 'pdf', 'no_text_layer', 1, now());
  -- Asked for already by someone else: left as it is.
  e := pg_temp.t_email('done', 'unmatched', true);            a_done := pg_temp.t_att(e, 'done', 'done.pdf');
  INSERT INTO public.context_document_text_requests(source_kind, source_id, requested_by, reason)
  VALUES ('email_attachment', a_done, 'contract', 'fixture request');

  n := public.dispatch_v2_tray_pdf_read_request(10);
  IF n <> 3 THEN RAISE EXCEPTION '16b filing: % filed, want 3 (desk, guess, one twin)', n; END IF;
  IF NOT pg_temp.t_requested(a_desk) THEN RAISE EXCEPTION '16b filing: the order desk PDF was not asked for'; END IF;
  IF NOT pg_temp.t_requested(a_guess) THEN RAISE EXCEPTION '16b filing: the best guess picture was not asked for'; END IF;
  IF pg_temp.t_requested(a_accounts) THEN RAISE EXCEPTION '16b filing: accounts mail (not shown by default) was asked for'; END IF;
  IF pg_temp.t_requested(a_matched) THEN RAISE EXCEPTION '16b filing: a matched email was asked for'; END IF;
  IF pg_temp.t_requested(a_on_job) THEN RAISE EXCEPTION '16b filing: an email on a job was asked for'; END IF;
  IF pg_temp.t_requested(a_word) THEN RAISE EXCEPTION '16b filing: a Word file was asked for'; END IF;
  IF pg_temp.t_requested(a_big) THEN RAISE EXCEPTION '16b filing: a file over 5 MB was asked for'; END IF;
  IF pg_temp.t_requested(a_not_kept) THEN RAISE EXCEPTION '16b filing: a file not kept was asked for'; END IF;
  IF pg_temp.t_requested(a_read) THEN RAISE EXCEPTION '16b filing: a file already read was asked for'; END IF;
  IF pg_temp.t_requested(a_done) THEN RAISE EXCEPTION '16b filing: another request was overwritten'; END IF;
  IF NOT pg_temp.t_requested(a_twin2) OR pg_temp.t_requested(a_twin1) THEN
    RAISE EXCEPTION '16b filing: two emails with the same bytes must ask once, for the newer one';
  END IF;
  IF (SELECT q.reason FROM public.context_document_text_requests q
       WHERE q.source_kind = 'email_attachment' AND q.source_id = a_desk) NOT LIKE '%suggestion only%' THEN
    RAISE EXCEPTION '16b filing: the request does not say it is a suggestion only';
  END IF;
  -- Nothing is ever placed: every tray row keeps its state and stays off any job.
  IF EXISTS (SELECT 1 FROM public.dispatch_v2_supplier_emails s
              WHERE s.provider_message_id LIKE '%@tray16b>' AND s.job_id IS NOT NULL) THEN
    RAISE EXCEPTION '16b filing: an email was placed on a job';
  END IF;
  -- A second run finds nothing new.
  n := public.dispatch_v2_tray_pdf_read_request(10);
  IF n <> 0 THEN RAISE EXCEPTION '16b filing: a second run filed %', n; END IF;
  -- A later email carrying the same bytes as one already asked for is not asked for again.
  e := pg_temp.t_email('twin3', 'unmatched', true, NULL, now());
  a_twin3 := pg_temp.t_att(e, 'twin3', 'scan.pdf', 'application/pdf', 150000, twin);
  n := public.dispatch_v2_tray_pdf_read_request(10);
  IF n <> 0 OR pg_temp.t_requested(a_twin3) THEN
    RAISE EXCEPTION '16b filing: the same bytes were asked for twice (% filed)', n;
  END IF;
END $$;
ROLLBACK;

-- 2. Caps: at most 10 a call, 12 in a rolling hour, nothing for a limit of 0.
BEGIN;
DO $$
DECLARE e uuid; n integer; i integer;
BEGIN
  FOR i IN 1..15 LOOP
    e := pg_temp.t_email('cap' || i, 'unmatched', true, NULL, now() - make_interval(mins => i));
    PERFORM pg_temp.t_att(e, 'cap' || i, 'cap' || i || '.pdf');
  END LOOP;
  n := public.dispatch_v2_tray_pdf_read_request(0);
  IF n <> 0 THEN RAISE EXCEPTION '16b caps: limit 0 filed %', n; END IF;
  n := public.dispatch_v2_tray_pdf_read_request(50);
  IF n <> 10 THEN RAISE EXCEPTION '16b caps: one call filed %, want 10', n; END IF;
  -- Newest first: the newest email is in, the oldest is not.
  IF NOT pg_temp.t_requested((SELECT a.id FROM public.context_email_attachments a WHERE a.file_name = 'cap1.pdf'))
     OR pg_temp.t_requested((SELECT a.id FROM public.context_email_attachments a WHERE a.file_name = 'cap15.pdf')) THEN
    RAISE EXCEPTION '16b caps: not newest first';
  END IF;
  n := public.dispatch_v2_tray_pdf_read_request(50);
  IF n <> 2 THEN RAISE EXCEPTION '16b caps: the hour allowed %, want 2 more (12 an hour)', n; END IF;
  n := public.dispatch_v2_tray_pdf_read_request(50);
  IF n <> 0 THEN RAISE EXCEPTION '16b caps: past 12 an hour, % more were filed', n; END IF;
  -- An hour later there is room again.
  UPDATE public.context_document_text_requests SET requested_at = now() - interval '61 minutes'
   WHERE requested_by = 'dispatch tray (item 16b)';
  n := public.dispatch_v2_tray_pdf_read_request(50);
  IF n <> 3 THEN RAISE EXCEPTION '16b caps: after an hour % filed, want the last 3', n; END IF;
END $$;
ROLLBACK;

-- 3. Read-back: what the reader made of each file.
BEGIN;
DO $$
DECLARE
  job uuid := pg_temp.t_job('SWP-9162');
  e uuid; ev uuid;
  a_text uuid; a_pic uuid; a_blank uuid; a_cannot uuid; a_wait uuid; a_none uuid; a_twin uuid; a_long uuid;
  r record; n integer;
BEGIN
  e := pg_temp.t_email('rb', 'unmatched', true);
  a_text := pg_temp.t_att(e, 'rb', 'text.pdf', 'application/pdf', 150000, repeat('c', 64));
  a_pic := pg_temp.t_att(e, 'rb', 'scan.pdf', 'application/pdf', 150000, repeat('d', 64));
  a_blank := pg_temp.t_att(e, 'rb', 'blank.pdf');
  a_cannot := pg_temp.t_att(e, 'rb', 'fax.pdf');
  a_wait := pg_temp.t_att(e, 'rb', 'wait.pdf');
  a_none := pg_temp.t_att(e, 'rb', 'none.pdf');
  a_long := pg_temp.t_att(e, 'rb', 'long.pdf', 'application/pdf', 150000, repeat('f', 64));
  -- The same scan on a second email.
  a_twin := pg_temp.t_att(pg_temp.t_email('rb2', 'unmatched', true), 'rb2', 'scan.pdf', 'application/pdf', 150000, repeat('d', 64));

  -- A PDF with words in it (B-5).
  ev := pg_temp.t_event('w-text', NULL, now(), jsonb_build_object('text', '[Document text: x] Ref SWP-9162 13 Woodall Ct'));
  INSERT INTO public.context_document_texts(source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, attempts, finished_at, event_id, sha256)
  VALUES ('email_attachment', a_text, NULL, md5('t'), 'pdf', 'saved', 1, now(), ev, repeat('c', 64));
  -- A scan the picture reader read (B-5b).
  ev := pg_temp.t_event('w-pic', NULL, now(), jsonb_build_object('text', 'DELIVER TO 1 DRIFT LANE'));
  INSERT INTO public.context_document_texts(source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, attempts, finished_at)
  VALUES ('email_attachment', a_pic, NULL, md5('p'), 'pdf', 'no_text_layer', 1, now());
  INSERT INTO public.context_document_vision_reads(source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, attempts, finished_at, event_id, sha256)
  VALUES ('email_attachment', a_pic, NULL, md5('p'), 'pdf', 'saved', 1, now(), ev, repeat('d', 64));
  -- Read with nothing legible, and a file the reader does not take.
  INSERT INTO public.context_document_vision_reads(source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, attempts, finished_at)
  VALUES ('email_attachment', a_blank, NULL, md5('b'), 'pdf', 'no_text', 1, now()),
         ('email_attachment', a_cannot, NULL, md5('c'), 'pdf', 'not_supported', 1, now());
  INSERT INTO public.context_document_text_requests(source_kind, source_id, requested_by, reason)
  VALUES ('email_attachment', a_wait, 'dispatch tray (item 16b)', 'fixture request'),
         ('email_attachment', a_blank, 'dispatch tray (item 16b)', 'fixture request');
  -- Long words, read on a job: cut to 8,000 characters.
  ev := pg_temp.t_event('w-long', NULL, now(), jsonb_build_object('text', repeat('W', 9000)));
  INSERT INTO public.context_document_texts(source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, attempts, finished_at, event_id, sha256)
  VALUES ('email_attachment', a_long, job, md5('l'), 'pdf', 'saved', 1, now(), ev, repeat('f', 64));

  SELECT count(*) INTO n FROM public.dispatch_v2_tray_pdf_reads(ARRAY[a_text, a_pic, a_blank, a_cannot, a_wait, a_none, a_twin, a_long, gen_random_uuid()]);
  IF n <> 8 THEN RAISE EXCEPTION '16b reads: % rows, want 8 (an unknown id gives none)', n; END IF;
  FOR r IN SELECT * FROM public.dispatch_v2_tray_pdf_reads(ARRAY[a_text, a_pic, a_blank, a_cannot, a_wait, a_none, a_twin, a_long]) LOOP
    IF r.attachment_id = a_text AND ((r.read_state, r.method) IS DISTINCT FROM ('read'::text, 'text'::text) OR r.words NOT LIKE '%SWP-9162%') THEN
      RAISE EXCEPTION '16b reads: the PDF with words is %/% (%)', r.read_state, r.method, r.words;
    END IF;
    IF r.attachment_id = a_pic AND (r.read_state, r.method, r.words) IS DISTINCT FROM ('read'::text, 'picture'::text, 'DELIVER TO 1 DRIFT LANE'::text) THEN
      RAISE EXCEPTION '16b reads: the scan is %/%', r.read_state, r.method;
    END IF;
    IF r.attachment_id = a_blank AND r.read_state <> 'no_words' THEN
      RAISE EXCEPTION '16b reads: a read with no words is % (a finished read beats its request)', r.read_state;
    END IF;
    IF r.attachment_id = a_cannot AND r.read_state <> 'cannot_read' THEN RAISE EXCEPTION '16b reads: an unreadable file is %', r.read_state; END IF;
    IF r.attachment_id = a_wait AND r.read_state <> 'waiting' THEN RAISE EXCEPTION '16b reads: a requested file is %', r.read_state; END IF;
    IF r.attachment_id = a_none AND r.read_state <> 'not_read' THEN RAISE EXCEPTION '16b reads: an untouched file is %', r.read_state; END IF;
    IF r.attachment_id = a_twin AND (r.read_state, r.words) IS DISTINCT FROM ('read'::text, 'DELIVER TO 1 DRIFT LANE'::text) THEN
      RAISE EXCEPTION '16b reads: the same scan on another email was not found by its bytes (%)', r.read_state;
    END IF;
    IF r.attachment_id = a_long AND length(r.words) <> 8000 THEN
      RAISE EXCEPTION '16b reads: words not cut to 8,000 characters (%)', length(r.words);
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM public.dispatch_v2_tray_pdf_reads(NULL);
  IF n <> 0 THEN RAISE EXCEPTION '16b reads: a NULL list gave % rows', n; END IF;
END $$;
ROLLBACK;
