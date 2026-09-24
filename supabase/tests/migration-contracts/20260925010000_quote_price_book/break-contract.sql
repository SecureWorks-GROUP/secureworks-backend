-- Remove the append-only guard on costs: the contract must notice that a
-- recorded price can then be overwritten.
DROP TRIGGER price_book_costs_append_only ON public.price_book_costs;
