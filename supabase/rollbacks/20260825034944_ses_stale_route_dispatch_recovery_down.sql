DROP FUNCTION IF EXISTS public.read_stuck_ses_route_dispatches_v1(uuid[]);
DROP FUNCTION IF EXISTS public.renew_ses_route_dispatch_lease_v1(jsonb, integer);
DROP FUNCTION IF EXISTS public.claim_ses_route_redispatch_v1(jsonb, text, text, integer);
DROP FUNCTION IF EXISTS public.settle_stale_ses_route_dispatch_v1(jsonb, jsonb, text);
DROP FUNCTION IF EXISTS public.inspect_stale_ses_route_dispatch_v1(jsonb);
DROP INDEX IF EXISTS public.idx_ses_route_dispatching_lease;
