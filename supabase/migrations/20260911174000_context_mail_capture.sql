-- B5 durable capture checkpoints. Apply before monitor-inbox; no cron/provider writes.
CREATE TABLE public.context_mail_streams (
 stream_key text PRIMARY KEY, mailbox text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('user','group')),
 folder text NOT NULL CHECK(folder IN ('inbox','sentitems','conversations')),
 enabled boolean NOT NULL DEFAULT true, unavailable_reason text,
 capture_from timestamptz NOT NULL DEFAULT now(), state jsonb NOT NULL DEFAULT '{}',
 lease_token uuid, lease_expires_at timestamptz,
 last_started_at timestamptz,last_completed_at timestamptz,last_error text,
 pages bigint NOT NULL DEFAULT 0 CHECK(pages>=0), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(mailbox,folder)
);
ALTER TABLE public.context_mail_streams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_mail_streams FROM PUBLIC,anon,authenticated;
GRANT SELECT,UPDATE ON public.context_mail_streams TO service_role;
INSERT INTO public.context_mail_streams(stream_key,mailbox,kind,folder,enabled,unavailable_reason)
 SELECT localpart||':'||folder,localpart||'@secureworkswa.com.au','user',folder,localpart<>'khairo',
 CASE WHEN localpart='khairo' THEN 'mailbox_not_provisioned' END
 FROM unnest(ARRAY['marnin','jan','shaun','admin','nithin','khairo','orders']) localpart
 CROSS JOIN unnest(ARRAY['inbox','sentitems']) folder;
INSERT INTO public.context_mail_streams(stream_key,mailbox,kind,folder)
 SELECT localpart||':conversations',localpart||'@secureworkswa.com.au','group','conversations'
 FROM unnest(ARRAY['patios','fencing','ses']) localpart;
-- orders is an explicit attempted user mailbox, never asserted provisioned. Existing PO
-- Resend webhook continues separately; 404/403 remains a visible coverage failure.
CREATE TABLE public.context_mail_observations (
 event_id uuid NOT NULL REFERENCES public.business_events(id),
 stream_key text NOT NULL REFERENCES public.context_mail_streams(stream_key),
 provider_item_id text NOT NULL,direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 captured_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(stream_key,provider_item_id)
);
ALTER TABLE public.context_mail_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_mail_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.context_mail_observations TO service_role;
CREATE FUNCTION public.claim_context_mail_stream(p_stream_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_mail_streams;
BEGIN
 IF NOT public.automation_lane_enabled('capture') THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 SELECT * INTO r FROM public.context_mail_streams WHERE stream_key=p_stream_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown mail stream'; END IF;
 IF NOT r.enabled THEN RETURN jsonb_build_object('outcome','unavailable','reason',r.unavailable_reason); END IF;
 IF r.lease_expires_at>clock_timestamp() THEN RETURN jsonb_build_object('outcome','busy'); END IF;
 UPDATE public.context_mail_streams SET lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '10 minutes',last_started_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE stream_key=p_stream_key RETURNING * INTO r;
 RETURN jsonb_build_object('outcome','claimed','stream',to_jsonb(r));
END $$;
CREATE FUNCTION public.checkpoint_context_mail_stream(p_stream_key text,p_lease_token uuid,p_state jsonb,p_complete boolean,p_error text DEFAULT NULL,p_release boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.automation_lane_enabled('capture') THEN RETURN false; END IF;
 IF p_state IS NULL OR jsonb_typeof(p_state)<>'object' THEN RAISE EXCEPTION 'Invalid mail cursor'; END IF;
 UPDATE public.context_mail_streams SET state=p_state,
  last_completed_at=CASE WHEN p_complete THEN clock_timestamp() ELSE last_completed_at END,
  last_error=p_error,pages=pages+CASE WHEN p_error IS NULL AND NOT p_release THEN 1 ELSE 0 END,
  lease_expires_at=CASE WHEN p_complete OR p_release THEN NULL ELSE clock_timestamp()+interval '10 minutes' END,
  lease_token=CASE WHEN p_complete OR p_release THEN NULL ELSE lease_token END,updated_at=clock_timestamp()
 WHERE stream_key=p_stream_key AND lease_token=p_lease_token AND lease_expires_at>clock_timestamp();
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.claim_context_mail_stream(text),public.checkpoint_context_mail_stream(text,uuid,jsonb,boolean,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_context_mail_stream(text),public.checkpoint_context_mail_stream(text,uuid,jsonb,boolean,text,boolean) TO service_role;
-- Dedicated new private bucket. Never flip an existing bucket's visibility.
INSERT INTO storage.buckets(id,name,public) VALUES('context-mail-evidence','context-mail-evidence',false) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM storage.buckets WHERE id='context-mail-evidence' AND public) THEN RAISE EXCEPTION 'context-mail-evidence must already be private'; END IF; END $$;
