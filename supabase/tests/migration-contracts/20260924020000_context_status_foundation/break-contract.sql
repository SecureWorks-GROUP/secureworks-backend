-- Ship the composer in the literal {core, ...} shape instead: today's keys
-- move under "core", so every existing reader loses them. The named-row
-- contract (existing keys identical) must catch it.
CREATE OR REPLACE FUNCTION public.context_pipeline_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('core',public.context_core_status(),'cadence',public.context_cadence_status(),
  'capture_sources',public.context_source_freshness(),'ghl_capture',public.context_ghl_capture_status(),
  'booking_capture',public.context_booking_capture_status(),'parties',public.context_parties_status(),'alarms','[]'::jsonb)
$$;
