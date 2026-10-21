-- Drop the check: the contract must then fail on the unnamed sighting.
ALTER TABLE public.purchase_orders DROP CONSTRAINT purchase_orders_delivery_sighted_named;
