-- Remove the outbox's append-only guard: the contract must notice that a
-- captured message (what the owner stamped) could then be readdressed.
DROP TRIGGER quote_v2_outbox_append_only ON public.quote_v2_outbox;
