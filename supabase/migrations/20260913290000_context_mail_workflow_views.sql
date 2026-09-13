-- Email workflow source contract (EMAIL-INTEGRATION.md).
-- Job-wide vs selected-PO views, capture vs assessment freshness,
-- failed capture cannot read as complete. Uses existing job_documents FKs.

ALTER TABLE public.context_mail_occurrences
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS capture_status text,
  ADD COLUMN IF NOT EXISTS capture_error text;

UPDATE public.context_mail_occurrences
   SET direction = CASE WHEN lower(folder)='sent' THEN 'outbound' ELSE 'inbound' END
 WHERE direction IS NULL;
UPDATE public.context_mail_occurrences
   SET capture_status = 'captured'
 WHERE capture_status IS NULL;

ALTER TABLE public.context_mail_occurrences
  ALTER COLUMN direction SET DEFAULT 'inbound',
  ALTER COLUMN capture_status SET DEFAULT 'captured';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.context_mail_occurrences'::regclass
       AND conname='context_mail_occurrences_direction_check'
  ) THEN
    ALTER TABLE public.context_mail_occurrences
      ADD CONSTRAINT context_mail_occurrences_direction_check
      CHECK (direction IN ('inbound','outbound'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.context_mail_occurrences'::regclass
       AND conname='context_mail_occurrences_capture_status_check'
  ) THEN
    ALTER TABLE public.context_mail_occurrences
      ADD CONSTRAINT context_mail_occurrences_capture_status_check
      CHECK (capture_status IN ('captured','partial','failed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.workflow_source_freshness (
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  last_capture_at timestamptz,
  last_assess_at timestamptz,
  last_capture_status text NOT NULL DEFAULT 'captured'
    CHECK (last_capture_status IN ('captured','partial','failed')),
  proposal_requires_reassessment boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, job_id)
);
ALTER TABLE public.workflow_source_freshness ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_source_freshness FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.workflow_source_freshness TO service_role;

CREATE OR REPLACE FUNCTION public.bump_job_mail_capture(p_org_id uuid, p_job_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org_id IS NULL OR p_job_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.workflow_source_freshness(org_id,job_id,last_capture_at,last_capture_status,proposal_requires_reassessment)
  VALUES (p_org_id,p_job_id,now(),coalesce(p_status,'captured'), true)
  ON CONFLICT (org_id,job_id) DO UPDATE
    SET last_capture_at=now(),
        last_capture_status=EXCLUDED.last_capture_status,
        proposal_requires_reassessment=true,
        updated_at=now();
END $$;

CREATE OR REPLACE FUNCTION public.mark_mail_capture_status(
  p_org_id uuid, p_event_id uuid, p_status text, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job_id uuid;
BEGIN
  IF p_status NOT IN ('captured','partial','failed') THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
  IF NOT public.message_event_in_org(p_org_id, p_event_id)
  THEN RAISE EXCEPTION 'message_link_org_mismatch'; END IF;
  UPDATE public.context_mail_occurrences
     SET capture_status=p_status, capture_error=p_error
   WHERE event_id=p_event_id AND org_id=p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
  FOR job_id IN
    SELECT w.target_id::uuid FROM public.message_work_links w
     WHERE w.event_id=p_event_id AND w.org_id=p_org_id AND w.kind='job' AND w.lifecycle='current'
  LOOP
    PERFORM public.bump_job_mail_capture(p_org_id, job_id, p_status);
  END LOOP;
  RETURN jsonb_build_object('ok', p_status='captured', 'capture_status', p_status, 'event_id', p_event_id);
END $$;

CREATE OR REPLACE FUNCTION public.list_job_communications(
  p_org_id uuid, p_job_id uuid, p_po_id uuid, p_invoice_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE items jsonb; fresh public.workflow_source_freshness; sent_ok boolean;
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
  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'job_id', p_job_id,
    'po_id', p_po_id,
    'messages', coalesce(items,'[]'::jsonb),
    'last_capture_at', fresh.last_capture_at,
    'last_assess_at', fresh.last_assess_at,
    'proposal_requires_reassessment', coalesce(fresh.proposal_requires_reassessment,false),
    'last_capture_status', fresh.last_capture_status,
    'sent_history_captured', sent_ok,
    'inbox_only_boundary', NOT sent_ok
  );
END $$;

CREATE OR REPLACE FUNCTION public.trg_bump_mail_job_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.kind='job' AND NEW.lifecycle='current' THEN
    BEGIN
      PERFORM public.bump_job_mail_capture(NEW.org_id, NEW.target_id::uuid, 'captured');
    EXCEPTION WHEN invalid_text_representation THEN NULL;
    END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bump_mail_job_link ON public.message_work_links;
CREATE TRIGGER trg_bump_mail_job_link
  AFTER INSERT OR UPDATE ON public.message_work_links
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_mail_job_link();

CREATE OR REPLACE FUNCTION public.open_message_attachment(
  p_org_id uuid, p_event_id uuid, p_store text, p_object_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE link public.context_mail_attachment_links; file_name text; storage_url text;
BEGIN
  IF NOT public.message_event_in_org(p_org_id, p_event_id)
  THEN RAISE EXCEPTION 'message_link_org_mismatch'; END IF;
  SELECT l.* INTO link
    FROM public.context_mail_attachment_links l
    JOIN public.context_mail_occurrences o ON o.id=l.occurrence_id
   WHERE o.event_id=p_event_id AND l.org_id=p_org_id AND l.store=p_store AND l.object_id=p_object_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_scope_mismatch'; END IF;
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.message_work_links w
       WHERE w.event_id=p_event_id AND w.org_id=p_org_id AND w.kind='job'
         AND w.target_id=link.job_id::text AND w.lifecycle='current'
    ) OR EXISTS (
      SELECT 1 FROM public.message_work_links w
      JOIN public.purchase_orders po ON po.id::text=w.target_id AND po.org_id=p_org_id
       WHERE w.event_id=p_event_id AND w.org_id=p_org_id AND w.kind='po'
         AND w.lifecycle='current' AND po.job_id=link.job_id
    )
  ) THEN RAISE EXCEPTION 'message_attachment_scope_mismatch'; END IF;
  IF p_store='job_documents' THEN
    SELECT d.file_name, d.storage_url INTO file_name, storage_url
      FROM public.job_documents d JOIN public.jobs j ON j.id=d.job_id
     WHERE d.id=p_object_id AND j.org_id=p_org_id AND d.job_id=link.job_id;
  ELSE
    SELECT NULL, NULL INTO file_name, storage_url
      FROM public.job_media m JOIN public.jobs j ON j.id=m.job_id
     WHERE m.id=p_object_id AND j.org_id=p_org_id AND m.job_id=link.job_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_scope_mismatch'; END IF;
  RETURN jsonb_build_object(
    'allowed',true,'store',p_store,'object_id',p_object_id,'job_id',link.job_id,
    'file_name',file_name,'org_id',p_org_id);
END $$;

REVOKE ALL ON FUNCTION public.bump_job_mail_capture(uuid,uuid,text),
 public.mark_mail_capture_status(uuid,uuid,text,text),
 public.list_job_communications(uuid,uuid,uuid,text),
 public.trg_bump_mail_job_link() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bump_job_mail_capture(uuid,uuid,text),
 public.mark_mail_capture_status(uuid,uuid,text,text),
 public.list_job_communications(uuid,uuid,uuid,text) TO service_role;
