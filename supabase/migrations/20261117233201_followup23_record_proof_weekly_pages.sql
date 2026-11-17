-- FU23: exact issued invoice/bill proof and weekly stored-page reuse.
-- Definitions only: no flags, schedules, triggers, business rows or Xero writes.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $guard$
/* pre-image check */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text)'::regprocedure) NOT IN ('d1aa2f0d9e64903a2f28aa9c90f5dabf','6e716f6a5b0805f965dfaa5175b543cb') THEN
  RAISE EXCEPTION 'FU23 pre-image drift: public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text)';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_truth_weekly_draw(date,integer)'::regprocedure) NOT IN ('0d7898a6f17e0f3ec5736e0a37d713a0','dcdb8819c3c2e2b9e8db2490915c87ee') THEN
  RAISE EXCEPTION 'FU23 pre-image drift: public.job_truth_weekly_draw(date,integer)';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.context_ledger_record_candidates(
 p_job_id uuid, p_closes_on text, p_about_key text, p_opened_at timestamptz,
 p_from_role text, p_to_role text)
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
   (p_closes_on = 'invoice_issued' AND p_about_key = 'invoice:inv-' || regexp_replace(x.invoice_number, '[^0-9]', '', 'g') AND x.invoice_type = 'ACCREC' AND upper(coalesce(x.status,'')) IN ('AUTHORISED','PAID'))
   OR (p_closes_on = 'payment' AND (
     (p_from_role = 'customer' AND x.invoice_type = 'ACCREC'
      AND p_about_key = 'invoice:inv-' || regexp_replace(x.invoice_number, '[^0-9]', '', 'g'))
     OR (p_from_role = 'us' AND p_to_role = 'supplier' AND x.invoice_type = 'ACCPAY'
      -- A role is not a supplier identity. Only the exact bill can settle it.
      AND p_about_key = 'bill:' || x.id::text))
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
    OR (p_closes_on IN ('visit','work_done')
     AND lower(coalesce(a.status,'')) NOT IN ('cancelled','deleted','draft','disputed','declined','not_accepted')
     AND (p_closes_on = 'visit' OR a.completed_at IS NOT NULL)))
  UNION ALL
  -- job_events_job_created_idx bounds events by job and opening time.
  SELECT 'job_events', e.id::text, e.created_at, 'event:' || e.id::text,
   CASE p_closes_on WHEN 'quote_sent' THEN 'A quote was sent on '
    WHEN 'invoice_issued' THEN 'An invoice was issued on ' WHEN 'payment' THEN 'A payment was recorded on '
    WHEN 'visit' THEN 'A visit was done on ' ELSE 'The work was recorded finished on ' END,
   nullif(btrim(e.detail_json ->> 'document_id'),'')
  FROM public.job_events e WHERE e.job_id = p_job_id AND e.created_at > p_opened_at
   -- Unnumbered invoice/payment events cannot prove which obligation was met,
   -- nor its payer/payee. Clock events alone cannot disprove cancellation.
   AND (p_closes_on = 'quote_sent' OR (p_closes_on IN ('visit','work_done')
    AND e.event_type IN ('makesafe_report_submitted','roof_report_submitted')))
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
REVOKE ALL ON FUNCTION public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.job_truth_weekly_draw(p_week date DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_week date := coalesce(p_week,date_trunc('week',now() AT TIME ZONE 'Australia/Perth')::date);
 v_job uuid; v_page jsonb; v_story jsonb; v_notes jsonb; v_refresh jsonb;
 v_stored_on boolean := false;
 v_ids jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb; v_result jsonb; BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 5 AND 20 THEN RAISE EXCEPTION 'weekly_draw_bad_limit'; END IF;
 -- Missing/unreadable switch retains main's refresh-every-page path.
 /* switch read */ BEGIN
  v_stored_on := coalesce((SELECT enabled FROM public.feature_flags WHERE flag_name='job_page_stored_read_v1'),false);
 EXCEPTION WHEN OTHERS THEN v_stored_on := false; END;
 -- Serialise only draws for this week. No business writer uses this lock.
 PERFORM pg_advisory_xact_lock(173701,v_week - DATE '2000-01-01');
 IF EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE week=v_week) THEN
   RETURN jsonb_build_object('outcome','already_drawn','week',v_week);
 END IF;
 -- Keep-ready ids join jobs_pkey and job_pages_pkey. job_change_marks is a view:
 -- its per-job reads use jobs_pkey, job_change_marks_pkey (renamed base table),
 -- and job_change_mark_events_job. No new population read is added.
 -- Random order scans the eligible set once, only on the explicit weekly draw.
 FOR v_job IN
   SELECT j.id FROM public.job_pages_keep_ready_set() AS k(id)
   JOIN public.jobs j ON j.id=k.id
   JOIN public.job_pages p ON p.job_id=j.id AND p.status='ready'
   JOIN public.job_change_marks m ON m.job_id=j.id
   WHERE m.last_marked_at >= now() - interval '28 days' AND j.job_number NOT LIKE 'ZZTEST%'
   ORDER BY random() LIMIT p_limit
 LOOP
   -- At most p_limit attempts, even if some jobs cannot be sampled. Never keep
   -- an old ready page after a busy, changed, missing or failed refresh.
   /* per-job isolation */ BEGIN
   v_page := NULL;
   IF v_stored_on THEN
     -- job_pages_pkey and the per-job marks view (jobs_pkey,
     -- job_change_marks_pkey (renamed base table), job_change_mark_events_job). Version plus
     -- folded/live event count catches a late low-sequence commit, not just time.
     SELECT p.page INTO v_page FROM public.job_pages p
     JOIN public.job_change_marks m ON m.job_id=p.job_id
     WHERE p.job_id=v_job AND p.status='ready'
      AND p.page_version=public.job_page_version()
      AND p.covers_mark_version=m.mark_version
      AND p.covers_marked_at>=m.last_marked_at;
   END IF;
   IF v_page IS NULL THEN
     v_refresh := public.job_page_refresh(v_job);
     IF v_refresh ->> 'outcome' IS DISTINCT FROM 'built' THEN
       v_skipped := v_skipped || jsonb_build_array(v_job);
       CONTINUE;
     END IF;
     SELECT page INTO v_page FROM public.job_pages WHERE job_id=v_job AND status='ready';
     IF NOT FOUND THEN
       v_skipped := v_skipped || jsonb_build_array(v_job);
       CONTINUE;
     END IF;
   END IF;
   v_story := public.job_truth_story_sentences(v_page #> '{story_text,text,sections}');
   -- context_ledger_generations_one_live is unique for this job and status.
   v_notes := public.job_truth_notes_of((SELECT id FROM public.context_ledger_generations
     WHERE job_id=v_job AND status='live'));
   INSERT INTO public.job_truth_weekly_samples(week,job_id,page,story,notes,story_total,notes_total)
   VALUES(v_week,v_job,v_page,v_story,v_notes,jsonb_array_length(v_story),jsonb_array_length(v_notes));
   EXCEPTION WHEN OTHERS OR query_canceled THEN
     -- Roll back only this job's refresh/snapshot. Keep earlier samples and
     -- continue the bounded draw; exception text can contain private content.
     v_skipped := v_skipped || jsonb_build_array(v_job);
     CONTINUE;
   END;
   v_ids := v_ids || jsonb_build_array(v_job);
 END LOOP;
 v_result := jsonb_build_object('outcome','drawn','week',v_week,'jobs',jsonb_array_length(v_ids),'job_ids',v_ids);
 -- Preserve the healthy response exactly. A short draw reports its true count
 -- and the skipped ids; no failed row enters the scoring denominator.
 IF jsonb_array_length(v_skipped)>0 THEN
   v_result := v_result || jsonb_build_object('skipped',jsonb_array_length(v_skipped),'skipped_job_ids',v_skipped);
 END IF;
 RETURN v_result;
END $fn$;
