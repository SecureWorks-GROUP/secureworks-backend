-- Remove the one-work-order-per-version rule; the contract must then fail on the second insert.
DROP INDEX public.ux_work_orders_quote_builder_version;
