-- A live change nobody read: the history tick replaced by another body. The
-- guard must refuse and name it.
CREATE OR REPLACE FUNCTION public.trigger_context_email_history() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END $$;
