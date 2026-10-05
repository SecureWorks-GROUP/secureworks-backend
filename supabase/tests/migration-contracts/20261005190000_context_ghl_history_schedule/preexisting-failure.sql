-- The reservation this slice replaces is not the body it was built on: the
-- migration must refuse rather than overwrite a live change nobody read.
CREATE OR REPLACE FUNCTION public.reserve_ghl_history_run(p_max_jobs integer, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN jsonb_build_object('outcome','run_in_progress','run_id',gen_random_uuid()); END $$;
