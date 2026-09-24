-- Remove the frozen-line guard: the contract must notice that a line on a
-- frozen quote (what a party was shown and accepted) could then be edited.
DROP TRIGGER quote_v2_lines_frozen_guard ON public.quote_v2_lines;
