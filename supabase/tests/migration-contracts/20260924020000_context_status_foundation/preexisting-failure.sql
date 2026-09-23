-- Every object F1 replaces has drifted from production's pre-image (a
-- hand-applied change nobody read), and a new F1 function name is already
-- taken by a different body. The guard must stop before replacing anything and
-- name every one of them.
CREATE OR REPLACE FUNCTION public.context_pipeline_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '{"drift":true}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.persist_luna_context_revision(
 p_run_id uuid,p_lease_token uuid,p_job_id uuid,p_events jsonb,p_new jsonb,p_supersedes jsonb,p_retracts jsonb,
 p_extractor_version text DEFAULT 'luna_v2',p_tokens_in integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT '{"drift":true}'::jsonb $$;
ALTER TABLE public.business_events DROP CONSTRAINT business_events_attribution_status_check;
ALTER TABLE public.business_events ADD CONSTRAINT business_events_attribution_status_check
 CHECK (attribution_status IN ('direct','thread','single_open','single_line','luna','admin_bucket','pending_luna','empty','automated','hand_added'));
DO $$
BEGIN
 EXECUTE 'CREATE OR REPLACE VIEW public.current_job_context_facts WITH (security_invoker=true) AS '
  ||rtrim(pg_get_viewdef('public.current_job_context_facts'::regclass),'; '||chr(10))||' AND visible.kind IS NOT NULL';
END $$;
CREATE FUNCTION public.context_linked_status(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT true $$;
