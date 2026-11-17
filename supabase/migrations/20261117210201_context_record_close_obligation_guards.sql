-- FU19: narrow record proof before context_record_close_v1 is enabled.
-- No switch, trigger, schedule, existing revision or money record is changed.
SET lock_timeout = '2s';
SET statement_timeout = '30s';
-- Customer money must name its invoice: a sole deposit never proves a generic
-- final invoice or balance. Supplier payment needs both roles, never just us.
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
   (p_closes_on = 'invoice_issued' AND p_about_key = 'invoice:inv-' || regexp_replace(x.invoice_number, '[^0-9]', '', 'g') AND x.invoice_type = 'ACCREC' AND upper(coalesce(x.status,'')) IN ('AUTHORISED','SUBMITTED','PAID'))
   OR (p_closes_on = 'payment' AND (
     (p_from_role = 'customer' AND x.invoice_type = 'ACCREC'
      AND p_about_key = 'invoice:inv-' || regexp_replace(x.invoice_number, '[^0-9]', '', 'g'))
     OR (p_from_role = 'us' AND p_to_role = 'supplier' AND x.invoice_type = 'ACCPAY'))
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

-- Preserve the published five-argument read. Its missing payee stays unknown,
-- so it cannot close a supplier obligation. The close action supplies both roles.
CREATE OR REPLACE FUNCTION public.context_ledger_record_candidates(
 p_job_id uuid, p_closes_on text, p_about_key text, p_opened_at timestamptz,
 p_from_role text DEFAULT NULL)
RETURNS TABLE(table_name text, record_id text, closes_at timestamptz, key text, label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT * FROM public.context_ledger_record_candidates(p_job_id,p_closes_on,p_about_key,p_opened_at,p_from_role,NULL)
$fn$;
REVOKE ALL ON FUNCTION public.context_ledger_record_candidates(uuid,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_candidates(uuid,text,text,timestamptz,text) TO service_role;

CREATE OR REPLACE FUNCTION public.context_ledger_close_on_records(p_job_id uuid, p_dry_run boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_write boolean; i public.context_ledger_items; g uuid; c record; v_candidates jsonb;
 v_chosen jsonb; v_evidence jsonb; v_would integer := 0; v_closed integer := 0;
 v_ambiguous integer := 0; v_items jsonb := '[]';
/* close block */ BEGIN
 v_write := NOT coalesce(p_dry_run, NOT coalesce((SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_record_close_v1'), false));
 -- The generation lock matches person_edit and serializes promotion and close.
 -- context_ledger_generations_one_live; items use context_ledger_items_generation.
 SELECT id INTO g FROM public.context_ledger_generations WHERE job_id=p_job_id AND status='live' FOR UPDATE;
 FOR i IN SELECT li.* FROM public.context_ledger_items li WHERE li.generation_id=g AND li.job_id=p_job_id
  AND li.status='open' AND NOT li.person_locked AND NOT coalesce(li.job_not_certain,false)
  AND li.written_by NOT LIKE 'person:%' AND li.closes_on IN ('quote_sent','invoice_issued','payment','booking_made','visit','work_done')
  ORDER BY li.id FOR UPDATE
 LOOP
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.closes_at,x.table_name COLLATE "C",x.record_id COLLATE "C"),'[]')
   INTO v_candidates FROM public.context_ledger_record_candidates(p_job_id,i.closes_on,i.about_key,i.opened_at,i.from_role,i.to_role) x;
  v_chosen := NULL;
  IF i.about_key ~ '^(invoice:inv-|quote:q-|booking:)' THEN
   SELECT value INTO v_chosen FROM jsonb_array_elements(v_candidates) WHERE value->>'key'=i.about_key LIMIT 1;
  ELSIF jsonb_array_length(v_candidates)=1 THEN v_chosen := v_candidates->0;
  END IF;
  IF v_chosen IS NULL THEN
   IF jsonb_array_length(v_candidates)>1 THEN
    v_ambiguous := v_ambiguous+1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id',i.id,'item_key',i.item_key,
     'candidates',(SELECT jsonb_agg(jsonb_build_object('table_name',value->>'table_name','record_id',value->>'record_id','label',value->>'label'))
      FROM jsonb_array_elements(v_candidates))));
   END IF;
   CONTINUE;
  END IF;
  v_would := v_would+1;
  IF v_write THEN
   v_evidence := jsonb_build_array(jsonb_build_object('table',v_chosen->>'table_name','id',v_chosen->>'record_id'));
   UPDATE public.context_ledger_items SET status='closed',closed_at=(v_chosen->>'closes_at')::timestamptz,
    closed_by=v_evidence,updated_at=now() WHERE id=i.id;
   INSERT INTO public.context_ledger_transitions(item_id,generation_id,job_id,from_status,to_status,by,evidence,reason)
   VALUES(i.id,i.generation_id,p_job_id,'open','closed','rule:record_close_v1',v_evidence,v_chosen->>'label');
   v_closed := v_closed+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('job_id',p_job_id,'wrote',v_write,'would_close',v_would,'closed',v_closed,
  'ambiguous',v_ambiguous,'ambiguous_items',v_items);
END $fn$;


RESET lock_timeout;
RESET statement_timeout;
