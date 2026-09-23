-- Ship the item flag failing OPEN: a missing flag row reads as on. The
-- contract's "missing flag must read off" (and the flag-off, no-alarm and
-- no-post checks) must catch it.
CREATE OR REPLACE FUNCTION public.context_ghl_item_flag() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN jsonb_build_object('enabled',true,'updated_at',NULL,'state','missing');
END $$;
