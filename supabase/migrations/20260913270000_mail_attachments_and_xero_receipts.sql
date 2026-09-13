-- Link mail occurrences to existing job_documents/job_media. Object ACL on open.
-- Durable Xero open-receivable reconcile receipts. No new attachment store.

CREATE TABLE IF NOT EXISTS public.context_mail_attachment_links (
  occurrence_id uuid NOT NULL REFERENCES public.context_mail_occurrences(id),
  org_id uuid NOT NULL,
  store text NOT NULL CHECK (store IN ('job_documents','job_media')),
  object_id uuid NOT NULL,
  job_id uuid,
  file_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occurrence_id, store, object_id)
);
ALTER TABLE public.context_mail_attachment_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_mail_attachment_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.context_mail_attachment_links TO service_role;

CREATE OR REPLACE FUNCTION public.link_context_mail_attachment(
  p_org_id uuid, p_event_id uuid, p_store text, p_object_id uuid, p_job_id uuid, p_file_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE occ public.context_mail_occurrences;
BEGIN
  IF p_store NOT IN ('job_documents','job_media') OR p_org_id IS NULL OR p_event_id IS NULL OR p_object_id IS NULL
  THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
  IF NOT public.message_event_in_org(p_org_id, p_event_id)
  THEN RAISE EXCEPTION 'message_link_org_mismatch'; END IF;
  SELECT * INTO occ FROM public.context_mail_occurrences
   WHERE event_id=p_event_id AND org_id=p_org_id ORDER BY captured_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
  IF p_store='job_documents' AND NOT EXISTS (
    SELECT 1 FROM public.job_documents d JOIN public.jobs j ON j.id=d.job_id
     WHERE d.id=p_object_id AND j.org_id=p_org_id AND d.job_id=p_job_id
  ) THEN RAISE EXCEPTION 'message_attachment_scope_mismatch'; END IF;
  IF p_store='job_media' AND NOT EXISTS (
    SELECT 1 FROM public.job_media m JOIN public.jobs j ON j.id=m.job_id
     WHERE m.id=p_object_id AND j.org_id=p_org_id AND m.job_id=p_job_id
  ) THEN RAISE EXCEPTION 'message_attachment_scope_mismatch'; END IF;
  INSERT INTO public.context_mail_attachment_links(occurrence_id,org_id,store,object_id,job_id,file_name)
   VALUES (occ.id,p_org_id,p_store,p_object_id,p_job_id,p_file_name)
   ON CONFLICT (occurrence_id,store,object_id) DO NOTHING;
  RETURN jsonb_build_object('ok',true,'occurrence_id',occ.id,'object_id',p_object_id,'store',p_store);
END $$;

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
  IF NOT EXISTS (
    SELECT 1 FROM public.message_work_links w
     WHERE w.event_id=p_event_id AND w.org_id=p_org_id AND w.kind='job'
       AND w.target_id=link.job_id::text AND w.lifecycle='current'
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

CREATE OR REPLACE FUNCTION public.read_message_work_links(p_org_id uuid, p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ev jsonb; links jsonb; occ jsonb; atts jsonb;
BEGIN
  IF p_org_id IS NULL OR p_event_id IS NULL THEN RAISE EXCEPTION 'message_link_invalid'; END IF;
  IF NOT public.message_event_in_org(p_org_id, p_event_id)
  THEN RAISE EXCEPTION 'message_link_org_mismatch'; END IF;
  SELECT to_jsonb(e) INTO ev FROM public.business_events e WHERE e.id=p_event_id;
  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.kind, l.target_id),'[]'::jsonb)
    INTO links FROM public.message_work_links l
   WHERE l.event_id=p_event_id AND l.org_id=p_org_id AND l.lifecycle='current';
  SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.captured_at),'[]'::jsonb)
    INTO occ FROM public.context_mail_occurrences o
   WHERE o.event_id=p_event_id AND o.org_id=p_org_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'occurrence_id',a.occurrence_id,'store',a.store,'object_id',a.object_id,
      'job_id',a.job_id,'file_name',a.file_name) ORDER BY a.created_at),'[]'::jsonb)
    INTO atts
    FROM public.context_mail_attachment_links a
    JOIN public.context_mail_occurrences o ON o.id=a.occurrence_id
   WHERE o.event_id=p_event_id AND a.org_id=p_org_id;
  RETURN jsonb_build_object('event',ev,'links',links,'occurrences',occ,'attachments',atts,'org_id',p_org_id);
END $$;

CREATE TABLE IF NOT EXISTS public.xero_open_receivable_reconcile_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  provider_pages integer NOT NULL DEFAULT 0,
  provider_count integer NOT NULL DEFAULT 0,
  provider_cutoff timestamptz,
  attempted integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  traversal_complete boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.xero_open_receivable_reconcile_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.xero_open_receivable_reconcile_runs(id),
  xero_invoice_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('update','insert')),
  ok boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.xero_open_receivable_reconcile_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xero_open_receivable_reconcile_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_open_receivable_reconcile_runs, public.xero_open_receivable_reconcile_items
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.xero_open_receivable_reconcile_runs, public.xero_open_receivable_reconcile_items
  TO service_role;

REVOKE ALL ON FUNCTION public.link_context_mail_attachment(uuid,uuid,text,uuid,uuid,text),
 public.open_message_attachment(uuid,uuid,text,uuid),
 public.read_message_work_links(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.link_context_mail_attachment(uuid,uuid,text,uuid,uuid,text),
 public.open_message_attachment(uuid,uuid,text,uuid),
 public.read_message_work_links(uuid,uuid) TO service_role;
