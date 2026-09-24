-- The writer the history load builds on is not the body read from production:
-- the migration must refuse rather than build on an unread contract.
CREATE OR REPLACE FUNCTION public.capture_business_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN jsonb_build_object('outcome','inserted','attribution_status','pending_luna'); END $$;
-- And a trigger on jobs nobody has read.
CREATE FUNCTION public.m4_unread_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER m4_unread_trigger BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.m4_unread_trigger();
