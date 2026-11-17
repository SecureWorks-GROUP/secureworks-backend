-- P4-02.1: job-scoped record evidence only. No writes, trigger or schedule.
CREATE INDEX IF NOT EXISTS context_record_close_email_document ON public.email_events ((metadata ->> 'document_id'));
CREATE OR REPLACE FUNCTION public.context_ledger_record_candidates(
 p_job_id uuid, p_closes_on text, p_about_key text, p_opened_at timestamptz,
 p_from_role text DEFAULT NULL)
RETURNS TABLE(table_name text, record_id text, closes_at timestamptz, key text, label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 WITH records AS (
  -- idx_job_documents_makesafe_attendance_cycle bounds documents by job.
  SELECT 'job_documents'::text AS t, d.id::text AS id, d.sent_at AS at,
   'quote:q-' || regexp_replace(d.quote_number, '[^0-9]', '', 'g') AS k,
   'Quote ' || coalesce(nullif(regexp_replace(d.quote_number, '[^0-9]', '', 'g'), ''), 'without a number') || ' was sent on ' AS words,
   d.id::text AS document_id
  FROM public.job_documents d
  WHERE p_closes_on = 'quote_sent' AND d.job_id = p_job_id AND d.type = 'quote' AND d.sent_at IS NOT NULL
  UNION ALL
  -- idx_xero_invoices_job bounds both receivables and supplier bills.
  SELECT 'xero_invoices', x.id::text,
   CASE WHEN p_closes_on = 'payment' THEN
    -- Store precedence: paid closure is 23:59:59 Perth, capped at now,
    -- not the ticket example's next midnight (context_ledger_paid_close_at).
    public.context_ledger_paid_close_at(least(x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth', now()))
   ELSE coalesce(x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth', x.created_at) END,
   CASE WHEN x.invoice_type = 'ACCPAY' THEN 'bill:' || x.id::text
    ELSE 'invoice:inv-' || regexp_replace(x.invoice_number, '[^0-9]', '', 'g') END,
   CASE WHEN x.invoice_type = 'ACCPAY' THEN 'A supplier bill was paid in full on '
    ELSE 'Invoice ' || coalesce(nullif(regexp_replace(x.invoice_number, '[^0-9]', '', 'g'), ''), 'without a number') ||
     CASE WHEN p_closes_on = 'payment' THEN ' was paid in full on ' ELSE ' was issued on ' END END,
   NULL
  FROM public.xero_invoices x WHERE x.job_id = p_job_id AND (
   (p_closes_on = 'invoice_issued' AND x.invoice_type = 'ACCREC' AND upper(coalesce(x.status,'')) IN ('AUTHORISED','SUBMITTED','PAID'))
   OR (p_closes_on = 'payment' AND x.invoice_type = CASE WHEN p_from_role = 'us' THEN 'ACCPAY' ELSE 'ACCREC' END
    AND upper(coalesce(x.status,'')) = 'PAID' AND x.fully_paid_on IS NOT NULL))
  UNION ALL
  -- job_assignments_job_user_date_key bounds attendance rows by job.
  SELECT 'job_assignments', a.id::text,
   CASE p_closes_on WHEN 'booking_made' THEN a.created_at WHEN 'work_done' THEN a.completed_at
    ELSE coalesce(a.completed_at, a.started_at,
     CASE WHEN lower(coalesce(a.status,'')) IN ('complete','completed') AND a.scheduled_date IS NOT NULL
      THEN least((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth' - interval '1 second', now()) END) END,
   'booking:' || a.scheduled_date::text,
   CASE p_closes_on WHEN 'booking_made' THEN 'A booking for ' || to_char(a.scheduled_date, 'Dy FMDD Mon') || ' was made on '
    WHEN 'work_done' THEN 'The work was recorded finished on ' ELSE 'A visit was done on ' END,
   NULL
  FROM public.job_assignments a WHERE a.job_id = p_job_id
   -- Exact observer/ghost and booking-status conditions from context_ledger_cite.
   AND NOT (coalesce(a.is_ghost,false) OR coalesce(a.role,'') = 'observer')
   AND ((p_closes_on = 'booking_made' AND lower(coalesce(a.status,'')) NOT IN ('cancelled','deleted','draft','disputed','declined'))
    OR p_closes_on = 'visit' OR (p_closes_on = 'work_done' AND a.completed_at IS NOT NULL))
  UNION ALL
  -- job_events_job_created_idx bounds events by job and opening time.
  SELECT 'job_events', e.id::text, e.created_at, 'event:' || e.id::text,
   CASE p_closes_on WHEN 'quote_sent' THEN 'A quote was sent on '
    WHEN 'invoice_issued' THEN 'An invoice was issued on ' WHEN 'payment' THEN 'A payment was recorded on '
    WHEN 'visit' THEN 'A visit was done on ' ELSE 'The work was recorded finished on ' END,
   nullif(btrim(e.detail_json ->> 'document_id'),'')
  FROM public.job_events e WHERE e.job_id = p_job_id AND e.created_at > p_opened_at
   AND p_closes_on IN ('quote_sent','invoice_issued','payment','visit','work_done')
   AND public.context_ledger_job_event_closes(e.event_type,p_closes_on)
 ), timed AS (
  SELECT c.*, CASE WHEN c.document_id IS NOT NULL AND c.at IS NOT NULL AND mail.n > 0
    AND NOT coalesce(d.viewed_at IS NOT NULL OR d.accepted_at IS NOT NULL OR d.declined_at IS NOT NULL,false)
   THEN CASE WHEN mail.sent IS NOT NULL THEN greatest(c.at, mail.sent) END ELSE c.at END AS close_at
  FROM records c
  LEFT JOIN public.job_documents d ON d.id = CASE WHEN c.document_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN c.document_id::uuid END
  LEFT JOIN LATERAL (
   -- context_record_close_email_document bounds this to the document; only its
   -- first successful email counts, exactly as context_ledger_cite requires.
   -- Failed-only sends never close; unrelated/later job emails do not retime it.
   SELECT count(*) AS n, min(ee.sent_at) FILTER (
    WHERE lower(coalesce(ee.status,'')) IN ('sent','delivered','accepted') AND ee.sent_at IS NOT NULL) AS sent
   FROM public.email_events ee WHERE c.document_id IS NOT NULL
    AND ee.metadata ->> 'document_id' = c.document_id
  ) mail ON true
 )
 SELECT t, id, close_at, k, words || to_char(
  -- Payment labels name the paid day, rather than the instant after it.
  close_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon') || '.'
 FROM timed WHERE close_at > p_opened_at
$fn$;
REVOKE ALL ON FUNCTION public.context_ledger_record_candidates(uuid,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_candidates(uuid,text,text,timestamptz,text) TO service_role;
