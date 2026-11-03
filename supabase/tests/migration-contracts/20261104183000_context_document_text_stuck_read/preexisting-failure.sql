-- A writer body that is not production's pre-image (someone changed it since 3 Nov 2026 18:32Z): the
-- migration must refuse and name it rather than overwrite it.
CREATE OR REPLACE FUNCTION public.record_context_document_text(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'document_text_invalid'; END $$;
