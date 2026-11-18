-- Dispatch v2 item 16b (Shaun, 18 Nov 2026): read the scanned PDFs on the
-- emails in the tray, so the tray can suggest the job they are for.
--
-- In business words:
--   * A supplier often answers with a scanned PDF (a delivery docket, an
--     order confirmation) that has no words in it a computer can copy. The
--     tray could not use it to suggest a job.
--   * Now each kept PDF or picture on an email in the tray as Emails to sort
--     shows it (an order desk's unmatched email, or a best guess; never the
--     accounts or marketing mail behind "show other") is asked to be read, once, by the document
--     reader the business already runs (gap plan B-5: the words of a PDF; B-5b:
--     a scan read by the subscription picture reader, at most 5 pages). No new
--     service, key or paid call: the reads come out of the reader's own daily
--     limit (context_document_vision_policy).
--   * The tray then shows what was printed on it (a job number, an address, a
--     name) and puts the most likely job first under "Could be". It is a
--     suggestion only: nothing here puts an email on a job.
--
-- What this migration adds (no table, no row changes, no backfill):
--   1. dispatch_v2_tray_pdf_read_request(limit): files a read request
--      (context_document_text_requests, requested_by 'dispatch tray (item 16b)')
--      for up to `limit` tray files not yet asked for or read, newest email
--      first. At most 12 an hour in total (rolling hour) and 10 a call. Only
--      kept files (status stored), PDF, JPEG or PNG, 1 byte to 5 MB, on an email
--      that is on no job (an email on a job is read by the normal job reader).
--      A file whose bytes (SHA-256) were already asked for under another
--      attachment is not asked for again. The reply scan calls it once a run
--      (every 5 minutes). This is the reviewed script that files these
--      requests: the reply scan can only start it, never choose what it files.
--   2. dispatch_v2_tray_pdf_reads(attachment ids): for each attachment, what
--      the reader has made of it, read only: read (with the words, first 8,000
--      characters), no_words, cannot_read, waiting or not_read. A file is
--      looked up by its own id, then by another kept attachment with the same
--      bytes, so the same file is never read twice.
--
-- Rules and caller: supabase/functions/ops-api/dispatch_v2_tray_pdf_read.ts,
-- dispatch_v2_replies.ts (scan) and index.ts (tray read). Contract:
-- docs/dispatch-v2-board-contract.md section 3j.
--
-- Rollback: supabase/rollbacks/20261118160000_dispatch_v2_tray_pdf_read_down.sql.

-- 1. File read requests for the tray's files.
CREATE OR REPLACE FUNCTION public.dispatch_v2_tray_pdf_read_request(p_limit integer DEFAULT 4)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  per_hour constant integer := 12;
  per_call constant integer := 10;
  used integer;
  room integer;
  filed integer;
