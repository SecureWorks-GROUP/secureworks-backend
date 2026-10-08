-- Deliberately put back the store's earlier call rule (a transcript is the customer's only on a
-- call row on its job): the customer's own transcribe-call transcript reads unknown again.
-- contract.sql must fail on it.
CREATE OR REPLACE FUNCTION public.context_ledger_call_customer(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN e.event_type OPERATOR(pg_catalog.=) 'call.transcript_completed' THEN
  (SELECT pg_catalog.bool_or(coalesce(c.metadata OPERATOR(pg_catalog.#>>) '{party_roles,counterpart_role}' OPERATOR(pg_catalog.=) 'customer'
     AND c.metadata OPERATOR(pg_catalog.#>>) '{party_roles,basis}' OPERATOR(pg_catalog.=) 'job_customer', false))
   FROM public.business_events c
   WHERE c.job_id OPERATOR(pg_catalog.=) e.job_id
    AND c.event_type OPERATOR(pg_catalog.<>) 'call.transcript_completed'
    AND c.provider_message_id OPERATOR(pg_catalog.=) ('ghl:' OPERATOR(pg_catalog.||) coalesce(e.payload OPERATOR(pg_catalog.->>) 'ghl_call_id',
     CASE WHEN e.provider_message_id OPERATOR(pg_catalog.~~) 'ghltx:%' THEN pg_catalog.substr(e.provider_message_id, 7) END))) END
$$;
