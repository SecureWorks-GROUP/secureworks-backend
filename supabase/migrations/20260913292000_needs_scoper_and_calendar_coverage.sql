-- Sales-week support: calendar coverage identity and Needs Scoper loop.
-- Reuses Perth quiet hours from manual dispatch. Fake transport only here.
-- Not a new automation platform. Live SMS stays gated.

CREATE TABLE IF NOT EXISTS public.calendar_source_coverage (
  org_id uuid NOT NULL,
  owner_key text NOT NULL,
  calendar_id text NOT NULL,
  last_check_at timestamptz,
  coverage_status text NOT NULL CHECK (coverage_status IN ('captured','unread','not_read','error')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, owner_key, calendar_id)
);
ALTER TABLE public.calendar_source_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calendar_source_coverage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.calendar_source_coverage TO service_role;

CREATE TABLE IF NOT EXISTS public.needs_scoper_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  owner_key text NOT NULL,
  contact_id text,
  job_id text,
  opportunity_id text,
  conversation_id text NOT NULL,
  channel text NOT NULL DEFAULT 'ghl',
  question text NOT NULL,
  question_hash text NOT NULL,
  context text,
  dash_link text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  answer text,
  proposed_client_reply text,
  client_send_approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  answered_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS needs_scoper_open_dedupe
  ON public.needs_scoper_items(org_id, owner_key, conversation_id, question_hash)
  WHERE status='open';
ALTER TABLE public.needs_scoper_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.needs_scoper_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.needs_scoper_items TO service_role;

