CREATE OR REPLACE FUNCTION public.job_cost_lines_sync_trade_invoice(p_trade_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN RETURN jsonb_build_object('ran',false); END;
$$;
