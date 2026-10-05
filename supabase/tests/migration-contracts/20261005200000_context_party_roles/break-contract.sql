-- Ship the classifier without the trigger: message rows are captured with no
-- sender or recipient role. The contract must catch it.
DROP TRIGGER context_party_roles_business_event ON public.business_events;
