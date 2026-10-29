-- Break: the card's read passes one of CFO's amounts through. The contract
-- must catch it.
ALTER FUNCTION public.context_job_bill_outcomes(uuid) RENAME TO context_job_bill_outcomes_clean;
CREATE FUNCTION public.context_job_bill_outcomes(p_job uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_set(public.context_job_bill_outcomes_clean(p_job), '{bills}',
           COALESCE((SELECT jsonb_agg(e || jsonb_build_object('bill_ex', 10))
                       FROM jsonb_array_elements(public.context_job_bill_outcomes_clean(p_job) -> 'bills') e), '[]'::jsonb))
$$;
GRANT EXECUTE ON FUNCTION public.context_job_bill_outcomes(uuid) TO service_role;
