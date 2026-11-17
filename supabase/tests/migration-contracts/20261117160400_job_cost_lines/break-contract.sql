-- Remove the part-write guard. A committed short allocation must be detected.
DROP TRIGGER job_cost_line_parts_conserve ON public.job_cost_line_parts;
