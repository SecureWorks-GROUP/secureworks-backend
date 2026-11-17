CREATE OR REPLACE FUNCTION public.job_cost_lines_set_state(
 p_line_id uuid,p_state text,p_parts jsonb,p_decided_by_kind text,p_decision_id bigint,p_needs_reason text)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM public.job_cost_lines_write_state(p_line_id,p_state,p_parts,p_decided_by_kind,p_decision_id,p_needs_reason);
END $$;
