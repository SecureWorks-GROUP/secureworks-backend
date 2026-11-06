-- Fail closed: an object of the same name that is not this migration's definition is never replaced.
CREATE VIEW public.v_job_profit_division_months AS SELECT 'SW - PATIOS'::text AS division, 1::numeric AS amount_ex;