BEGIN
  -- Only one filing at a time, so two scans cannot both pass the hourly cap.
  PERFORM pg_advisory_xact_lock(hashtext('dispatch_v2_tray_pdf_read_request'));
  SELECT count(*) INTO used
    FROM public.context_document_text_requests q
   WHERE q.requested_by = 'dispatch tray (item 16b)'
     AND q.requested_at > now() - interval '1 hour';
  room := least(greatest(coalesce(p_limit, 4), 0), per_call, per_hour - used);
  IF room <= 0 THEN
    RETURN 0;
  END IF;

  WITH files AS (
    SELECT a.id, lower(a.sha256) AS sha, s.received_at
      FROM public.dispatch_v2_supplier_emails s
      JOIN public.context_email_attachments a ON a.provider_message_id = s.provider_message_id
      JOIN public.business_events e ON e.id = a.business_event_id
     WHERE s.state IN ('unmatched', 'needs_confirmation')
       -- What Emails to sort shows by default: an order desk's email, or a
       -- best guess. Accounts and marketing mail is never read.
       AND (s.order_desk OR s.state = 'needs_confirmation')
       AND a.status = 'stored'
       AND a.storage_path IS NOT NULL
       AND (lower(coalesce(a.content_type, '')) IN ('application/pdf', 'image/jpeg', 'image/jpg', 'image/png')
            OR lower(coalesce(a.file_name, '')) ~ '\.(pdf|jpe?g|png)$')
       AND coalesce(a.size_bytes, 0) BETWEEN 1 AND 5000000
       AND e.job_id IS NULL
       -- Not asked for already, and not read already, under this id ...
       AND NOT EXISTS (SELECT 1 FROM public.context_document_text_requests q
                        WHERE q.source_kind = 'email_attachment' AND q.source_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM public.context_document_texts t
                        WHERE t.source_kind = 'email_attachment' AND t.source_id = a.id)
       -- ... or under another attachment with the same bytes.
       AND NOT EXISTS (SELECT 1 FROM public.context_email_attachments o
                        JOIN public.context_document_text_requests q
                          ON q.source_kind = 'email_attachment' AND q.source_id = o.id
                        WHERE a.sha256 IS NOT NULL AND lower(o.sha256) = lower(a.sha256) AND o.id <> a.id)
       AND NOT EXISTS (SELECT 1 FROM public.context_email_attachments o
                        JOIN public.context_document_texts t
                          ON t.source_kind = 'email_attachment' AND t.source_id = o.id
                        WHERE a.sha256 IS NOT NULL AND lower(o.sha256) = lower(a.sha256) AND o.id <> a.id)
  ),
  -- One attachment per set of bytes (two emails carrying the same file).
  one_each AS (
    SELECT DISTINCT ON (coalesce(f.sha, f.id::text)) f.id, f.received_at
      FROM files f
     ORDER BY coalesce(f.sha, f.id::text), f.received_at DESC NULLS LAST, f.id
  ),
  pick AS (
    SELECT o.id FROM one_each o
     ORDER BY o.received_at DESC NULLS LAST, o.id
     LIMIT room
  )
  INSERT INTO public.context_document_text_requests (source_kind, source_id, requested_by, reason)
  SELECT 'email_attachment', p.id, 'dispatch tray (item 16b)',
         'A file on an email in the Dispatch tray: read it so the tray can suggest a job (a suggestion only, never placed).'
    FROM pick p
  ON CONFLICT (source_kind, source_id) DO NOTHING;
  GET DIAGNOSTICS filed = ROW_COUNT;
  RETURN filed;
END
$$;

COMMENT ON FUNCTION public.dispatch_v2_tray_pdf_read_request(integer) IS
  'Dispatch v2 item 16b (20261118160000): files document read requests (context_document_text_requests, requested_by ''dispatch tray (item 16b)'') for kept PDF/JPEG/PNG files of 1 byte to 5 MB on tray emails as Emails to sort shows them (an order desk''s unmatched email, or needs_confirmation) that are on no job, not yet asked for or read under their own id or under another attachment with the same SHA-256. Newest email first, at most p_limit (cap 10) a call and 12 in any rolling hour. Returns how many were filed. Never places an email, never changes a job.';

