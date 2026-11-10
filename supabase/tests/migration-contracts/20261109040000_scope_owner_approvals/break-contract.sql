-- Drop the owner decisions from the policy: every bound order reads as
-- approved. The contract must notice that an acceptance with no decisions is
-- no longer held.
CREATE OR REPLACE FUNCTION public.job_work_order_owner_gate(w public.work_orders, p_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('bound', true,
    'revision_id', COALESCE(w.scope_revision_id, w.quote_filled_scope_revision_id),
    'content_hash', COALESCE(p_hash, public.job_work_order_content_hash(w)),
    'missing', '[]'::jsonb);
$$;
