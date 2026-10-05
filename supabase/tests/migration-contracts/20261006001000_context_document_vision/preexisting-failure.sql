-- Live changes nobody read: the reservation admission already replaced by
-- some other body, and the reservation phase check already widened another
-- way. The guard must refuse and name both.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RETURN jsonb_build_object('outcome','paused'); END $$;
ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT context_model_call_reservations_phase_check;
ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
 CHECK (phase IN ('attribution','extraction','bucket','ocr'));
