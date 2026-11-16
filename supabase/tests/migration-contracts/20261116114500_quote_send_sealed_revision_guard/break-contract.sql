-- Drop the append-only guard: the contract must notice a miss row can be
-- changed.
DROP TRIGGER trg_quote_send_sealed_revision_misses_append_only ON public.quote_send_sealed_revision_misses;
