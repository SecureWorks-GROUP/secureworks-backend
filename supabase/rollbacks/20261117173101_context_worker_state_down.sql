-- Remove only these additive reads, preserving the existing integer-only overload.
DROP FUNCTION IF EXISTS public.context_worker_state();
DROP FUNCTION IF EXISTS public.context_attribution_due(text, integer);
DROP INDEX IF EXISTS public.business_events_pending_luna_due;
