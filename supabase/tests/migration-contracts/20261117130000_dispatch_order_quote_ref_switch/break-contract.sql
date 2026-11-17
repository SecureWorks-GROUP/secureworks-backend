-- Deliberately seed the switch on: the contract must fail.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'dispatch_order_quote_ref_line_v1';
