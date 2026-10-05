-- Live changes nobody read: the admission already replaced by another body,
-- and the runs phase list already widened another way. The guard must refuse
-- and name both before touching anything.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN jsonb_build_object('outcome','paused'); END $$;
ALTER TABLE public.context_extraction_runs DROP CONSTRAINT context_extraction_runs_phase_check;
ALTER TABLE public.context_extraction_runs ADD CONSTRAINT context_extraction_runs_phase_check
 CHECK (phase IN ('attribution','extraction','bucket','summary'));
