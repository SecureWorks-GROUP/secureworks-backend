-- Logical mail identity versus mailbox occurrence. One logical source, many occurrences.

ALTER TABLE public.context_mail_observations
 ADD COLUMN IF NOT EXISTS logical_message_id text;
CREATE UNIQUE INDEX IF NOT EXISTS context_mail_observations_logical_occ
 ON public.context_mail_observations(logical_message_id, stream_key, provider_item_id);

CREATE TABLE IF NOT EXISTS public.context_mail_logical_sources (
 logical_message_id text PRIMARY KEY,
 event_id uuid NOT NULL REFERENCES public.business_events(id)
);
ALTER TABLE public.context_mail_logical_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_mail_logical_sources FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.context_mail_logical_sources TO service_role;

CREATE OR REPLACE FUNCTION public.record_context_mail_occurrence(
 p_logical_message_id text, p_stream_key text, p_provider_item_id text, p_direction text, p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE existing uuid; outcome text:='existing_logical';
BEGIN
 IF NOT public.automation_lane_enabled('capture') THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF p_logical_message_id IS NULL OR btrim(p_logical_message_id)='' OR p_stream_key IS NULL OR p_provider_item_id IS NULL
  OR p_direction NOT IN ('inbound','outbound') OR p_event_id IS NULL
 THEN RAISE EXCEPTION 'mail_occurrence_invalid'; END IF;
 SELECT event_id INTO existing FROM public.context_mail_logical_sources WHERE logical_message_id=p_logical_message_id;
 IF existing IS NULL THEN
  INSERT INTO public.context_mail_logical_sources(logical_message_id,event_id) VALUES(p_logical_message_id,p_event_id);
  existing:=p_event_id;
  outcome:='new_logical';
 ELSIF existing IS DISTINCT FROM p_event_id THEN
  RAISE EXCEPTION 'mail_logical_source_conflict';
 END IF;
 INSERT INTO public.context_mail_observations(event_id,stream_key,provider_item_id,direction,logical_message_id)
  VALUES(existing,p_stream_key,p_provider_item_id,p_direction,p_logical_message_id)
  ON CONFLICT (stream_key,provider_item_id) DO NOTHING;
 RETURN jsonb_build_object('outcome',outcome,'event_id',existing,'logical_message_id',p_logical_message_id);
END $$;
REVOKE ALL ON FUNCTION public.record_context_mail_occurrence(text,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_context_mail_occurrence(text,text,text,text,uuid) TO service_role;
