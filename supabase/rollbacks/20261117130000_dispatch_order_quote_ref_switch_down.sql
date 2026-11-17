-- Rollback of 20261117130000_dispatch_order_quote_ref_switch: removes the
-- switch row. ops-api reads a missing row as off, so the order email goes back
-- to the body it had before the line existed. No other row is touched.
DELETE FROM public.feature_flags WHERE flag_name = 'dispatch_order_quote_ref_line_v1';
