-- Revert matching function code first. Preserve plans, stage events, evidence
-- and child draft records. Remove producers without deleting money history.
DROP TRIGGER IF EXISTS scope_payment_on_acceptance ON public.scope_job_draft_sets;
DROP TRIGGER IF EXISTS scope_payment_on_install ON public.job_assignments;
DROP FUNCTION IF EXISTS public.scope_payment_acceptance_event();
DROP FUNCTION IF EXISTS public.scope_payment_install_event();
DROP FUNCTION IF EXISTS public.confirm_scope_payment_stage(uuid,uuid,uuid,uuid,text,text,text);
DROP FUNCTION IF EXISTS public.consume_scope_council_payment_event(uuid,text);
DROP FUNCTION IF EXISTS public.read_scope_payment_stages(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.record_scope_payment_signal(uuid,text,jsonb,timestamptz);
DROP FUNCTION IF EXISTS public.apply_scope_payment_event(uuid,text,jsonb,timestamptz,text);
DROP FUNCTION IF EXISTS public.scope_payment_plan(uuid);
