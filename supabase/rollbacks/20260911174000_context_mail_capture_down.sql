-- Disable capture without deleting checkpoints or private evidence.
UPDATE public.context_mail_streams SET enabled=false,unavailable_reason='b5_rolled_back',lease_token=NULL,lease_expires_at=NULL;
DROP FUNCTION public.checkpoint_context_mail_stream(text,uuid,jsonb,boolean,text,boolean);
DROP FUNCTION public.claim_context_mail_stream(text);
