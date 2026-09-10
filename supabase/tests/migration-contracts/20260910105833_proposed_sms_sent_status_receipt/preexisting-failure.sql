-- Do not silently replace an unexpected status policy or erase its values.
ALTER TABLE public.ai_proposed_actions DROP CONSTRAINT ai_proposed_actions_status_check;
ALTER TABLE public.ai_proposed_actions ADD CONSTRAINT ai_proposed_actions_status_check
  CHECK (status IN ('pending','auto_approved','approved','rejected','expired','paused'));
UPDATE public.ai_proposed_actions SET status = 'paused';