CREATE TABLE IF NOT EXISTS public.staff_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.needs_scoper_items(id),
  org_id uuid NOT NULL,
  from_number text NOT NULL,
  to_owner_key text NOT NULL,
  body text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('fake')),
  status text NOT NULL CHECK (status IN ('pending','sent','error','suppressed_quiet','duplicate')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.staff_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_notification_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.staff_notification_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.record_calendar_coverage(
  p_org_id uuid, p_owner_key text, p_calendar_id text,
  p_last_check_at timestamptz, p_status text, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org_id IS NULL OR nullif(btrim(p_owner_key),'') IS NULL OR nullif(btrim(p_calendar_id),'') IS NULL
     OR p_status NOT IN ('captured','unread','not_read','error')
  THEN RAISE EXCEPTION 'calendar_coverage_invalid'; END IF;
  INSERT INTO public.calendar_source_coverage(org_id,owner_key,calendar_id,last_check_at,coverage_status,last_error)
  VALUES (p_org_id,p_owner_key,p_calendar_id,p_last_check_at,p_status,p_error)
  ON CONFLICT (org_id,owner_key,calendar_id) DO UPDATE
    SET last_check_at=EXCLUDED.last_check_at,
        coverage_status=EXCLUDED.coverage_status,
        last_error=EXCLUDED.last_error,
        updated_at=now();
  RETURN jsonb_build_object(
    'ok',true,'owner_key',p_owner_key,'calendar_id',p_calendar_id,
    'coverage_status',p_status,'treat_as_free', false
  );
END $$;

CREATE OR REPLACE FUNCTION public.read_calendar_coverage(p_org_id uuid, p_owner_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'owner_key', p_owner_key,
    'calendars', coalesce(jsonb_agg(jsonb_build_object(
      'calendar_id', c.calendar_id,
      'last_check_at', c.last_check_at,
      'coverage_status', c.coverage_status,
      'treat_as_free', false
    ) ORDER BY c.calendar_id), '[]'::jsonb),
    'any_unread_or_not_read', EXISTS (
      SELECT 1 FROM public.calendar_source_coverage x
       WHERE x.org_id=p_org_id AND x.owner_key=p_owner_key
         AND x.coverage_status IN ('unread','not_read','error')
    )
  )
  FROM public.calendar_source_coverage c
  WHERE c.org_id=p_org_id AND c.owner_key=p_owner_key;
$$;

CREATE OR REPLACE FUNCTION public.open_needs_scoper_item(
  p_org_id uuid, p_owner_key text, p_contact_id text, p_job_id text,
  p_opportunity_id text, p_conversation_id text, p_channel text,
  p_question text, p_context text, p_dash_link text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h text; existing public.needs_scoper_items; created public.needs_scoper_items;
BEGIN
  IF p_org_id IS NULL OR nullif(btrim(p_owner_key),'') IS NULL
     OR nullif(btrim(p_conversation_id),'') IS NULL
     OR nullif(btrim(p_question),'') IS NULL
     OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'needs_scoper_invalid'; END IF;
  h := md5(lower(btrim(p_question)));
  SELECT * INTO existing FROM public.needs_scoper_items
   WHERE org_id=p_org_id AND owner_key=p_owner_key
     AND conversation_id=p_conversation_id AND question_hash=h AND status='open';
  IF FOUND THEN
    RETURN jsonb_build_object('outcome','existing','id',existing.id,'status',existing.status);
  END IF;
  INSERT INTO public.needs_scoper_items(
    org_id,owner_key,contact_id,job_id,opportunity_id,conversation_id,channel,
    question,question_hash,context,dash_link)
  VALUES (
    p_org_id,p_owner_key,p_contact_id,p_job_id,p_opportunity_id,p_conversation_id,
    coalesce(nullif(p_channel,''),'ghl'), p_question, h, p_context, p_dash_link)
  RETURNING * INTO created;
  RETURN jsonb_build_object('outcome','opened','id',created.id,'status',created.status,
    'dash_link',created.dash_link,'client_send_approved',created.client_send_approved);
END $$;

CREATE OR REPLACE FUNCTION public.notify_needs_scoper(
  p_item_id uuid, p_org_id uuid, p_from_number text, p_body text, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item public.needs_scoper_items; perth_hour int; out_id uuid; st text;
BEGIN
  IF p_item_id IS NULL OR p_org_id IS NULL OR nullif(btrim(p_from_number),'') IS NULL
     OR nullif(btrim(p_body),'') IS NULL
  THEN RAISE EXCEPTION 'needs_scoper_invalid'; END IF;
  SELECT * INTO item FROM public.needs_scoper_items
   WHERE id=p_item_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'needs_scoper_missing'; END IF;
  IF item.status IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'needs_scoper_not_open'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.staff_notification_outbox n
     WHERE n.item_id=p_item_id AND n.status='sent'
  ) THEN
    INSERT INTO public.staff_notification_outbox(item_id,org_id,from_number,to_owner_key,body,transport,status)
    VALUES (p_item_id,p_org_id,p_from_number,item.owner_key,p_body,'fake','duplicate')
    RETURNING id INTO out_id;
    RETURN jsonb_build_object('ok',true,'status','duplicate','outbox_id',out_id,'live_send',false);
  END IF;
  perth_hour := extract(hour FROM timezone('Australia/Perth', coalesce(p_now, now())))::int;
  IF perth_hour < 7 OR perth_hour >= 20 THEN
    INSERT INTO public.staff_notification_outbox(item_id,org_id,from_number,to_owner_key,body,transport,status,error)
    VALUES (p_item_id,p_org_id,p_from_number,item.owner_key,p_body,'fake','suppressed_quiet','quiet_hours')
    RETURNING id INTO out_id;
    RETURN jsonb_build_object('ok',true,'status','suppressed_quiet','outbox_id',out_id,'live_send',false);
  END IF;
  INSERT INTO public.staff_notification_outbox(item_id,org_id,from_number,to_owner_key,body,transport,status)
  VALUES (p_item_id,p_org_id,p_from_number,item.owner_key,p_body,'fake','sent')
  RETURNING id INTO out_id;
  RETURN jsonb_build_object('ok',true,'status','sent','outbox_id',out_id,'live_send',false,'transport','fake');
END $$;

CREATE OR REPLACE FUNCTION public.answer_needs_scoper(
  p_item_id uuid, p_org_id uuid, p_answer text, p_proposed_client_reply text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item public.needs_scoper_items;
BEGIN
  IF nullif(btrim(p_answer),'') IS NULL OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'needs_scoper_invalid'; END IF;
  UPDATE public.needs_scoper_items
     SET status='answered', answer=p_answer,
         proposed_client_reply=p_proposed_client_reply,
         client_send_approved=false,
         answered_at=now(), answered_by=p_actor
   WHERE id=p_item_id AND org_id=p_org_id AND status='open'
   RETURNING * INTO item;
  IF NOT FOUND THEN RAISE EXCEPTION 'needs_scoper_not_open'; END IF;
  RETURN jsonb_build_object(
    'ok',true,'id',item.id,'status',item.status,
    'client_send_approved', false,
    'auto_forwarded_to_client', false
  );
END $$;

REVOKE ALL ON FUNCTION public.record_calendar_coverage(uuid,text,text,timestamptz,text,text),
 public.read_calendar_coverage(uuid,text),
 public.open_needs_scoper_item(uuid,text,text,text,text,text,text,text,text,text,text),
 public.notify_needs_scoper(uuid,uuid,text,text,timestamptz),
 public.answer_needs_scoper(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_calendar_coverage(uuid,text,text,timestamptz,text,text),
 public.read_calendar_coverage(uuid,text),
 public.open_needs_scoper_item(uuid,text,text,text,text,text,text,text,text,text,text),
 public.notify_needs_scoper(uuid,uuid,text,text,timestamptz),
 public.answer_needs_scoper(uuid,uuid,text,text,text) TO service_role;
