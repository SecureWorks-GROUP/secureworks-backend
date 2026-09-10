-- Deliberately remove the new promise; the behavioural contract must catch it.
ALTER TABLE public.ai_proposed_actions DROP CONSTRAINT ai_proposed_actions_status_check;
ALTER TABLE public.ai_proposed_actions ADD CONSTRAINT ai_proposed_actions_status_check
  CHECK (status IN ('pending','auto_approved','approved','rejected','expired'));
