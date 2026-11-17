-- Deliberately remove job events, leaving PO events intact.
CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS
 SELECT g.*,NULL::uuid cost_line_id,NULL::text cost_kind FROM public.v_job_cost_events_legacy g WHERE false;
