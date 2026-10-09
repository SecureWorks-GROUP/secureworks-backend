-- Remove the freeze; the contract must then fail on the issued-version update.
DROP TRIGGER trg_quote_builder_versions_guard ON public.quote_builder_versions;
