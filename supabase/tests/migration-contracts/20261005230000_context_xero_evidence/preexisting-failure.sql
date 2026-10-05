-- A capture_business_event body this migration was not written against: the
-- backfill writes through it, so the migration must refuse to install.
CREATE OR REPLACE FUNCTION public.capture_business_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN jsonb_build_object('outcome','error','code','not_the_reviewed_writer');
END $$;
