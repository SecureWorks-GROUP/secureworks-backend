-- A live change nobody read: the history flag already present (it would be
-- inherited, possibly on) and the poll caller replaced by another body. The
-- guard must refuse and name both.
INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('email_reader_history_v1',true,'preexisting');
CREATE OR REPLACE FUNCTION public.trigger_context_email_poll() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN; END $$;
