-- Ship the flag failing OPEN: a missing flag row reads as on. The contract's
-- "missing flag must read off" check must catch it.
CREATE OR REPLACE FUNCTION public.context_document_text_flag() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN jsonb_build_object('enabled',true,'updated_at',NULL,'state','missing');
END $$;
