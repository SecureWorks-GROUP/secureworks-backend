-- Remove the promised behaviour: without the index the marker read scans the no-job rows again (only the old
-- business_events_context_bucket index is left), so the contract's plan check must fail.
DROP INDEX public.business_events_pending_luna_marker;