REVOKE ALL ON FUNCTION public.dispatch_v2_tray_pdf_read_request(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_v2_tray_pdf_read_request(integer) TO service_role;

-- 2. What the reader made of each tray file.
CREATE OR REPLACE FUNCTION public.dispatch_v2_tray_pdf_reads(p_attachment_ids uuid[])
RETURNS TABLE (attachment_id uuid, read_state text, method text, words text, read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH ask AS (
    SELECT DISTINCT x AS id
      FROM unnest(coalesce(p_attachment_ids, '{}'::uuid[])) AS x
     WHERE x IS NOT NULL
     LIMIT 2000
  ),
  att AS (
    SELECT a.id, lower(a.sha256) AS sha
      FROM ask JOIN public.context_email_attachments a ON a.id = ask.id
  ),
  -- The attachment itself, then any other attachment with the same bytes.
  src AS (
    SELECT att.id AS attachment_id, o.id AS source_id
      FROM att
      JOIN public.context_email_attachments o
        ON o.id = att.id OR (att.sha IS NOT NULL AND lower(o.sha256) = att.sha)
  ),
  outcomes AS (
    -- Words from the PDF's own text layer.
    SELECT s.attachment_id, 1 AS rank_, 'read'::text AS read_state, 'text'::text AS method,
           left(nullif(btrim(b.payload->>'text'), ''), 8000) AS words, t.finished_at AS read_at
      FROM src s
      JOIN public.context_document_texts t
        ON t.source_kind = 'email_attachment' AND t.source_id = s.source_id AND t.outcome = 'saved'
      JOIN public.business_events b ON b.id = t.event_id
     WHERE nullif(btrim(b.payload->>'text'), '') IS NOT NULL
    UNION ALL
    -- Words the picture reader read off the scan.
    SELECT s.attachment_id, 1, 'read', 'picture',
           left(nullif(btrim(b.payload->>'text'), ''), 8000), v.finished_at
      FROM src s
      JOIN public.context_document_vision_reads v
        ON v.source_kind = 'email_attachment' AND v.source_id = s.source_id AND v.outcome = 'saved'
      JOIN public.business_events b ON b.id = v.event_id
     WHERE nullif(btrim(b.payload->>'text'), '') IS NOT NULL
    UNION ALL
    -- Read, and nothing legible on it.
    SELECT s.attachment_id, 2, 'no_words', 'picture', NULL, v.finished_at
      FROM src s
      JOIN public.context_document_vision_reads v
        ON v.source_kind = 'email_attachment' AND v.source_id = s.source_id
       AND v.outcome IN ('no_text', 'low_confidence')
    UNION ALL
    -- The reader cannot read this file (a format it does not take, too big, too many pages).
    SELECT s.attachment_id, 3, 'cannot_read', 'picture', NULL, v.finished_at
      FROM src s
      JOIN public.context_document_vision_reads v
        ON v.source_kind = 'email_attachment' AND v.source_id = s.source_id
       AND v.outcome IN ('not_supported', 'too_large', 'no_file', 'failed')
    UNION ALL
    SELECT s.attachment_id, 3, 'cannot_read', 'text', NULL, t.finished_at
      FROM src s
      JOIN public.context_document_texts t
        ON t.source_kind = 'email_attachment' AND t.source_id = s.source_id
       AND t.outcome IN ('too_large', 'too_many_pages', 'not_supported', 'no_file', 'unreadable', 'failed')
    UNION ALL
    -- Asked for, not read yet (a scan waits for the picture reader).
    SELECT s.attachment_id, 4, 'waiting', NULL, NULL, NULL
      FROM src s
      JOIN public.context_document_text_requests q
        ON q.source_kind = 'email_attachment' AND q.source_id = s.source_id
  )
  SELECT att.id,
         coalesce(best.read_state, 'not_read'),
         best.method,
         best.words,
         best.read_at
    FROM att
    LEFT JOIN LATERAL (
      SELECT o.read_state, o.method, o.words, o.read_at
        FROM outcomes o
       WHERE o.attachment_id = att.id
       ORDER BY o.rank_, o.read_at DESC NULLS LAST
       LIMIT 1
    ) best ON true
$$;

COMMENT ON FUNCTION public.dispatch_v2_tray_pdf_reads(uuid[]) IS
  'Dispatch v2 item 16b (20261118160000): for each email attachment id, what the document reader made of it, read only: read (method text or picture, words = the first 8,000 characters), no_words, cannot_read, waiting (asked for, not read yet) or not_read. Looks up the attachment, then any other attachment with the same SHA-256. At most 2,000 ids a call.';

REVOKE ALL ON FUNCTION public.dispatch_v2_tray_pdf_reads(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_v2_tray_pdf_reads(uuid[]) TO service_role;
