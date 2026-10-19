-- Drop the one-set key: the contract must then fail on the second row with the same seq.
DROP INDEX public.uq_purchase_orders_quote_builder_version_seq;
