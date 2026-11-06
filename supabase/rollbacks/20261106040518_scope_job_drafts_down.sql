-- Revert the matching function code first. Keep every local draft and its
-- work order; this undo removes behaviour, never historical job records.
DROP TRIGGER IF EXISTS trg_scope_draft_work_order ON public.work_orders;
DROP FUNCTION IF EXISTS public.guard_scope_draft_work_order();
DROP FUNCTION IF EXISTS public.prepare_scope_job_drafts(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.read_scope_job_drafts(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.release_scope_job_drafts(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.scope_draft_cents(jsonb);
-- Both tables deliberately remain private and retain their grants/RLS.
