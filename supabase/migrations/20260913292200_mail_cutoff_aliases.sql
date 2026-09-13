-- Viewer contract names from Operations: capture_cutoff ≠ assessment_cutoff;
-- coverage.complete false on failed/partial capture.

CREATE OR REPLACE FUNCTION public.list_job_communications(
  p_org_id uuid, p_job_id uuid, p_po_id uuid, p_invoice_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE items jsonb; fresh public.workflow_source_freshness; sent_ok boolean;
  all_complete boolean;
BEGIN
  IF p_org_id IS NULL OR p_job_id IS NULL THEN RAISE EXCEPTION 'message_link_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND j.org_id=p_org_id)
  THEN RAISE EXCEPTION 'message_link_org_mismatch'; END IF;
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.occurred),'[]'::jsonb) INTO items
  FROM (
    SELECT jsonb_build_object(
      'event_id', o.event_id,
      'occurrence_id', o.id,
      'direction', o.direction,
      'capture_status', o.capture_status,
      'complete', (o.capture_status='captured'),
      'mailbox', o.mailbox,
      'folder', o.folder,
      'identity', o.identity,
      'captured_at', o.captured_at,
      'subject', e.payload->>'subject',
      'from', e.payload->>'from',
      'internet_message_id', e.payload->>'internet_message_id',
      'links', coalesce((
        SELECT jsonb_agg(jsonb_build_object('kind',w.kind,'target_id',w.target_id,'certainty',w.certainty)
                         ORDER BY w.kind)
          FROM public.message_work_links w
         WHERE w.event_id=o.event_id AND w.org_id=p_org_id AND w.lifecycle='current'
      ),'[]'::jsonb)
    ) AS item,
    o.captured_at AS occurred
    FROM public.context_mail_occurrences o
    JOIN public.business_events e ON e.id=o.event_id
    WHERE o.org_id=p_org_id
      AND EXISTS (
        SELECT 1 FROM public.message_work_links w
         WHERE w.event_id=o.event_id AND w.org_id=p_org_id AND w.kind='job'
           AND w.target_id=p_job_id::text AND w.lifecycle='current'
      )
      AND (p_po_id IS NULL OR EXISTS (
        SELECT 1 FROM public.message_work_links w
         WHERE w.event_id=o.event_id AND w.org_id=p_org_id AND w.kind='po'
           AND w.target_id=p_po_id::text AND w.lifecycle='current'
      ))
      AND (p_invoice_id IS NULL OR EXISTS (
        SELECT 1 FROM public.message_work_links w
         WHERE w.event_id=o.event_id AND w.org_id=p_org_id AND w.kind='invoice'
           AND w.target_id=p_invoice_id AND w.lifecycle='current'
      ))
  ) x;
  SELECT * INTO fresh FROM public.workflow_source_freshness
   WHERE org_id=p_org_id AND job_id=p_job_id;
  sent_ok := EXISTS (
    SELECT 1 FROM public.context_mail_occurrences o
    JOIN public.message_work_links w ON w.event_id=o.event_id
     WHERE o.org_id=p_org_id AND w.kind='job' AND w.target_id=p_job_id::text
       AND w.lifecycle='current' AND lower(o.folder)='sent'
  );
  all_complete := NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(items,'[]'::jsonb)) m
     WHERE (m->>'complete') IS DISTINCT FROM 'true'
  );
  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'job_id', p_job_id,
    'po_id', p_po_id,
    'messages', coalesce(items,'[]'::jsonb),
    'last_capture_at', fresh.last_capture_at,
    'last_assess_at', fresh.last_assess_at,
    'capture_cutoff', fresh.last_capture_at,
    'assessment_cutoff', fresh.last_assess_at,
    'proposal_requires_reassessment', coalesce(fresh.proposal_requires_reassessment,false),
    'last_capture_status', fresh.last_capture_status,
    'sent_history_captured', sent_ok,
    'inbox_only_boundary', NOT sent_ok,
    'coverage', jsonb_build_object(
      'complete', coalesce(all_complete, true) AND coalesce(fresh.last_capture_status,'captured')='captured',
      'sent_history_captured', sent_ok
    )
  );
END $$;
