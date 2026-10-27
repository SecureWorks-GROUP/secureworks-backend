-- Break: a list that drops the invoice band must fail the contract.
CREATE OR REPLACE FUNCTION public.context_recon_invoice_decision_state(p_invoice uuid)
RETURNS TABLE (decision_id bigint, action text, job_ids uuid[], escalate_to text, state text)
LANGUAGE sql STABLE AS $$ SELECT NULL::bigint, 'correct'::text, '{}'::uuid[], NULL::text, 'decided'::text $$;
