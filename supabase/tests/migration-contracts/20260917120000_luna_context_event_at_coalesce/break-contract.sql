-- Restore the event_at-only attribution gate so the coalesce contract fails.
CREATE OR REPLACE FUNCTION public.persist_luna_context_revision(
 p_run_id uuid,p_lease_token uuid,p_job_id uuid,p_events jsonb,p_new jsonb,p_supersedes jsonb,p_retracts jsonb,
 p_extractor_version text DEFAULT 'luna_v2',p_tokens_in integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'luna_source_attribution_rejected';
END $$;
