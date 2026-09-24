-- Remove the promise: the history writer no longer insists on capture_mode
-- backfill, so a live row could be written through the history door and wake
-- reads it should not.
CREATE OR REPLACE FUNCTION public.capture_ghl_history_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_row->>'source' IS DISTINCT FROM 'ghl-history-load' THEN RETURN jsonb_build_object('outcome','error','code','history_row_source_invalid'); END IF;
 IF nullif(p_row->>'job_id','') IS NOT NULL OR coalesce(nullif(p_row->>'match_method',''),'none')<>'none' THEN RETURN jsonb_build_object('outcome','error','code','history_row_job_refused'); END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','error','code','attribution_disabled'); END IF;
 RETURN public.capture_business_event(p_row);
END $$;
